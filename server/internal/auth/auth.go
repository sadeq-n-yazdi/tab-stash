// Package auth hashes passwords with Argon2id and makes access tokens.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
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
	return !strings.HasPrefix(encoded, fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$",
		argon2.Version, argonMemory, argonTime, argonThreads))
}

// HashPassword returns a PHC string: $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>.
func HashPassword(password string) (string, error) {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := idKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads, b64.EncodeToString(salt), b64.EncodeToString(key)), nil
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
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &time, &threads); err != nil {
		return false, fmt.Errorf("bad argon2 parameters: %w", err)
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
	got, err := idKey([]byte(password), salt, time, memory, threads, uint32(len(want)))
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

// VerifyDummy spends the same time as a real password check.
func VerifyDummy(password string) {
	_, _ = VerifyPassword(password, dummyHash)
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
