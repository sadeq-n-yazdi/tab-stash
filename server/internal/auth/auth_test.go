package auth

import (
	"strings"
	"testing"
)

func TestHashAndVerify(t *testing.T) {
	h, err := HashPassword("a good password")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "$argon2id$v=19$m=19456,t=2,p=1$") || NeedsRehash(h) {
		t.Errorf("hash %s", h)
	}
	if ok, err := VerifyPassword("a good password", h); !ok || err != nil {
		t.Errorf("correct password: %v %v", ok, err)
	}
	if ok, _ := VerifyPassword("a bad password", h); ok {
		t.Error("wrong password accepted")
	}
}

// A hash with other parameters still verifies, and needs a rehash.
func TestOldParameters(t *testing.T) {
	const old = "$argon2id$v=19$m=65536,t=3,p=2$c29tZXNhbHRzb21lc2FsdA$"
	salt, _ := b64.DecodeString("c29tZXNhbHRzb21lc2FsdA")
	key, _ := idKey([]byte("pw"), salt, 3, 65536, 2, 32)
	h := old + b64.EncodeToString(key)
	if ok, err := VerifyPassword("pw", h); !ok || err != nil {
		t.Errorf("old hash: %v %v", ok, err)
	}
	if !NeedsRehash(h) {
		t.Error("old hash does not need a rehash")
	}
	if _, err := VerifyPassword("pw", "$argon2id$v=19$m=9999999,t=3,p=2$c2FsdA$a2V5"); err == nil {
		t.Error("huge memory parameter accepted")
	}
}

func TestCheckNewPassword(t *testing.T) {
	if CheckNewPassword("123456789") == nil {
		t.Error("9 characters accepted")
	}
	if CheckNewPassword("1234567890") != nil {
		t.Error("10 characters refused")
	}
	if CheckNewPassword(strings.Repeat("x", MaxPasswordLen+1)) == nil {
		t.Error("too long accepted")
	}
}
