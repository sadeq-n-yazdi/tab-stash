// Command tab-stash-server is the sync server for the Tab Stash extension.
//
// All commands accept "-config <file>": a settings file with KEY=VALUE
// lines (the same names as the environment variables, for example
// TAB_STASH_DB). Flags win over environment variables, and environment
// variables win over the settings file.
//
//	tab-stash-server serve  [flags]          start the HTTP server
//	tab-stash-server user add [-admin] <name> add an account (asks for the password)
//	tab-stash-server user passwd <name>      change a password (logs out all devices)
//	tab-stash-server user delete <name>      delete a user and all of the user's data
//	tab-stash-server user list               list users
//	tab-stash-server user tokens <name>      list the active logins of a user
//	tab-stash-server gen-salt                make a secret salt for the settings file
//	tab-stash-server version                 show the version
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"

	"github.com/sadeq-n-yazdi/tab-stash/server/internal/api"
	"github.com/sadeq-n-yazdi/tab-stash/server/internal/auth"
	"github.com/sadeq-n-yazdi/tab-stash/server/internal/store"
)

// version is set at build time: -ldflags "-X main.version=1.2.3".
var version = "dev"

const (
	defaultDB     = "tab-stash.db"
	defaultAddr   = "127.0.0.1:8080"
	defaultOrigin = "chrome-extension://icppdneajfbmmpkgejjpjfegkppmneej"
)

func main() {
	args, err := loadConfig(os.Args[1:])
	if err == nil {
		// The secret salt of the server (a "pepper"): see internal/auth.
		err = auth.SetPepper(os.Getenv("TAB_STASH_PASSWORD_SALT"))
	}
	if err == nil {
		err = run(args)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `Usage:
  tab-stash-server serve [flags]          Start the HTTP server
  tab-stash-server user add [-admin] <name>
                                          Add a user (or an admin) account
  tab-stash-server user passwd <name>     Change the password of a user
  tab-stash-server user delete <name>     Delete a user and all data of the user
  tab-stash-server user list              List the users
  tab-stash-server user tokens <name>     List the active logins of a user
  tab-stash-server backup <new-file>      Copy the database to a new file
  tab-stash-server gen-salt               Make a value for TAB_STASH_PASSWORD_SALT
  tab-stash-server version                Show the version

All commands accept "-config <file>", a settings file with KEY=VALUE lines.
Run "tab-stash-server serve -h" or "tab-stash-server user -h" for the flags.
`)
}

// loadConfig removes "-config <file>" (or "-config=<file>") from args and
// reads the file. Without the flag, it reads $TAB_STASH_CONFIG if it is set.
// Each "KEY=VALUE" line sets the environment variable KEY, if it is not
// already set. Empty lines and lines that start with "#" are ignored.
func loadConfig(args []string) ([]string, error) {
	path := os.Getenv("TAB_STASH_CONFIG")
	var rest []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-config" || a == "--config":
			if i+1 >= len(args) {
				return nil, errors.New("-config needs a file name")
			}
			path = args[i+1]
			i++
		case strings.HasPrefix(a, "-config=") || strings.HasPrefix(a, "--config="):
			path = a[strings.Index(a, "=")+1:]
		default:
			rest = append(rest, a)
		}
	}
	if path == "" {
		return rest, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read the settings file: %w", err)
	}
	for n, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !ok || !strings.HasPrefix(key, "TAB_STASH_") {
			return nil, fmt.Errorf("%s line %d: use KEY=VALUE with a TAB_STASH_ name", path, n+1)
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
			value = value[1 : len(value)-1]
		}
		if _, set := os.LookupEnv(key); !set {
			os.Setenv(key, value)
		}
	}
	return rest, nil
}

func run(args []string) error {
	if len(args) == 0 {
		usage()
		return errors.New("no command")
	}
	switch args[0] {
	case "serve":
		return serve(args[1:])
	case "user":
		return user(args[1:])
	case "backup":
		return backup(args[1:])
	case "gen-salt":
		salt, err := auth.NewPepper()
		if err != nil {
			return err
		}
		fmt.Println(salt)
		return nil
	case "version", "--version", "-v":
		fmt.Println(version)
		return nil
	case "help", "-h", "--help":
		usage()
		return nil
	default:
		usage()
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

// ---------- serve ----------

func serve(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fs.String("addr", envOr("TAB_STASH_ADDR", defaultAddr), "address to listen on (env TAB_STASH_ADDR)")
	dbPath := fs.String("db", envOr("TAB_STASH_DB", defaultDB), "SQLite database file (env TAB_STASH_DB)")
	origins := fs.String("allow-origin", envOr("TAB_STASH_ALLOW_ORIGIN", defaultOrigin),
		"comma-separated browser origins that can call the API (env TAB_STASH_ALLOW_ORIGIN)")
	tlsCert := fs.String("tls-cert", os.Getenv("TAB_STASH_TLS_CERT"), "TLS certificate file; use with -tls-key (env TAB_STASH_TLS_CERT)")
	tlsKey := fs.String("tls-key", os.Getenv("TAB_STASH_TLS_KEY"), "TLS private key file (env TAB_STASH_TLS_KEY)")
	ipHeader := fs.String("client-ip-header", os.Getenv("TAB_STASH_CLIENT_IP_HEADER"),
		"header with the client address, for example X-Real-IP; use only behind a reverse proxy that sets it (env TAB_STASH_CLIENT_IP_HEADER)")
	publicURL := fs.String("public-url", os.Getenv("TAB_STASH_PUBLIC_URL"),
		"address of the server for its users, for example https://tabs.example.com/ (env TAB_STASH_PUBLIC_URL)")
	tokenDays := fs.Int("token-days", 90, "lifetime of a login token in days")
	_ = fs.Parse(args)

	if (*tlsCert == "") != (*tlsKey == "") {
		return errors.New("use -tls-cert and -tls-key together")
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if !auth.HasPepper() {
		logger.Warn("TAB_STASH_PASSWORD_SALT is not set; set it to the output of \"tab-stash-server gen-salt\"")
	}
	if *tlsCert == "" && !isLoopback(*addr) {
		logger.Warn("the server listens on a public address without TLS; put an HTTPS reverse proxy in front of it", "addr", *addr)
	}

	st, err := store.Open(*dbPath)
	if err != nil {
		return err
	}
	defer st.Close()

	handler := api.New(st, api.Config{
		AllowedOrigins: strings.Split(*origins, ","),
		TokenTTL:       time.Duration(*tokenDays) * 24 * time.Hour,
		ClientIPHeader: *ipHeader,
		PublicURL:      *publicURL,
		Logger:         logger,
	})
	srv := &http.Server{
		Addr:              *addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go cleanTokens(ctx, st, logger)

	errc := make(chan error, 1)
	go func() {
		logger.Info("tab-stash-server started", "version", version, "addr", *addr, "db", *dbPath, "tls", *tlsCert != "", "public_url", *publicURL)
		if *tlsCert != "" {
			errc <- srv.ListenAndServeTLS(*tlsCert, *tlsKey)
		} else {
			errc <- srv.ListenAndServe()
		}
	}()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	logger.Info("stopping")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

func cleanTokens(ctx context.Context, st *store.Store, logger *slog.Logger) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		if n, err := st.DeleteExpiredTokens(ctx); err != nil && ctx.Err() == nil {
			logger.Error("delete expired tokens", "error", err)
		} else if n > 0 {
			logger.Info("deleted expired tokens", "count", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func isLoopback(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// ---------- backup ----------

func backup(args []string) error {
	fs := flag.NewFlagSet("backup", flag.ExitOnError)
	dbPath := fs.String("db", envOr("TAB_STASH_DB", defaultDB), "SQLite database file (env TAB_STASH_DB)")
	_ = fs.Parse(args)
	if fs.NArg() != 1 {
		return errors.New("backup needs exactly one output file")
	}
	out := fs.Arg(0)
	if _, err := os.Stat(out); err == nil {
		return fmt.Errorf("%s already exists", out)
	}
	st, err := store.Open(*dbPath)
	if err != nil {
		return err
	}
	defer st.Close()
	if err := st.Backup(context.Background(), out); err != nil {
		return err
	}
	fmt.Printf("Database copied to %s.\n", out)
	return nil
}

// ---------- user ----------

func user(args []string) error {
	fs := flag.NewFlagSet("user", flag.ExitOnError)
	dbPath := fs.String("db", envOr("TAB_STASH_DB", defaultDB), "SQLite database file (env TAB_STASH_DB)")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: tab-stash-server user [-db file] add [-admin]|passwd|delete|list|tokens [name]")
		fs.PrintDefaults()
	}
	_ = fs.Parse(args)
	rest := fs.Args()
	if len(rest) == 0 {
		fs.Usage()
		return errors.New("no user command")
	}
	cmd, rest := rest[0], rest[1:]
	role := store.RoleUser
	if cmd == "add" && len(rest) > 0 && (rest[0] == "-admin" || rest[0] == "--admin") {
		role, rest = store.RoleAdmin, rest[1:]
	}
	needName := cmd != "list"
	if needName && len(rest) != 1 {
		return fmt.Errorf("user %s needs exactly one user name", cmd)
	}
	name := ""
	if needName {
		name = strings.TrimSpace(rest[0])
		if name == "" {
			return errors.New("the user name is empty")
		}
	}

	st, err := store.Open(*dbPath)
	if err != nil {
		return err
	}
	defer st.Close()
	ctx := context.Background()

	switch cmd {
	case "add":
		hash, err := askPassword()
		if err != nil {
			return err
		}
		if err := st.CreateUser(ctx, name, hash, role); errors.Is(err, store.ErrExists) {
			return fmt.Errorf("user %q already exists", name)
		} else if err != nil {
			return err
		}
		fmt.Printf("Account %q (%s) added.\n", name, role)
	case "passwd":
		hash, err := askPassword()
		if err != nil {
			return err
		}
		if err := st.SetPassword(ctx, name, hash); errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("user %q does not exist", name)
		} else if err != nil {
			return err
		}
		fmt.Printf("Password of %q changed. All devices of the user must log in again.\n", name)
	case "delete":
		if err := st.DeleteUser(ctx, name, ""); errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("user %q does not exist", name)
		} else if err != nil {
			return err
		}
		fmt.Printf("User %q and all data of the user deleted.\n", name)
	case "list":
		users, err := st.ListUsers(ctx)
		if err != nil {
			return err
		}
		for _, u := range users {
			fmt.Printf("%s\t%s\tcreated %s\n", u.Username, u.Role, u.CreatedAt)
		}
	case "tokens":
		tokens, err := st.ListTokens(ctx, name)
		if err != nil {
			return err
		}
		for _, t := range tokens {
			fmt.Printf("%s\tlast used %s\texpires %s\n", t.Client, t.LastUsedAt, t.ExpiresAt)
		}
	default:
		return fmt.Errorf("unknown user command %q", cmd)
	}
	return nil
}

// askPassword reads a new password: twice from a terminal, or one line from
// standard input when it is not a terminal (for scripts).
func askPassword() (string, error) {
	var password string
	fd := int(os.Stdin.Fd())
	if term.IsTerminal(fd) {
		fmt.Fprint(os.Stderr, "Password: ")
		p1, err := term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return "", err
		}
		fmt.Fprint(os.Stderr, "Password again: ")
		p2, err := term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return "", err
		}
		if string(p1) != string(p2) {
			return "", errors.New("the two passwords are not the same")
		}
		password = string(p1)
	} else {
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return "", err
		}
		password = strings.TrimRight(line, "\r\n")
	}
	if err := auth.CheckNewPassword(password); err != nil {
		return "", err
	}
	return auth.HashPassword(password)
}
