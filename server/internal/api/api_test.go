package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sadeq-n-yazdi/tab-stash/server/internal/auth"
	"github.com/sadeq-n-yazdi/tab-stash/server/internal/store"
)

const testOrigin = "chrome-extension://testid"

var testHash string

func init() {
	h, err := auth.HashPassword("correct horse battery")
	if err != nil {
		panic(err)
	}
	testHash = h
}

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "api.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if err := st.CreateUser(context.Background(), "alice", testHash); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(New(st, Config{AllowedOrigins: []string{testOrigin}}))
	t.Cleanup(srv.Close)
	return srv
}

func do(t *testing.T, srv *httptest.Server, method, path, token, body string, hdr ...string) (*http.Response, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	if len(bytes.TrimSpace(raw)) > 0 && raw[0] == '{' {
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatalf("%s %s: bad JSON %q", method, path, raw)
		}
	}
	return resp, out
}

func login(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	resp, out := do(t, srv, "POST", "/api/v1/auth/login", "", `{"username":"alice","password":"correct horse battery","client":"test"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("login: %d %v", resp.StatusCode, out)
	}
	token, _ := out["token"].(string)
	if token == "" || out["expiresAt"] == "" {
		t.Fatalf("login response: %v", out)
	}
	return token
}

func TestSyncFlow(t *testing.T) {
	srv := newTestServer(t)
	token := login(t, srv)

	body := `{"records":[
	  {"id":"g1","kind":"group","name":"Later","color":"blue","createdAt":"2026-11-01T10:00:00.000Z","updatedAt":"2026-11-01T10:00:00.000Z"},
	  {"id":"b1","kind":"bookmark","groupId":"g1","url":"https://go.dev/","title":"Go","color":"blue","createdAt":"2026-11-01T10:00:00.000Z","updatedAt":"2026-11-01T10:00:00.000Z"},
	  {"id":"bad","kind":"group","name":"x","color":"black","createdAt":"2026-11-01T10:00:00Z","updatedAt":"2026-11-01T10:00:00Z"}]}`
	resp, out := do(t, srv, "POST", "/api/v1/sync", token, body)
	if resp.StatusCode != 200 || out["accepted"] != 2.0 || out["ignored"] != 0.0 {
		t.Fatalf("POST sync: %d %v", resp.StatusCode, out)
	}
	if rej, _ := out["rejected"].([]any); len(rej) != 1 || rej[0].(map[string]any)["id"] != "bad" {
		t.Errorf("rejected: %v", out["rejected"])
	}
	if _, ok := out["cursor"]; ok {
		t.Errorf("POST must not return a cursor: %v", out)
	}

	resp, out = do(t, srv, "GET", "/api/v1/sync?since=0", token, "")
	if resp.StatusCode != 200 || out["cursor"] != 2.0 || out["more"] != false {
		t.Fatalf("GET sync: %d %v", resp.StatusCode, out)
	}
	if recs, _ := out["records"].([]any); len(recs) != 2 {
		t.Errorf("records: %v", out["records"])
	}
	if resp.Header.Get("Strict-Transport-Security") == "" || resp.Header.Get("Cache-Control") != "no-store" {
		t.Errorf("security headers missing: %v", resp.Header)
	}

	if resp, _ := do(t, srv, "GET", "/api/v1/sync?since=abc", token, ""); resp.StatusCode != 400 {
		t.Errorf("bad since: %d", resp.StatusCode)
	}

	if resp, _ := do(t, srv, "POST", "/api/v1/auth/logout", token, ""); resp.StatusCode != 204 {
		t.Fatalf("logout: %d", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "GET", "/api/v1/sync", token, ""); resp.StatusCode != 401 {
		t.Errorf("old token after logout: %d", resp.StatusCode)
	}
}

func TestAuthErrors(t *testing.T) {
	srv := newTestServer(t)
	if resp, _ := do(t, srv, "GET", "/api/v1/sync", "", ""); resp.StatusCode != 401 {
		t.Errorf("no token: %d", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "GET", "/api/v1/sync", "not-a-token", ""); resp.StatusCode != 401 {
		t.Errorf("bad token: %d", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "POST", "/api/v1/auth/login", "", `{"username":"nobody","password":"x"}`); resp.StatusCode != 401 {
		t.Errorf("unknown user: %d", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "POST", "/api/v1/auth/login", "", `not json`); resp.StatusCode != 400 {
		t.Errorf("bad JSON: %d", resp.StatusCode)
	}
	if resp, out := do(t, srv, "GET", "/api/v1/nothing", "", ""); resp.StatusCode != 404 || out["error"] != "not_found" {
		t.Errorf("unknown API path: %d %v", resp.StatusCode, out)
	}
}

func TestLoginRateLimit(t *testing.T) {
	srv := newTestServer(t)
	bad := `{"username":"alice","password":"wrong password"}`
	for i := range loginTries {
		if resp, _ := do(t, srv, "POST", "/api/v1/auth/login", "", bad); resp.StatusCode != 401 {
			t.Fatalf("try %d: %d", i, resp.StatusCode)
		}
	}
	resp, _ := do(t, srv, "POST", "/api/v1/auth/login", "", `{"username":"alice","password":"correct horse battery"}`)
	if resp.StatusCode != 429 || resp.Header.Get("Retry-After") == "" {
		t.Errorf("after %d failures: %d", loginTries, resp.StatusCode)
	}
}

func TestCORS(t *testing.T) {
	srv := newTestServer(t)
	resp, _ := do(t, srv, "OPTIONS", "/api/v1/sync", "", "",
		"Origin", testOrigin, "Access-Control-Request-Method", "POST")
	if resp.StatusCode != 204 || resp.Header.Get("Access-Control-Allow-Origin") != testOrigin {
		t.Errorf("preflight: %d %v", resp.StatusCode, resp.Header)
	}
	if resp, _ := do(t, srv, "GET", "/healthz", "", "", "Origin", "https://evil.example"); resp.StatusCode != 403 {
		t.Errorf("other origin: %d", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "GET", "/healthz", "", ""); resp.StatusCode != 200 {
		t.Errorf("no origin (curl): %d", resp.StatusCode)
	}
}

func TestLimiterWindow(t *testing.T) {
	l := newLimiter(2, time.Minute)
	now := time.Now()
	l.now = func() time.Time { return now }
	l.fail("ip")
	l.fail("ip")
	if l.allow("ip") || !l.allow("other") {
		t.Fatal("limit not applied per key")
	}
	now = now.Add(time.Minute + time.Second)
	if !l.allow("ip") {
		t.Error("limit not reset after the window")
	}
	if len(l.entries) != 1 { // "other" was removed by the sweep
		t.Errorf("entries not swept: %d", len(l.entries))
	}
}
