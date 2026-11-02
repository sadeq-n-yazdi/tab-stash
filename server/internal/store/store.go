// Package store keeps users, tokens and records in SQLite.
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
	"unicode"

	_ "modernc.org/sqlite" // pure Go SQLite driver: no C compiler needed
)

// ErrNotFound is returned when a user or token does not exist.
var ErrNotFound = errors.New("not found")

// ErrExists is returned when a user name is already in use.
var ErrExists = errors.New("already exists")

// Roles. A user keeps groups and bookmarks. An admin only manages the
// accounts: an admin has no records and cannot read the records of users.
const (
	RoleUser  = "user"
	RoleAdmin = "admin"
)

// MaxUsernameLen is the maximum length of a user name.
const MaxUsernameLen = 64

// ValidUsername reports whether a user name is acceptable: 1 to 64
// characters, letters, digits, ".", "_", "-" and "@".
func ValidUsername(name string) bool {
	if name == "" || textLen(name) > MaxUsernameLen {
		return false
	}
	for _, r := range name {
		if !(unicode.IsLetter(r) || unicode.IsDigit(r) || strings.ContainsRune("._-@", r)) {
			return false
		}
	}
	return true
}

// schemaVersion 2 added users.role.
const schemaVersion = 2

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin'))
);
CREATE TABLE IF NOT EXISTS tokens (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   BLOB NOT NULL UNIQUE,
  client       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data       TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS records_user_seq ON records (user_id, seq);
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO counters (name, value) VALUES ('seq', 0);
`

// Store is the database.
type Store struct {
	db *sql.DB
}

// User is a user account.
type User struct {
	ID        int64
	Username  string
	Role      string
	CreatedAt string
}

// Account is the user of a valid token.
type Account struct {
	ID   int64
	Role string
}

// TokenInfo describes an access token (never the token itself).
type TokenInfo struct {
	ID         int64
	Client     string
	CreatedAt  string
	ExpiresAt  string
	LastUsedAt string
}

func now() string { return time.Now().UTC().Format(time.RFC3339) }

// Open opens (and creates, if necessary) the database file.
func Open(path string) (*Store, error) {
	// Pragmas apply per connection, so they go in the DSN.
	// _txlock=immediate takes the write lock at BEGIN, so the seq counter
	// is always assigned and committed in order.
	q := url.Values{}
	q.Add("_pragma", "busy_timeout(10000)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "synchronous(NORMAL)")
	q.Set("_txlock", "immediate")
	db, err := sql.Open("sqlite", "file:"+path+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	var version int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	if version > schemaVersion {
		return fmt.Errorf("database schema version %d is newer than this server (%d)", version, schemaVersion)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if version == 1 {
		// Version 1 has no role column. All version 1 accounts are users.
		if _, err := tx.Exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin'))`); err != nil {
			return fmt.Errorf("migrate to version 2: %w", err)
		}
	}
	if _, err := tx.Exec(schema); err != nil {
		return fmt.Errorf("create schema: %w", err)
	}
	if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, schemaVersion)); err != nil {
		return err
	}
	return tx.Commit()
}

// ---------- users ----------

// CreateUser adds an account with an already hashed password. role is
// RoleUser or RoleAdmin.
func (s *Store) CreateUser(ctx context.Context, username, passwordHash, role string) error {
	if !ValidUsername(username) {
		return errors.New("the user name must have 1 to 64 letters, digits, '.', '_', '-' or '@'")
	}
	if role != RoleUser && role != RoleAdmin {
		return fmt.Errorf("unknown role %q", role)
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO users (username, password_hash, created_at, role) VALUES (?, ?, ?, ?)`, username, passwordHash, now(), role)
	if err != nil && isUniqueErr(err) {
		return ErrExists
	}
	return err
}

// SetPassword changes the password hash of a user and deletes all of the
// user's tokens, so every device must log in again.
func (s *Store) SetPassword(ctx context.Context, username, passwordHash string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `UPDATE users SET password_hash = ? WHERE username = ?`, passwordHash, username)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM tokens WHERE user_id = (SELECT id FROM users WHERE username = ?)`, username); err != nil {
		return err
	}
	return tx.Commit()
}

// ChangePassword sets a new password hash for the user of a token. It
// deletes all other tokens of the user, but keeps the token keepToken.
func (s *Store) ChangePassword(ctx context.Context, userID int64, passwordHash string, keepToken []byte) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `UPDATE users SET password_hash = ? WHERE id = ?`, passwordHash, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM tokens WHERE user_id = ? AND token_hash != ?`, userID, keepToken); err != nil {
		return err
	}
	return tx.Commit()
}

// UpdatePasswordHash replaces the hash of the same password (new
// parameters). It does not delete tokens.
func (s *Store) UpdatePasswordHash(ctx context.Context, userID int64, passwordHash string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET password_hash = ? WHERE id = ?`, passwordHash, userID)
	return err
}

// PasswordHashByID returns the password hash of an account.
func (s *Store) PasswordHashByID(ctx context.Context, userID int64) (string, error) {
	var hash string
	err := s.db.QueryRowContext(ctx, `SELECT password_hash FROM users WHERE id = ?`, userID).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return hash, err
}

// DeleteUser deletes an account with all tokens and records. If role is
// not empty, it deletes the account only if it has this role.
func (s *Store) DeleteUser(ctx context.Context, username, role string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM users WHERE username = ? AND (? = '' OR role = ?)`, username, role, role)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ListUsers returns all users.
func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, username, role, created_at FROM users ORDER BY username`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Username, &u.Role, &u.CreatedAt); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

// PasswordHash returns the user id and password hash for a login.
func (s *Store) PasswordHash(ctx context.Context, username string) (int64, string, error) {
	var id int64
	var hash string
	err := s.db.QueryRowContext(ctx, `SELECT id, password_hash FROM users WHERE username = ?`, username).Scan(&id, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, "", ErrNotFound
	}
	return id, hash, err
}

// ---------- tokens ----------

// CreateToken stores the hash of a new token.
func (s *Store) CreateToken(ctx context.Context, userID int64, tokenHash []byte, client string, expires time.Time) error {
	t := now()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO tokens (user_id, token_hash, client, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)`,
		userID, tokenHash, client, t, expires.UTC().Format(time.RFC3339), t)
	return err
}

// AccountForToken returns the account of a valid, not expired token. It
// also records the time of use (at most once each minute, to limit writes).
func (s *Store) AccountForToken(ctx context.Context, tokenHash []byte) (Account, error) {
	var tokenID int64
	var acc Account
	var expires, lastUsed string
	err := s.db.QueryRowContext(ctx, `
		SELECT t.id, t.user_id, u.role, t.expires_at, t.last_used_at
		FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`, tokenHash).
		Scan(&tokenID, &acc.ID, &acc.Role, &expires, &lastUsed)
	if errors.Is(err, sql.ErrNoRows) {
		return Account{}, ErrNotFound
	}
	if err != nil {
		return Account{}, err
	}
	nowT := time.Now().UTC()
	if exp, err := time.Parse(time.RFC3339, expires); err != nil || !nowT.Before(exp) {
		return Account{}, ErrNotFound
	}
	if lu, err := time.Parse(time.RFC3339, lastUsed); err != nil || nowT.Sub(lu) > time.Minute {
		if _, err := s.db.ExecContext(ctx, `UPDATE tokens SET last_used_at = ? WHERE id = ?`, now(), tokenID); err != nil {
			return Account{}, err
		}
	}
	return acc, nil
}

// DeleteToken deletes one token (logout).
func (s *Store) DeleteToken(ctx context.Context, tokenHash []byte) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM tokens WHERE token_hash = ?`, tokenHash)
	return err
}

// ListTokens returns the tokens of a user (for "active logins").
func (s *Store) ListTokens(ctx context.Context, username string) ([]TokenInfo, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT t.id, t.client, t.created_at, t.expires_at, t.last_used_at
		FROM tokens t JOIN users u ON u.id = t.user_id
		WHERE u.username = ? ORDER BY t.last_used_at DESC`, username)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TokenInfo
	for rows.Next() {
		var t TokenInfo
		if err := rows.Scan(&t.ID, &t.Client, &t.CreatedAt, &t.ExpiresAt, &t.LastUsedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// DeleteExpiredTokens removes expired tokens.
func (s *Store) DeleteExpiredTokens(ctx context.Context) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM tokens WHERE expires_at <= ?`, now())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// ---------- records ----------

// PutResult counts the outcome of PutRecords.
type PutResult struct {
	Accepted int
	Ignored  int
}

// PutRecords stores records with last-write-wins on updatedAt. A record is
// stored only if it is new, or if its updatedAt is later than the stored one.
// Each stored record gets a new seq. All work is one transaction that takes
// the write lock at BEGIN, so seq values become visible in order.
func (s *Store) PutRecords(ctx context.Context, userID int64, records []Record) (PutResult, error) {
	var res PutResult
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return res, err
	}
	defer tx.Rollback()

	var seq int64
	if err := tx.QueryRowContext(ctx, `SELECT value FROM counters WHERE name = 'seq'`).Scan(&seq); err != nil {
		return res, err
	}
	for _, r := range records {
		var stored string
		err := tx.QueryRowContext(ctx, `SELECT updated_at FROM records WHERE user_id = ? AND id = ?`, userID, r.ID).Scan(&stored)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			// new record
		case err != nil:
			return res, err
		default:
			if !newer(r, stored) {
				res.Ignored++
				continue
			}
		}
		seq++
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO records (user_id, id, kind, updated_at, data, seq) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (user_id, id) DO UPDATE SET kind = excluded.kind, updated_at = excluded.updated_at,
			  data = excluded.data, seq = excluded.seq`,
			userID, r.ID, r.Kind, r.UpdatedAt, string(r.Data), seq); err != nil {
			return res, err
		}
		res.Accepted++
	}
	if _, err := tx.ExecContext(ctx, `UPDATE counters SET value = ? WHERE name = 'seq'`, seq); err != nil {
		return res, err
	}
	return res, tx.Commit()
}

// newer reports whether r is later than the stored updatedAt.
func newer(r Record, stored string) bool {
	st, err := time.Parse(timeLayout, stored)
	if err != nil {
		return r.UpdatedAt > stored
	}
	return r.updated.After(st)
}

// Changes returns up to limit records of a user with seq > since, in seq
// order, each with its "seq" field. cursor is the seq of the last record
// returned (or since, if there are none). more is true if there are more.
func (s *Store) Changes(ctx context.Context, userID, since int64, limit int) (records []json.RawMessage, cursor int64, more bool, err error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT data, seq FROM records WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?`, userID, since, limit+1)
	if err != nil {
		return nil, 0, false, err
	}
	defer rows.Close()
	cursor = since
	records = []json.RawMessage{}
	for rows.Next() {
		if len(records) == limit {
			more = true
			break
		}
		var data string
		var seq int64
		if err := rows.Scan(&data, &seq); err != nil {
			return nil, 0, false, err
		}
		rec, err := withSeq([]byte(data), seq)
		if err != nil {
			return nil, 0, false, err
		}
		records = append(records, rec)
		cursor = seq
	}
	return records, cursor, more, rows.Err()
}

func isUniqueErr(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

// Backup writes a consistent copy of the database to path. It is safe to run
// while the server runs. The file at path must not exist.
func (s *Store) Backup(ctx context.Context, path string) error {
	_, err := s.db.ExecContext(ctx, `VACUUM INTO ?`, path)
	return err
}
