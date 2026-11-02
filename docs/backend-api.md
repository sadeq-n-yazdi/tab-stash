# Tab Stash sync server: API design

Status: the API in section 5 is in `server/` (Go). The web page (section 8)
and the sync in the extension (section 6) are not done yet. To install the
server, refer to [server/README.md](../server/README.md).

## 1. Purpose

The sync server keeps your Tab Stash data on your own web server. With the
server, you can use the same stash in more than one browser and on more than one
computer. The server also has a web page. You can use this page in any browser
after you log in.

## 2. Requirements

1. The server accepts connections only with HTTPS (TLS 1.2 or later).
2. Each request, except the login request, must have a valid access token.
3. The server keeps the same records as the extension. The record format does
   not change. The format is in section 4.
4. Sync works in two directions. A change on one computer goes to the server.
   Then the server sends the change to the other computers.
5. A deletion also goes to the other computers.
6. If two computers change the same record, the newer change stays.
7. The extension works without the server. Sync is an option.

## 3. Architecture

```
 Chrome + Tab Stash ──┐
 Chrome + Tab Stash ──┼── HTTPS ──>  reverse proxy (TLS)  ──>  sync server  ──>  database
 Any browser (web UI) ┘
```

- The reverse proxy (for example nginx or Caddy) holds the TLS certificate.
- The sync server is one Go binary (`tab-stash-server`). It has the API in
  section 5. Later, it will also have the web page.
- The database is SQLite. One user has a small quantity of data.
- The server has more than one account. Each account has the role `user` or
  `admin` (section 5.7).

## 4. Records

The server uses the record format of the extension export file. A group has
these fields:

```json
{
  "id": "6f1c0c7e-6a43-4bd0-9a39-0f3f6f0e1b55",
  "kind": "group",
  "name": "Leisure reading",
  "note": "Articles to read in detail",
  "labels": ["learn", "deep-dive"],
  "color": "purple",
  "createdAt": "2026-11-02T09:00:00.000Z",
  "updatedAt": "2026-11-02T09:00:00.000Z",
  "deletedAt": null
}
```

A saved tab has these fields:

```json
{
  "id": "0b8f6d3e-2a8c-4a55-9a38-6c3c1e6b2f10",
  "kind": "bookmark",
  "groupId": "6f1c0c7e-6a43-4bd0-9a39-0f3f6f0e1b55",
  "title": "The Rust Programming Language",
  "url": "https://doc.rust-lang.org/book/",
  "note": "Read chapter 10 first",
  "labels": ["rust"],
  "color": "orange",
  "createdAt": "2026-11-02T09:00:00.000Z",
  "updatedAt": "2026-11-02T09:00:00.000Z",
  "deletedAt": null
}
```

Rules for records:

- `color` is one of: `grey`, `blue`, `red`, `yellow`, `green`, `pink`,
  `purple`, `cyan`, `orange`.
- The client makes the `id`. The `id` is a UUID.
- All times are ISO 8601 UTC strings.
- The server adds one field, `seq`. This is an integer that increases by 1 for
  each change on the server. The client uses `seq` as a cursor.

## 5. API

The base path is `/api/v1`. All bodies are JSON. All times are UTC.

### 5.1 Log in

`POST /api/v1/auth/login`

Request:

```json
{ "username": "sadeq", "password": "…", "client": "Chrome on laptop" }
```

Response `200`:

```json
{ "token": "…", "expiresAt": "2027-02-02T09:00:00.000Z" }
```

Errors: `401` if the user name or the password is not correct. `429` if there
are too many tries.

The `client` field is a name for the device. The web page shows it in the list
of active logins.

### 5.2 Log out

`POST /api/v1/auth/logout`

The server deletes the token of the request. Response: `204`.

### 5.3 Get changes

`GET /api/v1/sync?since=<seq>`

The server sends all records with a `seq` that is more than `since`. The
response includes deleted records. For the first sync, use `since=0`.

Response `200`:

```json
{
  "records": [ { "…": "…", "seq": 41 }, { "…": "…", "seq": 42 } ],
  "cursor": 42,
  "more": false
}
```

If `more` is `true`, send the request again with `since=<cursor>`. The server
sends a maximum of 500 records in one response.

### 5.4 Send changes

`POST /api/v1/sync`

Request:

```json
{ "records": [ { "id": "…", "kind": "bookmark", "…": "…" } ] }
```

The server does these steps for each record:

1. It checks the record. If the record is not correct, the server adds it to `rejected`.
2. If the server has no record with this `id`, it adds the record.
3. If the `updatedAt` of the new record is later than the `updatedAt` on the server, it replaces the record.
4. If not, it keeps the record that it has.
5. If it adds or replaces a record, it gives the record a new `seq`.

Response `200`:

```json
{ "accepted": 12, "ignored": 1, "rejected": [ { "id": "…", "error": "color is not valid" } ] }
```

A maximum of 500 records can be in one request.

The response has no cursor. Other computers can send changes at the same
time. If the client used a cursor from this response, it could miss these
changes. Thus, after `POST /sync`, the client gets the changes with
`GET /sync?since=<cursor>`, with the cursor of the last `GET`.

Only an account with the role `user` can use `GET /sync` and `POST /sync`.
An `admin` account gets `403`.

### 5.5 Change the password

`POST /api/v1/auth/password`

Request:

```json
{ "current": "…", "new": "…" }
```

The new password must have 10 or more characters. The server logs out all
other devices of the account. The token of this request stays valid.
Response: `204`.

Errors: `403` if the current password is not correct. `400` if the new
password is too short.

### 5.6 Errors

All errors have this body:

```json
{ "error": "invalid_token", "message": "The token is not valid or it expired." }
```

| Status | Meaning |
| ------ | ------- |
| 400 | The request is not correct. |
| 401 | There is no token, or the token is not valid or expired. Log in again. |
| 403 | The account cannot use this path (for example, an admin on `/sync`). |
| 404 | The path or the account does not exist. |
| 409 | The user name is already in use. |
| 413 | The request has too many records. |
| 429 | Too many requests. Wait, then try again. |
| 503 | The server is busy. Wait some seconds, then try again. |

### 5.7 Accounts (admin)

An account with the role `admin` can manage the user accounts. An admin
cannot read or write records. An admin cannot set the password of an
account that exists, because the admin could then log in as the user.

| Request | Action | Response |
| ------- | ------ | -------- |
| `GET /api/v1/admin/users` | List the accounts. | `200` `{ "users": [ { "username": "…", "role": "user", "createdAt": "…" } ] }` |
| `POST /api/v1/admin/users` | Add a user account. Body: `{ "username": "…", "password": "…" }`. | `201` |
| `DELETE /api/v1/admin/users/{username}` | Delete a user account with all its records. | `204` |

- A user name has 1 to 64 letters, digits, `.`, `_`, `-` or `@`.
- The API adds only accounts with the role `user`.
- The API cannot delete an `admin` account. Use the command line on the
  server to add or delete an admin account.
- An account with the role `user` gets `403` on these paths.

### 5.8 Health and version

`GET /healthz` needs no token.

Response `200`:

```json
{ "status": "ok", "version": "0.2.0", "commit": "<git commit>" }
```

`version` is the version of the release. `commit` is the git commit of the
binary. A development build shows the version `dev`. If the commit is not
known, the server shows `unknown`.

## 6. Sync in the extension

These changes to the extension are necessary:

1. Add a "Server" part to the settings: the server URL, the user name and the password.
2. Ask for permission to the server URL at runtime. Use `optional_host_permissions`.
   Thus, the extension does not ask for access to all sites.
3. After the login, keep the token in `chrome.storage.local`. Do not keep the password.
4. Keep these values in `chrome.storage.local`:
   - `sync.cursor`: the last `cursor` from the server.
   - `sync.pending`: the IDs of the records that changed after the last sync.
5. Do a sync at these times:
   - 10 seconds after a change, with `chrome.alarms`.
   - Every 15 minutes, with `chrome.alarms`.
   - When the browser starts.
6. For each sync, do these steps:
   1. Send the changed records with `POST /sync`.
   2. Get the changes with `GET /sync?since=<cursor>`.
   3. Merge the changes with `mergeRecords` in `extension/lib/model.js`. Write them with the store.
   4. Keep the new cursor. Clear `sync.pending`.
7. Do not remove deleted records (`purgeDeleted`) before the server has them.

The store already writes each record under its own key and sets `updatedAt`
on each change. The store needs no other change for sync.

## 7. Security

- Use HTTPS only. Set `Strict-Transport-Security` on all responses. Behind a
  proxy, the proxy sets it. The server sets it only when it uses its own TLS.
- Keep passwords only as Argon2id hashes. Each hash has its own random salt.
- Use a secret salt for the whole server (`TAB_STASH_PASSWORD_SALT`) in the
  settings file, not in the database. Send the password through HMAC-SHA256
  with this secret before Argon2id.
- Make tokens with 32 random bytes. Keep only a SHA-256 hash of each token in the
  database.
- Make tokens expire after 90 days. Let the user delete a token from the web page.
- Limit the login tries to 5 for each minute for each IP address. For IPv6,
  use the /64 network. Also limit the tries to 10 for each minute for each
  user name.
- For the API, permit CORS only from the extension origin
  (`chrome-extension://<extension-id>`). Send the token in the
  `Authorization: Bearer <token>` header, not in a cookie.
- For the web page, use a session cookie with the `Secure`, `HttpOnly` and
  `SameSite=Strict` attributes.
- Do not show a saved URL as HTML. Show it only as text, or in an `href` with
  the `http` or `https` scheme. Do not make a link for a `javascript:` URL.
- Do not write tokens, passwords or URLs to the server logs.

## 8. Web page

After a login, the web page shows the same data as the manager page of the
extension:

- groups, saved tabs, notes, labels and colours
- search, label filter and colour filter
- edit and delete

The web page cannot close or group the tabs of a browser. It opens a saved tab
as a usual link. "Open all" opens each saved tab in a new browser tab.

## 9. Decisions

1. The server is in Go. It is one binary with SQLite (`modernc.org/sqlite`,
   no C compiler necessary).
2. The server has more than one account. An `admin` account manages the
   accounts and cannot read the records.
3. The extension uses the login of the server. Single sign-on is not
   necessary now.
