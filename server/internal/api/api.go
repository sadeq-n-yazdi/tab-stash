// Package api is the HTTP API of the Tab Stash sync server (docs/backend-api.md).
package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/sadeq-n-yazdi/tab-stash/server/internal/auth"
	"github.com/sadeq-n-yazdi/tab-stash/server/internal/store"
)

// Limits of the API.
const (
	MaxSyncRecords  = 500
	maxLoginBody    = 16 << 10 // 16 KiB
	maxSyncBody     = 16 << 20 // 16 MiB
	maxClientName   = 100
	loginTries      = 5  // for each client address (IPv6: each /64)
	userLoginTries  = 10 // for each user name, from all addresses
	loginWindow     = time.Minute
	hstsHeaderValue = "max-age=31536000; includeSubDomains"
)

// Config holds the settings of the API.
type Config struct {
	// AllowedOrigins are the browser origins that can call the API, for
	// example "chrome-extension://icppdneajfbmmpkgejjpjfegkppmneej".
	// Requests without an Origin header (curl, other servers) are allowed.
	AllowedOrigins []string
	// TokenTTL is the lifetime of an access token.
	TokenTTL time.Duration
	// ClientIPHeader is the request header that holds the client address,
	// for example "X-Real-IP". Set it only when a reverse proxy in front of
	// the server sets this header on each request. For "X-Forwarded-For"
	// the server uses the last entry. If it is empty, the server uses the
	// address of the TCP connection.
	ClientIPHeader string
	// PublicURL is the address of the server for its users, for example
	// "https://tabs.example.com/". It is only shown on the home page.
	PublicURL string
	Logger    *slog.Logger
}

// Server is the HTTP handler.
type Server struct {
	store   *store.Store
	cfg     Config
	origins map[string]bool
	limiter *limiter // login tries for each client address
	users   *limiter // login tries for each user name
	pwTries *limiter // password change tries for each account
	handler http.Handler
}

// New makes the HTTP handler.
func New(st *store.Store, cfg Config) *Server {
	if cfg.TokenTTL == 0 {
		cfg.TokenTTL = 90 * 24 * time.Hour
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	s := &Server{store: st, cfg: cfg, origins: map[string]bool{}, limiter: newLimiter(loginTries, loginWindow),
		users: newLimiter(userLoginTries, loginWindow), pwTries: newLimiter(loginTries, loginWindow)}
	for _, o := range cfg.AllowedOrigins {
		if o = strings.TrimSpace(o); o != "" {
			s.origins[o] = true
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("POST /api/v1/auth/login", s.login)
	mux.Handle("POST /api/v1/auth/logout", s.requireAuth(http.HandlerFunc(s.logout)))
	mux.Handle("POST /api/v1/auth/password", s.requireAuth(http.HandlerFunc(s.changePassword)))
	mux.Handle("GET /api/v1/sync", s.requireRole(store.RoleUser, s.getChanges))
	mux.Handle("POST /api/v1/sync", s.requireRole(store.RoleUser, s.putChanges))
	mux.Handle("GET /api/v1/admin/users", s.requireRole(store.RoleAdmin, s.listUsers))
	mux.Handle("POST /api/v1/admin/users", s.requireRole(store.RoleAdmin, s.createUser))
	mux.Handle("DELETE /api/v1/admin/users/{username}", s.requireRole(store.RoleAdmin, s.deleteUser))
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "This API path does not exist.")
	})
	mux.HandleFunc("/", s.home)

	s.handler = s.recoverer(s.logRequests(s.securityHeaders(s.cors(mux))))
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.handler.ServeHTTP(w, r) }

// ---------- handlers ----------

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) home(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	msg := "Tab Stash sync server. The API is at /api/v1. The web page is not available yet.\n"
	if s.cfg.PublicURL != "" {
		msg += "Server address for the extension: " + s.cfg.PublicURL + "\n"
	}
	_, _ = w.Write([]byte(msg))
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Client   string `json:"client"`
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if !decodeJSON(w, r, maxLoginBody, &req) {
		return
	}
	if req.Username == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "username and password are required.")
		return
	}
	if !store.ValidUsername(req.Username) {
		// No such account can exist. Answer at once, without a try.
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "The user name or the password is not correct.")
		return
	}
	ipKey := limitKey(s.clientIP(r))
	userKey := strings.ToLower(req.Username)
	if !s.limiter.take(ipKey) {
		tooManyTries(w)
		return
	}
	if !s.users.take(userKey) {
		s.limiter.refund(ipKey)
		tooManyTries(w)
		return
	}
	userID, hash, err := s.store.PasswordHash(r.Context(), req.Username)
	ok := false
	switch {
	case errors.Is(err, store.ErrNotFound):
		// Same time and same errors as a real check.
		if err := auth.VerifyDummy(req.Password); err != nil {
			s.internalError(w, r, err)
			return
		}
	case err != nil:
		s.internalError(w, r, err)
		return
	default:
		if ok, err = auth.VerifyPassword(req.Password, hash); err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	if !ok {
		// The tries stay reserved: they count as failures.
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "The user name or the password is not correct.")
		return
	}

	s.limiter.refund(ipKey)
	s.users.refund(userKey)
	if auth.NeedsRehash(hash) {
		if newHash, err := auth.HashPassword(req.Password); err == nil {
			if err := s.store.UpdatePasswordHash(r.Context(), userID, hash, newHash); err != nil {
				s.cfg.Logger.Warn("rehash password", "error", err)
			}
		}
	}

	token, tokenHash, err := auth.NewToken()
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	client := strings.TrimSpace(req.Client)
	if client == "" {
		client = "unknown"
	}
	if r := []rune(client); len(r) > maxClientName {
		client = string(r[:maxClientName])
	}
	expires := time.Now().Add(s.cfg.TokenTTL).UTC()
	if err := s.store.CreateToken(r.Context(), userID, tokenHash, client, expires); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": token, "expiresAt": expires.Format(time.RFC3339)})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteToken(r.Context(), tokenHashFrom(r.Context())); err != nil {
		s.internalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type changesResponse struct {
	Records []json.RawMessage `json:"records"`
	Cursor  int64             `json:"cursor"`
	More    bool              `json:"more"`
}

func (s *Server) getChanges(w http.ResponseWriter, r *http.Request) {
	since := int64(0)
	if v := r.URL.Query().Get("since"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 {
			writeError(w, http.StatusBadRequest, "bad_request", "since must be an integer of 0 or more.")
			return
		}
		since = n
	}
	records, cursor, more, err := s.store.Changes(r.Context(), accountFrom(r.Context()).ID, since, MaxSyncRecords)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, changesResponse{Records: records, Cursor: cursor, More: more})
}

type putRequest struct {
	Records []json.RawMessage `json:"records"`
}

type rejected struct {
	ID    string `json:"id"`
	Error string `json:"error"`
}

type putResponse struct {
	Accepted int        `json:"accepted"`
	Ignored  int        `json:"ignored"`
	Rejected []rejected `json:"rejected"`
}

func (s *Server) putChanges(w http.ResponseWriter, r *http.Request) {
	var req putRequest
	if !decodeJSON(w, r, maxSyncBody, &req) {
		return
	}
	if len(req.Records) > MaxSyncRecords {
		writeError(w, http.StatusRequestEntityTooLarge, "too_many_records",
			"A request can contain a maximum of "+strconv.Itoa(MaxSyncRecords)+" records.")
		return
	}
	resp := putResponse{Rejected: []rejected{}}
	valid := make([]store.Record, 0, len(req.Records))
	for _, raw := range req.Records {
		rec, id, err := store.ParseRecord(raw)
		if err != nil {
			resp.Rejected = append(resp.Rejected, rejected{ID: id, Error: err.Error()})
			continue
		}
		valid = append(valid, rec)
	}
	result, err := s.store.PutRecords(r.Context(), accountFrom(r.Context()).ID, valid)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	resp.Accepted, resp.Ignored = result.Accepted, result.Ignored
	writeJSON(w, http.StatusOK, resp)
}

// ---------- own password ----------

type passwordRequest struct {
	Current string `json:"current"`
	New     string `json:"new"`
}

// changePassword sets a new password for the account of the token. The
// other tokens of the account stop working; this token stays valid.
func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	var req passwordRequest
	if !decodeJSON(w, r, maxLoginBody, &req) {
		return
	}
	acc := accountFrom(r.Context())
	key := "id:" + strconv.FormatInt(acc.ID, 10)
	if !s.pwTries.take(key) {
		tooManyTries(w)
		return
	}
	hash, err := s.store.PasswordHashByID(r.Context(), acc.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	ok, err := auth.VerifyPassword(req.Current, hash)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !ok {
		writeError(w, http.StatusForbidden, "invalid_credentials", "The current password is not correct.")
		return
	}
	s.pwTries.refund(key)
	if err := auth.CheckNewPassword(req.New); err != nil {
		writeError(w, http.StatusBadRequest, "bad_password", err.Error()+".")
		return
	}
	newHash, err := auth.HashPassword(req.New)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := s.store.ChangePassword(r.Context(), acc.ID, newHash, tokenHashFrom(r.Context())); err != nil {
		s.internalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------- admin: accounts ----------
//
// An admin can add, list and delete user accounts. An admin cannot read
// records, and cannot set the password of an existing account: with that,
// an admin could log in as the user and read the records.

type userInfo struct {
	Username  string `json:"username"`
	Role      string `json:"role"`
	CreatedAt string `json:"createdAt"`
}

func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	users, err := s.store.ListUsers(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := make([]userInfo, 0, len(users))
	for _, u := range users {
		out = append(out, userInfo{Username: u.Username, Role: u.Role, CreatedAt: u.CreatedAt})
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": out})
}

type createUserRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	var req createUserRequest
	if !decodeJSON(w, r, maxLoginBody, &req) {
		return
	}
	if !store.ValidUsername(req.Username) {
		writeError(w, http.StatusBadRequest, "bad_username", "The user name must have 1 to 64 letters, digits, '.', '_', '-' or '@'.")
		return
	}
	if err := auth.CheckNewPassword(req.Password); err != nil {
		writeError(w, http.StatusBadRequest, "bad_password", err.Error()+".")
		return
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	// The API makes only user accounts. Admin accounts come from the
	// command line on the server.
	err = s.store.CreateUser(r.Context(), req.Username, hash, store.RoleUser)
	if errors.Is(err, store.ErrExists) {
		writeError(w, http.StatusConflict, "exists", "This user name is already in use.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.cfg.Logger.Info("account added", "by", accountFrom(r.Context()).ID, "role", store.RoleUser)
	writeJSON(w, http.StatusCreated, userInfo{Username: req.Username, Role: store.RoleUser})
}

func (s *Server) deleteUser(w http.ResponseWriter, r *http.Request) {
	// Only user accounts. Admin accounts are deleted on the command line.
	err := s.store.DeleteUser(r.Context(), r.PathValue("username"), store.RoleUser)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "There is no user account with this name.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.cfg.Logger.Info("account deleted", "by", accountFrom(r.Context()).ID)
	w.WriteHeader(http.StatusNoContent)
}

// ---------- middleware ----------

type ctxKey int

const (
	ctxAccount ctxKey = iota
	ctxTokenHash
)

func accountFrom(ctx context.Context) store.Account {
	v, _ := ctx.Value(ctxAccount).(store.Account)
	return v
}
func tokenHashFrom(ctx context.Context) []byte { v, _ := ctx.Value(ctxTokenHash).([]byte); return v }

// requireRole permits the request only for a valid token of an account
// with this role. Thus an admin token cannot read or write records.
func (s *Server) requireRole(role string, next http.HandlerFunc) http.Handler {
	return s.requireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if accountFrom(r.Context()).Role != role {
			writeError(w, http.StatusForbidden, "forbidden", "This account cannot use this API path.")
			return
		}
		next(w, r)
	}))
}

func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		const prefix = "Bearer "
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, prefix) || len(h) == len(prefix) {
			writeError(w, http.StatusUnauthorized, "invalid_token", "The token is not valid or it expired.")
			return
		}
		hash := auth.HashToken(strings.TrimSpace(h[len(prefix):]))
		acc, err := s.store.AccountForToken(r.Context(), hash)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusUnauthorized, "invalid_token", "The token is not valid or it expired.")
			return
		}
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		ctx := context.WithValue(context.WithValue(r.Context(), ctxAccount, acc), ctxTokenHash, hash)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// cors permits browser calls only from the allowed origins. The token is the
// real authentication; this is defence in depth.
func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "" {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Add("Vary", "Origin")
		if !s.origins[origin] {
			writeError(w, http.StatusForbidden, "origin_not_allowed", "This origin cannot use the API.")
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		// Behind a proxy, the proxy sets HSTS. Two different headers are
		// not clean, and browsers use only the first one.
		if r.TLS != nil {
			h.Set("Strict-Transport-Security", hstsHeaderValue)
		}
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

// logRequests logs the method, path, status and duration. It never logs
// query strings, headers or bodies (tokens, passwords, URLs).
func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		s.cfg.Logger.Info("request", "method", r.Method, "path", r.URL.Path, "status", sw.status,
			"ms", time.Since(start).Milliseconds())
	})
}

func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				s.cfg.Logger.Error("panic", "path", r.URL.Path, "error", v)
				writeError(w, http.StatusInternalServerError, "internal_error", "An internal error occurred.")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func tooManyTries(w http.ResponseWriter) {
	w.Header().Set("Retry-After", strconv.Itoa(int(loginWindow.Seconds())))
	writeError(w, http.StatusTooManyRequests, "too_many_requests", "Too many login tries. Wait one minute, then try again.")
}

// limitKey returns the key of the login limit for a client address. One
// IPv6 client usually has a full /64 network, so the key is the /64.
func limitKey(addr string) string {
	ip := net.ParseIP(addr)
	if ip == nil || ip.To4() != nil {
		return addr
	}
	return ip.Mask(net.CIDRMask(64, 128)).String() + "/64"
}

// clientIP returns the IP for the login rate limit.
func (s *Server) clientIP(r *http.Request) string {
	if name := s.cfg.ClientIPHeader; name != "" {
		// Use the last entry of all lines of the header. A proxy appends
		// (X-Forwarded-For) or replaces (X-Real-IP) the value, so the last
		// entry is the one that the client cannot set.
		parts := strings.Split(strings.Join(r.Header.Values(name), ","), ",")
		v := parts[len(parts)-1]
		if ip := net.ParseIP(strings.TrimSpace(v)); ip != nil {
			return ip.String()
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ---------- JSON helpers ----------

type errorBody struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorBody{Error: code, Message: message})
}

func (s *Server) internalError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, auth.ErrBusy) {
		w.Header().Set("Retry-After", "5")
		writeError(w, http.StatusServiceUnavailable, "busy", "The server is busy. Wait some seconds, then try again.")
		return
	}
	s.cfg.Logger.Error("internal error", "path", r.URL.Path, "error", err)
	writeError(w, http.StatusInternalServerError, "internal_error", "An internal error occurred.")
}

func decodeJSON(w http.ResponseWriter, r *http.Request, limit int64, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
			writeError(w, http.StatusRequestEntityTooLarge, "body_too_large", "The request body is too large.")
		} else {
			writeError(w, http.StatusBadRequest, "bad_request", "The request body is not valid JSON.")
		}
		return false
	}
	return true
}
