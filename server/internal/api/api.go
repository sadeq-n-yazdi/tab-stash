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
	loginTries      = 5
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
	// TrustProxy makes the server read the client IP from X-Forwarded-For.
	// Set it only when a reverse proxy is in front of the server.
	TrustProxy bool
	Logger     *slog.Logger
}

// Server is the HTTP handler.
type Server struct {
	store   *store.Store
	cfg     Config
	origins map[string]bool
	limiter *limiter
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
	s := &Server{store: st, cfg: cfg, origins: map[string]bool{}, limiter: newLimiter(loginTries, loginWindow)}
	for _, o := range cfg.AllowedOrigins {
		if o = strings.TrimSpace(o); o != "" {
			s.origins[o] = true
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("POST /api/v1/auth/login", s.login)
	mux.Handle("POST /api/v1/auth/logout", s.requireAuth(http.HandlerFunc(s.logout)))
	mux.Handle("GET /api/v1/sync", s.requireAuth(http.HandlerFunc(s.getChanges)))
	mux.Handle("POST /api/v1/sync", s.requireAuth(http.HandlerFunc(s.putChanges)))
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
	_, _ = w.Write([]byte("Tab Stash sync server. The API is at /api/v1. The web page is not available yet.\n"))
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Client   string `json:"client"`
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	ip := s.clientIP(r)
	if !s.limiter.allow(ip) {
		w.Header().Set("Retry-After", strconv.Itoa(int(loginWindow.Seconds())))
		writeError(w, http.StatusTooManyRequests, "too_many_requests", "Too many login tries. Wait one minute, then try again.")
		return
	}
	var req loginRequest
	if !decodeJSON(w, r, maxLoginBody, &req) {
		return
	}
	if req.Username == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "username and password are required.")
		return
	}
	userID, hash, err := s.store.PasswordHash(r.Context(), req.Username)
	ok := false
	switch {
	case errors.Is(err, store.ErrNotFound):
		auth.VerifyDummy(req.Password) // same time as a real check
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
		s.limiter.fail(ip)
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "The user name or the password is not correct.")
		return
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
	records, cursor, more, err := s.store.Changes(r.Context(), userFrom(r.Context()), since, MaxSyncRecords)
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
	result, err := s.store.PutRecords(r.Context(), userFrom(r.Context()), valid)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	resp.Accepted, resp.Ignored = result.Accepted, result.Ignored
	writeJSON(w, http.StatusOK, resp)
}

// ---------- middleware ----------

type ctxKey int

const (
	ctxUser ctxKey = iota
	ctxTokenHash
)

func userFrom(ctx context.Context) int64       { v, _ := ctx.Value(ctxUser).(int64); return v }
func tokenHashFrom(ctx context.Context) []byte { v, _ := ctx.Value(ctxTokenHash).([]byte); return v }

func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		const prefix = "Bearer "
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, prefix) || len(h) == len(prefix) {
			writeError(w, http.StatusUnauthorized, "invalid_token", "The token is not valid or it expired.")
			return
		}
		hash := auth.HashToken(strings.TrimSpace(h[len(prefix):]))
		userID, err := s.store.UserForToken(r.Context(), hash)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusUnauthorized, "invalid_token", "The token is not valid or it expired.")
			return
		}
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		ctx := context.WithValue(context.WithValue(r.Context(), ctxUser, userID), ctxTokenHash, hash)
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
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
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
		h.Set("Strict-Transport-Security", hstsHeaderValue)
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

// clientIP returns the IP for the login rate limit.
func (s *Server) clientIP(r *http.Request) string {
	if s.cfg.TrustProxy {
		// The proxy appends the address it saw; the last entry is the one we trust.
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if ip := strings.TrimSpace(parts[len(parts)-1]); ip != "" {
				return ip
			}
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
	s.cfg.Logger.Error("internal error", "path", r.URL.Path, "error", err)
	writeError(w, http.StatusInternalServerError, "internal_error", "An internal error occurred.")
}

func decodeJSON(w http.ResponseWriter, r *http.Request, limit int64, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusRequestEntityTooLarge, "body_too_large", "The request body is too large.")
		} else {
			writeError(w, http.StatusBadRequest, "bad_request", "The request body is not valid JSON.")
		}
		return false
	}
	return true
}
