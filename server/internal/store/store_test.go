package store

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func openTest(t *testing.T) (*Store, int64) {
	t.Helper()
	st, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	ctx := context.Background()
	if err := st.CreateUser(ctx, "alice", "hash", RoleUser); err != nil {
		t.Fatal(err)
	}
	id, _, err := st.PasswordHash(ctx, "ALICE") // user names ignore case
	if err != nil {
		t.Fatal(err)
	}
	return st, id
}

func mustParse(t *testing.T, raw string) Record {
	t.Helper()
	r, _, err := ParseRecord(json.RawMessage(raw))
	if err != nil {
		t.Fatalf("ParseRecord(%s): %v", raw, err)
	}
	return r
}

// The shape the extension exports (lib/model.js): ms times with "Z",
// a tombstone, a bookmark of a group that is not on the server, and an
// unknown future field.
const (
	groupJSON    = `{"id":"g1","kind":"group","name":"Read later","note":"","labels":["learn"],"color":"blue","createdAt":"2026-11-01T10:00:00.000Z","updatedAt":"2026-11-01T10:00:00.000Z","deletedAt":null,"future":{"x":1}}`
	bookmarkJSON = `{"id":"b1","kind":"bookmark","groupId":"g-missing","title":"Go","url":"https://go.dev/","note":"n","labels":[],"color":"green","createdAt":"2026-11-01T10:00:00.000Z","updatedAt":"2026-11-01T10:00:01.000Z","deletedAt":"2026-11-02T08:00:00.000Z","seq":999}`
)

func TestRoundTrip(t *testing.T) {
	st, uid := openTest(t)
	ctx := context.Background()
	res, err := st.PutRecords(ctx, uid, []Record{mustParse(t, groupJSON), mustParse(t, bookmarkJSON)})
	if err != nil || res.Accepted != 2 || res.Ignored != 0 {
		t.Fatalf("PutRecords = %+v, %v", res, err)
	}
	recs, cursor, more, err := st.Changes(ctx, uid, 0, 500)
	if err != nil || len(recs) != 2 || cursor != 2 || more {
		t.Fatalf("Changes = %d records, cursor %d, more %v, %v", len(recs), cursor, more, err)
	}
	for i, src := range []string{groupJSON, bookmarkJSON} {
		var want, got map[string]any
		json.Unmarshal([]byte(src), &want)
		json.Unmarshal(recs[i], &got)
		want["seq"] = float64(i + 1) // the server seq replaces any client seq
		if fmt.Sprint(want) != fmt.Sprint(got) {
			t.Errorf("record %d:\n got  %v\n want %v", i, got, want)
		}
	}
	if !strings.Contains(string(recs[0]), `"2026-11-01T10:00:00.000Z"`) {
		t.Errorf("time string changed: %s", recs[0])
	}
}

func TestLastWriteWins(t *testing.T) {
	st, uid := openTest(t)
	ctx := context.Background()
	put := func(updated, name string) PutResult {
		t.Helper()
		raw := fmt.Sprintf(`{"id":"g1","kind":"group","name":%q,"color":"red","createdAt":"2026-11-01T10:00:00Z","updatedAt":%q}`, name, updated)
		res, err := st.PutRecords(ctx, uid, []Record{mustParse(t, raw)})
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	if r := put("2026-11-01T10:00:00.500Z", "first"); r.Accepted != 1 {
		t.Fatalf("first put: %+v", r)
	}
	if r := put("2026-11-01T10:00:00.400Z", "older"); r.Ignored != 1 {
		t.Errorf("older put: %+v", r)
	}
	// Same instant in another format is equal, so it is ignored.
	if r := put("2026-11-01T11:00:00.5+01:00", "equal"); r.Ignored != 1 {
		t.Errorf("equal put: %+v", r)
	}
	if r := put("2026-11-01T10:00:01Z", "newer"); r.Accepted != 1 {
		t.Errorf("newer put: %+v", r)
	}
	recs, cursor, _, _ := st.Changes(ctx, uid, 0, 10)
	if len(recs) != 1 || cursor != 2 || !strings.Contains(string(recs[0]), `"newer"`) {
		t.Errorf("after puts: %s cursor %d", recs, cursor)
	}
	// A client that already has seq 1 gets the update.
	if recs, _, _, _ := st.Changes(ctx, uid, 1, 10); len(recs) != 1 {
		t.Errorf("changes since 1: %d records", len(recs))
	}
}

func TestPagination(t *testing.T) {
	st, uid := openTest(t)
	ctx := context.Background()
	const total = 1001
	recs := make([]Record, total)
	for i := range recs {
		recs[i] = mustParse(t, fmt.Sprintf(`{"id":"g%d","kind":"group","name":"n","color":"grey","createdAt":"2026-11-01T10:00:00Z","updatedAt":"2026-11-01T10:00:00Z"}`, i))
	}
	if _, err := st.PutRecords(ctx, uid, recs); err != nil {
		t.Fatal(err)
	}
	var since int64
	seen := 0
	for page := 0; ; page++ {
		got, cursor, more, err := st.Changes(ctx, uid, since, 500)
		if err != nil {
			t.Fatal(err)
		}
		seen += len(got)
		since = cursor
		if !more {
			break
		}
		if len(got) != 500 {
			t.Fatalf("page %d has %d records", page, len(got))
		}
	}
	if seen != total || since != total {
		t.Errorf("saw %d records, last cursor %d", seen, since)
	}
	// Exactly one full page: more must be false.
	got, _, more, _ := st.Changes(ctx, uid, total-500, 500)
	if len(got) != 500 || more {
		t.Errorf("exact page: %d records, more %v", len(got), more)
	}
}

func TestUsersAreSeparate(t *testing.T) {
	st, alice := openTest(t)
	ctx := context.Background()
	st.CreateUser(ctx, "bob", "hash", RoleUser)
	bob, _, _ := st.PasswordHash(ctx, "bob")
	st.PutRecords(ctx, alice, []Record{mustParse(t, groupJSON)})
	if recs, _, _, _ := st.Changes(ctx, bob, 0, 10); len(recs) != 0 {
		t.Errorf("bob sees %d records of alice", len(recs))
	}
	if err := st.CreateUser(ctx, "Alice", "x", RoleUser); err != ErrExists {
		t.Errorf("duplicate user: %v", err)
	}
}

func TestParseRecordRejects(t *testing.T) {
	cases := map[string]string{
		"not object":  `[1]`,
		"no id":       `{"kind":"group","name":"n","color":"red","createdAt":"2026-11-01T10:00:00Z","updatedAt":"2026-11-01T10:00:00Z"}`,
		"bad kind":    `{"id":"x","kind":"tab","name":"n","color":"red","createdAt":"2026-11-01T10:00:00Z","updatedAt":"2026-11-01T10:00:00Z"}`,
		"bad color":   `{"id":"x","kind":"group","name":"n","color":"black","createdAt":"2026-11-01T10:00:00Z","updatedAt":"2026-11-01T10:00:00Z"}`,
		"bad time":    `{"id":"x","kind":"group","name":"n","color":"red","createdAt":"2026-11-01T10:00:00Z","updatedAt":"yesterday"}`,
		"no name":     `{"id":"x","kind":"group","name":"","color":"red","createdAt":"2026-11-01T10:00:00Z","updatedAt":"2026-11-01T10:00:00Z"}`,
		"no url":      `{"id":"x","kind":"bookmark","groupId":"g","color":"red","createdAt":"2026-11-01T10:00:00Z","updatedAt":"2026-11-01T10:00:00Z"}`,
		"empty label": `{"id":"x","kind":"group","name":"n","labels":[""],"color":"red","createdAt":"2026-11-01T10:00:00Z","updatedAt":"2026-11-01T10:00:00Z"}`,
		"wrong type":  `{"id":5,"kind":"group","name":"n","color":"red","createdAt":"2026-11-01T10:00:00Z","updatedAt":"2026-11-01T10:00:00Z"}`,
	}
	for name, raw := range cases {
		if _, _, err := ParseRecord(json.RawMessage(raw)); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}

// A version 1 database (no role column) opens, and its accounts become users.
func TestMigrateFromV1(t *testing.T) {
	path := filepath.Join(t.TempDir(), "v1.db")
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`DROP TABLE users`,
		`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL)`,
		`INSERT INTO users (username, password_hash, created_at) VALUES ('old', 'h', '2026-01-01T00:00:00Z')`,
		`PRAGMA user_version = 1`,
	} {
		if _, err := st.db.Exec(q); err != nil {
			t.Fatal(q, err)
		}
	}
	st.Close()

	for range 2 { // the second open must not migrate again
		st, err = Open(path)
		if err != nil {
			t.Fatal(err)
		}
		users, err := st.ListUsers(context.Background())
		if err != nil || len(users) != 1 || users[0].Role != RoleUser {
			t.Fatalf("users after migration: %+v %v", users, err)
		}
		var v int
		st.db.QueryRow(`PRAGMA user_version`).Scan(&v)
		if v != schemaVersion {
			t.Errorf("user_version = %d", v)
		}
		st.Close()
	}
}

func TestRolesAndDelete(t *testing.T) {
	st, _ := openTest(t)
	ctx := context.Background()
	if err := st.CreateUser(ctx, "root", "h", RoleAdmin); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateUser(ctx, "x", "h", "owner"); err == nil {
		t.Error("unknown role accepted")
	}
	if err := st.CreateUser(ctx, "bad name", "h", RoleUser); err == nil {
		t.Error("bad user name accepted")
	}
	if err := st.DeleteUser(ctx, "root", RoleUser); err != ErrNotFound {
		t.Errorf("delete admin with role filter user: %v", err)
	}
	if err := st.DeleteUser(ctx, "root", ""); err != nil {
		t.Errorf("delete admin without filter: %v", err)
	}
}
