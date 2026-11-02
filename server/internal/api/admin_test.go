package api

import (
	"context"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sadeq-n-yazdi/tab-stash/server/internal/store"
)

const testPassword = "correct horse battery"

func loginAs(t *testing.T, srv *httptest.Server, name, password string) string {
	t.Helper()
	resp, out := do(t, srv, "POST", "/api/v1/auth/login", "",
		`{"username":"`+name+`","password":"`+password+`"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("login %s: %d %v", name, resp.StatusCode, out)
	}
	return out["token"].(string)
}

// newAdminServer has the user "alice" and the admin "root".
func newAdminServer(t *testing.T, cfg ...Config) *httptest.Server {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/admin.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	ctx := context.Background()
	if err := st.CreateUser(ctx, "alice", testHash, store.RoleUser); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateUser(ctx, "root", testHash, store.RoleAdmin); err != nil {
		t.Fatal(err)
	}
	c := Config{AllowedOrigins: []string{testOrigin}}
	if len(cfg) > 0 {
		c = cfg[0]
	}
	srv := httptest.NewServer(New(st, c))
	t.Cleanup(srv.Close)
	return srv
}

func TestAdminCannotReadRecords(t *testing.T) {
	srv := newAdminServer(t)
	alice := loginAs(t, srv, "alice", testPassword)
	admin := loginAs(t, srv, "root", testPassword)

	rec := `{"records":[{"id":"g1","kind":"group","name":"Private","color":"red","createdAt":"2026-11-01T10:00:00Z","updatedAt":"2026-11-01T10:00:00Z"}]}`
	if resp, _ := do(t, srv, "POST", "/api/v1/sync", alice, rec); resp.StatusCode != 200 {
		t.Fatalf("alice sync: %d", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "GET", "/api/v1/sync?since=0", admin, ""); resp.StatusCode != 403 {
		t.Errorf("admin GET sync: %d, want 403", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "POST", "/api/v1/sync", admin, rec); resp.StatusCode != 403 {
		t.Errorf("admin POST sync: %d, want 403", resp.StatusCode)
	}
	// The user list has names and roles only, no records.
	resp, out := do(t, srv, "GET", "/api/v1/admin/users", admin, "")
	if resp.StatusCode != 200 || strings.Contains(fmt.Sprint(out), "Private") {
		t.Errorf("admin list: %d %v", resp.StatusCode, out)
	}
	// A user cannot use the admin API.
	if resp, _ := do(t, srv, "GET", "/api/v1/admin/users", alice, ""); resp.StatusCode != 403 {
		t.Errorf("user on admin API: %d, want 403", resp.StatusCode)
	}
}

func TestAdminManagesUsers(t *testing.T) {
	srv := newAdminServer(t)
	admin := loginAs(t, srv, "root", testPassword)

	if resp, out := do(t, srv, "POST", "/api/v1/admin/users", admin, `{"username":"bob","password":"bob-password-1"}`); resp.StatusCode != 201 || out["role"] != "user" {
		t.Fatalf("create bob: %d %v", resp.StatusCode, out)
	}
	if resp, _ := do(t, srv, "POST", "/api/v1/admin/users", admin, `{"username":"BOB","password":"bob-password-1"}`); resp.StatusCode != 409 {
		t.Errorf("duplicate: %d", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "POST", "/api/v1/admin/users", admin, `{"username":"carl","password":"short"}`); resp.StatusCode != 400 {
		t.Errorf("short password: %d", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "POST", "/api/v1/admin/users", admin, `{"username":"a b","password":"long-enough-1"}`); resp.StatusCode != 400 {
		t.Errorf("bad user name: %d", resp.StatusCode)
	}
	// The API makes only user accounts: an extra "role" field is ignored.
	if resp, out := do(t, srv, "POST", "/api/v1/admin/users", admin, `{"username":"eve","password":"eve-password-1","role":"admin"}`); resp.StatusCode != 201 || out["role"] != "user" {
		t.Errorf("role escalation: %d %v", resp.StatusCode, out)
	}
	bob := loginAs(t, srv, "bob", "bob-password-1")

	// An admin cannot delete an admin account with the API.
	if resp, _ := do(t, srv, "DELETE", "/api/v1/admin/users/root", admin, ""); resp.StatusCode != 404 {
		t.Errorf("delete admin: %d, want 404", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "DELETE", "/api/v1/admin/users/bob", admin, ""); resp.StatusCode != 204 {
		t.Errorf("delete bob: %d", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "GET", "/api/v1/sync", bob, ""); resp.StatusCode != 401 {
		t.Errorf("token of deleted user: %d", resp.StatusCode)
	}
}

func TestChangeOwnPassword(t *testing.T) {
	srv := newAdminServer(t)
	keep := loginAs(t, srv, "alice", testPassword)
	other := loginAs(t, srv, "alice", testPassword)

	if resp, _ := do(t, srv, "POST", "/api/v1/auth/password", keep, `{"current":"wrong","new":"new-password-1"}`); resp.StatusCode != 403 {
		t.Errorf("wrong current: %d", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "POST", "/api/v1/auth/password", keep, `{"current":"`+testPassword+`","new":"short"}`); resp.StatusCode != 400 {
		t.Errorf("short new: %d", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "POST", "/api/v1/auth/password", keep, `{"current":"`+testPassword+`","new":"new-password-1"}`); resp.StatusCode != 204 {
		t.Fatalf("change: %d", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "GET", "/api/v1/sync", keep, ""); resp.StatusCode != 200 {
		t.Errorf("this token after change: %d", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "GET", "/api/v1/sync", other, ""); resp.StatusCode != 401 {
		t.Errorf("other token after change: %d", resp.StatusCode)
	}
	loginAs(t, srv, "alice", "new-password-1")
}

func TestClientIP(t *testing.T) {
	cases := []struct {
		configured, sent, value, remote, want string
	}{
		{"", "X-Real-IP", "203.0.113.9", "192.0.2.1:5000", "192.0.2.1"}, // not configured: ignored
		{"X-Real-IP", "X-Real-IP", "203.0.113.9", "127.0.0.1:5000", "203.0.113.9"},
		{"X-Real-IP", "X-Real-IP", "not an ip", "127.0.0.1:5000", "127.0.0.1"},
		{"X-Real-IP", "X-Forwarded-For", "203.0.113.9", "127.0.0.1:5000", "127.0.0.1"},
		{"X-Forwarded-For", "X-Forwarded-For", "1.1.1.1, 203.0.113.9", "127.0.0.1:5000", "203.0.113.9"},
	}
	for _, c := range cases {
		s := &Server{cfg: Config{ClientIPHeader: c.configured}}
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = c.remote
		r.Header.Set(c.sent, c.value)
		if got := s.clientIP(r); got != c.want {
			t.Errorf("%+v: got %s", c, got)
		}
	}
	if a, b := limitKey("2001:db8:1:2::1"), limitKey("2001:db8:1:2:ffff::9"); a != b || a != "2001:db8:1:2::/64" {
		t.Errorf("IPv6 keys: %s %s", a, b)
	}
	if k := limitKey("203.0.113.9"); k != "203.0.113.9" {
		t.Errorf("IPv4 key: %s", k)
	}
}

func TestLoginLimitPerUser(t *testing.T) {
	// Each try comes from a different client address, so only the limit
	// of the user name can stop them.
	srv := newAdminServer(t, Config{ClientIPHeader: "X-Real-IP"})
	bad := `{"username":"alice","password":"wrong password"}`
	for i := range userLoginTries {
		ip := fmt.Sprintf("198.51.100.%d", i+1)
		if resp, _ := do(t, srv, "POST", "/api/v1/auth/login", "", bad, "X-Real-IP", ip); resp.StatusCode != 401 {
			t.Fatalf("try %d: %d", i, resp.StatusCode)
		}
	}
	resp, _ := do(t, srv, "POST", "/api/v1/auth/login", "", `{"username":"alice","password":"`+testPassword+`"}`, "X-Real-IP", "198.51.100.200")
	if resp.StatusCode != 429 {
		t.Errorf("after %d failures from many addresses: %d", userLoginTries, resp.StatusCode)
	}
	// Another user name is not blocked.
	if resp, _ := do(t, srv, "POST", "/api/v1/auth/login", "", `{"username":"root","password":"`+testPassword+`"}`, "X-Real-IP", "198.51.100.201"); resp.StatusCode != 200 {
		t.Errorf("other user: %d", resp.StatusCode)
	}
}
