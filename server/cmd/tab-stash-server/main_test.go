package main

import (
	"os"
	"testing"
)

func TestApplySettings(t *testing.T) {
	t.Setenv("TAB_STASH_ADDR", "from-env")
	os.Unsetenv("TAB_STASH_PASSWORD_SALT")
	os.Unsetenv("TAB_STASH_DB")
	t.Cleanup(func() {
		os.Unsetenv("TAB_STASH_PASSWORD_SALT")
		os.Unsetenv("TAB_STASH_DB")
	})
	data := "# comment\n\nTAB_STASH_PASSWORD_SALT=\nTAB_STASH_ADDR=from-file\nTAB_STASH_DB=\"/x/y.db\"\nTAB_STASH_PASSWORD_SALT=last-wins\n"
	if err := applySettings("test.env", data); err != nil {
		t.Fatal(err)
	}
	if v := os.Getenv("TAB_STASH_PASSWORD_SALT"); v != "last-wins" {
		t.Errorf("salt = %q, want the value of the last line", v)
	}
	if v := os.Getenv("TAB_STASH_ADDR"); v != "from-env" {
		t.Errorf("addr = %q, the environment must win over the file", v)
	}
	if v := os.Getenv("TAB_STASH_DB"); v != "/x/y.db" {
		t.Errorf("db = %q, the quotes must go", v)
	}
	if err := applySettings("bad.env", "OTHER=1\n"); err == nil {
		t.Error("a name without TAB_STASH_ was accepted")
	}
}
