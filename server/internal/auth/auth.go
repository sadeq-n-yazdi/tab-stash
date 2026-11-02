// Package auth hashes passwords with Argon2id and makes access tokens.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
)

// Argon2id parameters: the OWASP values (m=19 MiB, t=2, p=1). They keep the
// memory low on a small server. A stored hash keeps its own parameters, so
// these values can change later without a problem for old hashes.
const (
	argonTime    = 2
	argonMemory  = 19 * 1024 // KiB
	argonThreads = 1
	argonKeyLen  = 32
	saltLen      = 16
	tokenBytes   = 32
)

var b64 = base64.RawStdEncoding

// Limits of a new password.
const (
	MinPasswordLen = 10
	MaxPasswordLen = 1024
)

// CheckNewPassword returns an error if a new password is too short or too long.
func CheckNewPassword(password string) error {
	n := len([]rune(password))
	if n < MinPasswordLen {
		return fmt.Errorf("the password must have %d or more characters", MinPasswordLen)
	}
	if n > MaxPasswordLen {
		return fmt.Errorf("the password must have %d or fewer characters", MaxPasswordLen)
	}
	return nil
}

// hashSlots limits the Argon2 computations that run at the same time, so
// that many logins at the same time cannot use all the memory of the server.
var hashSlots = make(chan struct{}, 2)

// hashWait is the maximum time to wait for a free slot.
const hashWait = 5 * time.Second

// ErrBusy is returned when all hash slots stay in use for hashWait.
var ErrBusy = errors.New("the server is busy; try again")

func idKey(password, salt []byte, t, memory uint32, threads uint8, keyLen uint32) ([]byte, error) {
	timer := time.NewTimer(hashWait)
	defer timer.Stop()
	select {
	case hashSlots <- struct{}{}:
	case <-timer.C:
		return nil, ErrBusy
	}
	defer func() { <-hashSlots }()
	return argon2.IDKey(password, salt, t, memory, threads, keyLen), nil
}

// NeedsRehash reports whether a stored hash uses parameters that are not
// the current ones. The server then hashes the password again after a
// correct login, so that all checks take the same time.
func NeedsRehash(encoded string) bool {
	return !strings.HasPrefix(encoded, "$argon2id$v="+strconv.Itoa(argon2.Version)+"$"+currentParams()+"$")
}

// ---------- pepper ----------
//
// Each hash has its own random salt (stored in the hash). The pepper is a
// second, secret value for the whole server. It is kept in the settings
// file, not in the database. Thus a copy of the database alone is not
// sufficient to guess passwords. The password goes through
// HMAC-SHA256(pepper, password) before Argon2id. The "keyid" parameter of
// the hash identifies the pepper, so the server can tell a wrong pepper
// from a wrong password.

// PepperChars are the characters of a generated pepper: [a-zA-Z.-].
const PepperChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-"

// PepperLen is the length of a generated pepper.
const PepperLen = 64

// minPepperLen is the shortest pepper that SetPepper accepts.
const minPepperLen = 32

// ErrWrongPepper is returned when a hash was made with a different pepper.
var ErrWrongPepper = errors.New("the password hash was made with a different pepper (TAB_STASH_PASSWORD_PEPPER)")

var (
	pepper   []byte
	pepperID string
)

// SetPepper sets the server pepper. Call it once at start, before any
// hash. An empty value means no pepper.
func SetPepper(p string) error {
	if p == "" {
		pepper, pepperID = nil, ""
		return nil
	}
	if len(p) < minPepperLen {
		return fmt.Errorf("the pepper must have %d or more characters", minPepperLen)
	}
	pepper = []byte(p)
	sum := sha256.Sum256(pepper)
	pepperID = base64.RawURLEncoding.EncodeToString(sum[:6])
	return nil
}

// HasPepper reports whether a pepper is set.
func HasPepper() bool { return pepper != nil }

// NewPepper returns PepperLen random characters from PepperChars.
func NewPepper() (string, error) {
	out := make([]byte, 0, PepperLen)
	buf := make([]byte, 64)
	// Rejection sampling: use only bytes below the largest multiple of
	// len(PepperChars), so that each character has the same chance.
	limit := byte(256 - 256%len(PepperChars))
	for len(out) < PepperLen {
		if _, err := rand.Read(buf); err != nil {
			return "", err
		}
		for _, b := range buf {
			if b < limit && len(out) < PepperLen {
				out = append(out, PepperChars[int(b)%len(PepperChars)])
			}
		}
	}
	return string(out), nil
}

// peppered returns the input of Argon2 for a password.
func peppered(password string, use bool) []byte {
	if !use {
		return []byte(password)
	}
	mac := hmac.New(sha256.New, pepper)
	mac.Write([]byte(password))
	return mac.Sum(nil)
}

func currentParams() string {
	p := fmt.Sprintf("m=%d,t=%d,p=%d", argonMemory, argonTime, argonThreads)
	if pepperID != "" {
		p += ",keyid=" + pepperID
	}
	return p
}

// HashPassword returns a PHC string:
// $argon2id$v=19$m=19456,t=2,p=1[,keyid=<pepper id>]$<salt>$<hash>.
func HashPassword(password string) (string, error) {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := idKey(peppered(password, pepperID != ""), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("$argon2id$v=%d$%s$%s$%s",
		argon2.Version, currentParams(), b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

// VerifyPassword reports whether password matches the PHC hash.
func VerifyPassword(password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errors.New("unsupported password hash format")
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, errors.New("unsupported argon2 version")
	}
	var memory, time uint32
	var threads uint8
	params, keyID, _ := strings.Cut(parts[3], ",keyid=")
	if _, err := fmt.Sscanf(params, "m=%d,t=%d,p=%d", &memory, &time, &threads); err != nil {
		return false, fmt.Errorf("bad argon2 parameters: %w", err)
	}
	if keyID != "" && keyID != pepperID {
		return false, ErrWrongPepper
	}
	salt, err := b64.DecodeString(parts[4])
	if err != nil {
		return false, err
	}
	want, err := b64.DecodeString(parts[5])
	if err != nil {
		return false, err
	}
	if memory > 256*1024 || time > 10 || threads == 0 || len(want) == 0 {
		return false, errors.New("argon2 parameters out of range")
	}
	got, err := idKey(peppered(password, keyID != ""), salt, time, memory, threads, uint32(len(want)))
	if err != nil {
		return false, err
	}
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// dummyHash is verified when a user does not exist, so that the response
// time does not show which user names exist.
var dummyHash = func() string {
	h, err := HashPassword("dummy password for timing")
	if err != nil {
		panic(err)
	}
	return h
}()

// VerifyDummy spends the same time as a real password check. It returns
// an error in the same cases as VerifyPassword (for example ErrBusy).
func VerifyDummy(password string) error {
	_, err := VerifyPassword(password, dummyHash)
	return err
}

// NewToken returns a random token (sent to the client) and its SHA-256 hash
// (kept in the database).
func NewToken() (token string, hash []byte, err error) {
	raw := make([]byte, tokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, err
	}
	token = base64.RawURLEncoding.EncodeToString(raw)
	return token, HashToken(token), nil
}

// HashToken returns the SHA-256 hash of a token.
func HashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}
