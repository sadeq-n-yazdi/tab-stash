package store

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

const img = "data:image/jpeg;base64,/9j/4AAQ"

func preview(id, scope, device, image string, deleted bool) string {
	del := "null"
	if deleted {
		del = `"2026-11-02T09:00:00.000Z"`
	}
	dev := ""
	if device != "" {
		dev = fmt.Sprintf(`,"deviceId":%q`, device)
	}
	return fmt.Sprintf(`{"id":%q,"kind":"preview","bookmarkId":"b1","scope":%q%s,"image":%q,`+
		`"createdAt":"2026-11-02T08:00:00.000Z","updatedAt":"2026-11-02T08:00:00.000Z","deletedAt":%s}`,
		id, scope, dev, image, del)
}

func TestPreviewValidation(t *testing.T) {
	cases := []struct {
		name, js, want string
	}{
		{"account", preview("p1", "account", "", img, false), ""},
		{"device", preview("p2", "device", "device-aaaa", img, false), ""},
		{"no scope", preview("p3", "everyone", "", img, false), "scope"},
		{"device without id", preview("p4", "device", "", img, false), "deviceId"},
		{"bad device id", preview("p5", "device", "bad id!", img, false), "deviceId"},
		{"no image", preview("p6", "account", "", "", false), "image is required"},
		{"tombstone without image", preview("p7", "account", "", "", true), ""},
		{"not an image", preview("p8", "account", "", "javascript:alert(1)", false), "data URL"},
		{"too large", preview("p9", "account", "", img+strings.Repeat("A", MaxImageLen), false), "too large"},
		{"no bookmark", strings.Replace(preview("p10", "account", "", img, false), `"bookmarkId":"b1",`, "", 1), "bookmarkId"},
	}
	for _, c := range cases {
		_, _, err := ParseRecord(json.RawMessage(c.js))
		switch {
		case c.want == "" && err != nil:
			t.Errorf("%s: unexpected error %v", c.name, err)
		case c.want != "" && (err == nil || !strings.Contains(err.Error(), c.want)):
			t.Errorf("%s: error %v, want %q", c.name, err, c.want)
		}
	}
}

func ids(t *testing.T, recs []json.RawMessage) []string {
	t.Helper()
	var out []string
	for _, r := range recs {
		var v struct{ ID string }
		if err := json.Unmarshal(r, &v); err != nil {
			t.Fatal(err)
		}
		out = append(out, v.ID)
	}
	return out
}

func TestChangesFilterByDevice(t *testing.T) {
	st, uid := openTest(t)
	ctx := context.Background()
	recs := []Record{
		mustParse(t, groupJSON),
		mustParse(t, preview("shared", "account", "", img, false)),
		mustParse(t, preview("mine", "device", "device-aaaa", img, false)),
		mustParse(t, preview("other", "device", "device-bbbb", img, false)),
	}
	if _, err := st.PutRecords(ctx, uid, recs); err != nil {
		t.Fatal(err)
	}
	check := func(f Filter, want string) {
		t.Helper()
		got, _, _, err := st.Changes(ctx, uid, 0, 500, f)
		if err != nil {
			t.Fatal(err)
		}
		if g := strings.Join(ids(t, got), ","); g != want {
			t.Errorf("filter %+v: got %s, want %s", f, g, want)
		}
	}
	check(Filter{}, "g1") // an old client gets no previews
	check(Filter{Device: "device-aaaa"}, "g1,shared,mine")
	check(Filter{Device: "device-bbbb"}, "g1,shared,other")
	var col string
	st.db.QueryRow(`SELECT device_id FROM records WHERE id = 'mine'`).Scan(&col)
	if col != "device-aaaa" {
		t.Errorf("device_id = %q", col)
	}
}

func TestChangesPageSizeLimit(t *testing.T) {
	st, uid := openTest(t)
	ctx := context.Background()
	big := img + strings.Repeat("A", 390_000)
	var recs []Record
	for i := range 25 { // about 9.8 MB
		recs = append(recs, mustParse(t, preview(fmt.Sprintf("p%02d", i), "account", "", big, false)))
	}
	if _, err := st.PutRecords(ctx, uid, recs); err != nil {
		t.Fatal(err)
	}
	var since int64
	pages, total := 0, 0
	for {
		got, cursor, more, err := st.Changes(ctx, uid, since, 500, Filter{Device: "device-aaaa"})
		if err != nil {
			t.Fatal(err)
		}
		size := 0
		for _, r := range got {
			size += len(r)
		}
		if size > MaxPageBytes+1000 {
			t.Errorf("page of %d bytes", size)
		}
		pages++
		total += len(got)
		since = cursor
		if !more {
			break
		}
	}
	if total != 25 || pages < 3 {
		t.Errorf("got %d records in %d pages", total, pages)
	}
}

func TestMigrateFromV3AddsDeviceID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "v3.db")
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`DROP TABLE records`,
		`CREATE TABLE records (user_id INTEGER NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, data TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (user_id, id))`,
		`PRAGMA user_version = 3`,
	} {
		if _, err := st.db.Exec(q); err != nil {
			t.Fatal(q, err)
		}
	}
	st.Close()
	st, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	var n int
	st.db.QueryRow(`SELECT count(*) FROM pragma_table_info('records') WHERE name = 'device_id'`).Scan(&n)
	if n != 1 {
		t.Error("device_id column is missing")
	}
}
