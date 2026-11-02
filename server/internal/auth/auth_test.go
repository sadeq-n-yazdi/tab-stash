package auth

import (
	"regexp"
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

func TestNewPepper(t *testing.T) {
	re := regexp.MustCompile(`^[a-zA-Z.\-]{64}$`)
	seen := map[string]bool{}
	for range 20 {
		p, err := NewPepper()
		if err != nil || !re.MatchString(p) {
			t.Fatalf("pepper %q %v", p, err)
		}
		if seen[p] {
			t.Fatal("same pepper twice")
		}
		seen[p] = true
	}
}

func TestPepper(t *testing.T) {
	t.Cleanup(func() { SetPepper("") })
	if err := SetPepper("too-short"); err == nil {
		t.Error("short pepper accepted")
	}

	// A hash made before the pepper was set.
	SetPepper("")
	plain, _ := HashPassword("a good password")

	p1, _ := NewPepper()
	if err := SetPepper(p1); err != nil {
		t.Fatal(err)
	}
	h, _ := HashPassword("a good password")
	if !strings.Contains(h, ",keyid=") || NeedsRehash(h) {
		t.Errorf("peppered hash %s", h)
	}
	if ok, err := VerifyPassword("a good password", h); !ok || err != nil {
		t.Errorf("peppered verify: %v %v", ok, err)
	}
	if ok, _ := VerifyPassword("a bad password", h); ok {
		t.Error("wrong password accepted")
	}
	// The old hash still works, and must be made again with the pepper.
	if ok, err := VerifyPassword("a good password", plain); !ok || err != nil {
		t.Errorf("plain hash with pepper set: %v %v", ok, err)
	}
	if !NeedsRehash(plain) {
		t.Error("plain hash does not need a rehash")
	}
	// The same hash with another pepper is an error, not a wrong password.
	p2, _ := NewPepper()
	SetPepper(p2)
	if _, err := VerifyPassword("a good password", h); err != ErrWrongPepper {
		t.Errorf("other pepper: %v", err)
	}
	// Without the pepper, the peppered key is different: a stolen database
	// alone does not let an attacker check guesses.
	salt, _ := b64.DecodeString(strings.Split(h, "$")[4])
	key, _ := idKey([]byte("a good password"), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	if strings.HasSuffix(h, b64.EncodeToString(key)) {
		t.Error("hash does not depend on the pepper")
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
