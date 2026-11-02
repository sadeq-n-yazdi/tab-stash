# Tab Stash sync server

`tab-stash-server` keeps the Tab Stash data of one or more users on your own
server. It is one Go binary with an SQLite database. It needs no C compiler
and no other service.

The API is in [../docs/backend-api.md](../docs/backend-api.md).

## Contents

1. [What the server does](#what-the-server-does)
2. [Accounts and roles](#accounts-and-roles)
3. [Build the server](#build-the-server)
4. [Settings](#settings)
5. [Install on a Linux server](#install-on-a-linux-server)
6. [Put a reverse proxy in front of the server](#put-a-reverse-proxy-in-front-of-the-server)
7. [Manage the accounts](#manage-the-accounts)
8. [Make a backup](#make-a-backup)
9. [Update the server](#update-the-server)
10. [Commands](#commands)
11. [Security](#security)
12. [Development](#development)

## What the server does

- It keeps the groups and the bookmarks of each user. Each user sees only
  the records of that user.
- It has a login with a user name and a password. A login gives a token.
  The extension sends the token with each request.
- It keeps the newest version of each record. The `updatedAt` time of the
  record tells which version is the newest.
- It gives each change a sequence number (`seq`). A computer asks for all
  changes after the last number that it has.
- It keeps deleted records, so that other computers also delete them.

The server does not have a web page yet. The extension does not use the
server yet. Refer to [../TODO.md](../TODO.md).

## Accounts and roles

There are two roles:

| Role | Can do | Cannot do |
| ---- | ------ | --------- |
| `user` | Sync its own groups and bookmarks. Change its own password. | Read the records of other users. Use the admin API. |
| `admin` | Add user accounts, list the accounts, delete user accounts. | Read or write records. Set the password of an account that exists. Add or delete admin accounts. |

An admin sets only the first password of a new user. The user then changes
it with `POST /api/v1/auth/password`. Thus the admin does not know the
password of the user, and cannot log in as the user.

The roles do not limit a person with root access to the server. They also do not
limit a person with a copy of the database file and the settings file.

## Build the server

You need Go 1.27 or later.

```sh
cd server
go test ./...
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=0.1.0" \
  -o bin/tab-stash-server ./cmd/tab-stash-server
```

To build for a different system, set `GOOS` and `GOARCH`. For example, for a
64-bit ARM server:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "-s -w" \
  -o bin/linux-arm64/tab-stash-server ./cmd/tab-stash-server
```

## Settings

The server reads its settings from environment variables. You can also put
the settings in a file with `KEY=VALUE` lines:

- systemd reads the file with `EnvironmentFile=`.
- All commands read the file with the option `-config <file>`.

A flag on the command line has priority over an environment variable. An
environment variable has priority over the settings file.

The example file is [deploy/tab-stash.env.example](deploy/tab-stash.env.example).

| Setting | Default | Meaning |
| ------- | ------- | ------- |
| `TAB_STASH_PASSWORD_SALT` | (empty) | The secret salt of the password hashes: 64 or more characters from `[a-zA-Z.-]`. Make it with `tab-stash-server gen-salt`. Refer to [Security](#security). |
| `TAB_STASH_PUBLIC_URL` | (empty) | The address of the server for its users. The server shows it on its home page. |
| `TAB_STASH_DB` | `tab-stash.db` | The database file. |
| `TAB_STASH_ADDR` | `127.0.0.1:8080` | The address and the port that the server listens on. |
| `TAB_STASH_CLIENT_IP_HEADER` | (empty) | The request header that has the client address, for example `X-Real-IP`. Set it only behind a reverse proxy that sets this header. |
| `TAB_STASH_ALLOW_ORIGIN` | the origin of the extension | The browser origins that can call the API. Separate more than one origin with commas. |
| `TAB_STASH_TLS_CERT`, `TAB_STASH_TLS_KEY` | (empty) | A certificate and a key, for HTTPS without a reverse proxy. |
| `TAB_STASH_CONFIG` | (empty) | The settings file, if you do not use `-config`. |

Do not put the settings file in git. It has the secret salt.

## Install on a Linux server

This procedure uses systemd. Do the steps as root on the server.

1. Copy the binary to the server. Then install it:

   ```sh
   install -m 0755 tab-stash-server /usr/local/bin/tab-stash-server
   ```

2. Make a system user and the folders:

   ```sh
   useradd --system --home-dir /var/lib/tab-stash --no-create-home \
     --shell /usr/sbin/nologin tab-stash
   install -d -o tab-stash -g tab-stash -m 0750 /var/lib/tab-stash
   install -d -o root -g tab-stash -m 0750 /etc/tab-stash
   ```

3. Copy `deploy/tab-stash.env.example` to `/etc/tab-stash/tab-stash.env`.
   Change the values.
4. Make the secret salt and add it to the settings file:

   ```sh
   echo "TAB_STASH_PASSWORD_SALT=$(tab-stash-server gen-salt)" >> /etc/tab-stash/tab-stash.env
   ```

   Remove the empty `TAB_STASH_PASSWORD_SALT=` line of the example.
   Keep a copy of the value in a safe place.
5. Set the permissions of the settings file:

   ```sh
   chown root:tab-stash /etc/tab-stash/tab-stash.env
   chmod 0640 /etc/tab-stash/tab-stash.env
   ```

6. Install the service and start it:

   ```sh
   install -m 0644 tab-stash-server.service /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now tab-stash-server
   ```

7. Make sure that the server runs:

   ```sh
   systemctl status tab-stash-server
   curl http://127.0.0.1:8080/healthz
   ```

   The answer is `{"status":"ok"}`.

8. Add the first admin account. The command asks for the password two times:

   ```sh
   runuser -u tab-stash -- tab-stash-server -config /etc/tab-stash/tab-stash.env user add -admin admin
   ```

The unit file is [deploy/tab-stash-server.service](deploy/tab-stash-server.service).
It limits the memory to 96 MB and it limits the access of the service to the
system.

## Put a reverse proxy in front of the server

The server listens on a loopback address. A reverse proxy gives HTTPS to the
clients and sends the requests to the server.

The proxy must set the header with the client address on each request. The
server uses this address for the limit of login tries. Set
`TAB_STASH_CLIENT_IP_HEADER` to the name of this header.

- **Caddy.** Caddy gets the certificate automatically. Use
  [deploy/Caddyfile](deploy/Caddyfile).
- **nginx.** Get a certificate, for example with certbot. Use
  [deploy/nginx.conf](deploy/nginx.conf).
- **Cloudflare proxy.** Set the SSL/TLS mode of the host name to
  **Full (strict)**. With the **Flexible** mode, Cloudflare connects to the
  server with HTTP. The redirect to HTTPS then makes a loop.

The body of a sync request can be large. Permit request bodies of 16 MB or
more on the proxy.

## Manage the accounts

Use the command line on the server for all accounts:

```sh
C="-config /etc/tab-stash/tab-stash.env"
runuser -u tab-stash -- tab-stash-server $C user add alice          # add a user
runuser -u tab-stash -- tab-stash-server $C user add -admin root    # add an admin
runuser -u tab-stash -- tab-stash-server $C user list               # list the accounts
runuser -u tab-stash -- tab-stash-server $C user passwd alice       # set a new password
runuser -u tab-stash -- tab-stash-server $C user tokens alice       # list the logins
runuser -u tab-stash -- tab-stash-server $C user delete alice       # delete an account and its data
```

If the shell does not split `$C` into words (for example zsh), write the
option in full.

The commands ask for the password on the terminal. In a script, send the
password on standard input:

```sh
printf '%s\n' "$PASSWORD" | tab-stash-server $C user add alice
```

A password must have 10 or more characters. `user passwd` logs out all
devices of the account.

An admin can also add, list and delete user accounts with the API. Refer to
section 5.7 of [../docs/backend-api.md](../docs/backend-api.md).

## Make a backup

You can make a backup while the server runs:

```sh
runuser -u tab-stash -- tab-stash-server -config /etc/tab-stash/tab-stash.env \
  backup /var/lib/tab-stash/backup-$(date +%F).db
```

The output file must not exist. Copy the backup file to a different
computer.

Keep a copy of the settings file too. Without the secret salt, the
passwords in the backup do not work.

To restore a backup, do these steps:

1. Stop the server: `systemctl stop tab-stash-server`.
2. Copy the backup file to the `TAB_STASH_DB` path. Remove the `-wal` and
   `-shm` files of the old database.
3. Set the owner: `chown tab-stash:tab-stash /var/lib/tab-stash/tab-stash.db`.
4. Start the server: `systemctl start tab-stash-server`.

## Update the server

1. Build the new binary.
2. Copy it to the server, then install it with
   `install -m 0755 tab-stash-server /usr/local/bin/tab-stash-server`.
3. Restart the server: `systemctl restart tab-stash-server`.

The server updates the database format when it starts. Make a backup before
an update.

## Commands

| Command | Action |
| ------- | ------ |
| `serve` | Start the HTTP server. Run `tab-stash-server serve -h` for the flags. |
| `user add [-admin] <name>` | Add an account. |
| `user passwd <name>` | Set a new password. All devices of the account must log in again. |
| `user delete <name>` | Delete an account with all its data. |
| `user list` | List the accounts and their roles. |
| `user tokens <name>` | List the logins of an account. |
| `backup <new-file>` | Copy the database to a new file. |
| `gen-salt` | Show a new secret salt: 64 random characters from `[a-zA-Z.-]`. |
| `version` | Show the version. |

All commands accept `-config <file>`.

## Security

- **Passwords.** The server keeps only Argon2id hashes (19 MiB, 2 passes).
  Each hash has its own random salt of 16 bytes.
- **Secret salt.** The server also has one secret salt
  (`TAB_STASH_PASSWORD_SALT`). The password goes through HMAC-SHA256 with this
  secret before Argon2id. The secret is in the settings file, not in the
  database. Thus a copy of the database alone is not enough to guess
  passwords.
  - Each hash has a `keyid`, which identifies the secret.
  - A hash without a `keyid` still works. The server makes it again with
    the secret at the next correct login.
  - If you change or lose the secret, no password works. Then set a new
    password for each account with `user passwd`.
- **Tokens.** A token has 32 random bytes. The server keeps only the
  SHA-256 hash of a token. A token expires after 90 days.
- **Login limit.** The server permits 5 failed logins in each minute for
  each client address (for IPv6, each /64 network). It also permits 10
  failed logins in each minute for each user name. Two password checks
  can run at the same time. A request that waits more than 5 seconds gets
  the status 503.
- **CORS.** Browsers can call the API only from the origins in
  `TAB_STASH_ALLOW_ORIGIN`.
- **Headers.** All responses have `Strict-Transport-Security`,
  `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` and
  `Cache-Control: no-store`.
- **Logs.** The server does not write tokens, passwords or URLs to the logs.

## Development

```sh
cd server
go vet ./...
go test ./...
go run ./cmd/tab-stash-server serve -db /tmp/dev.db
```

| Folder | Contents |
| ------ | -------- |
| `cmd/tab-stash-server` | The commands. |
| `internal/api` | The HTTP API, the login limit and the middleware. |
| `internal/auth` | The password hashes, the secret salt and the tokens. |
| `internal/store` | The SQLite database, the record checks and the sync logic. |
| `deploy` | Examples: systemd unit, settings file, Caddy and nginx. |
