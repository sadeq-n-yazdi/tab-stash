# TODO

This file lists the work that is not complete. The items in each part are in
order of priority.

## 1. Checks to do by hand

The automatic tests did not do these checks. Do them in your usual Chrome.

- [ ] Push each keyboard shortcut on a web page: `Alt+Shift+S`, `Alt+Shift+D`,
      `Alt+Shift+E` and `Alt+Shift+M`. Make sure that each one does its action.
- [ ] In the popup, push `Alt+1`, `Alt+2` and `Alt+3`. On Linux, Chrome can use
      `Alt+1` to `Alt+8` to change tabs. If the popup does not get the keys,
      select different keys.
- [ ] Right-click a page and save it with the menu. Right-click a link and
      save it with the menu.
- [ ] Save a Chrome tab group with the popup. Make sure that the new group gets
      the same name and colour.
- [ ] Export the data on one computer and import it on a second computer.

## 2. Sync server

The design is in [docs/backend-api.md](docs/backend-api.md).

- [ ] Answer the questions in section 9 of the design:
  - the language and framework for the server
  - one user or more than one user
  - a local login, or single sign-on (for example OpenID Connect)
- [ ] Write the server: login, logout, `GET /sync` and `POST /sync`.
- [ ] Write the web page of the server: list, search, filter, edit and delete.
- [ ] Write the deployment instructions: reverse proxy, TLS certificate,
      backup of the database.
- [ ] Permit CORS only from `chrome-extension://icppdneajfbmmpkgejjpjfegkppmneej`.

## 3. Sync in the extension

- [ ] Add a "Server" part to the settings: server URL, user name and password.
- [ ] Ask for permission to the server URL at runtime
      (`optional_host_permissions`).
- [ ] Keep the token, the cursor and the list of changed records in
      `chrome.storage.local`.
- [ ] Do a sync after a change, every 15 minutes, and when the browser starts.
- [ ] Show the time of the last sync and the last sync error in the manager.
- [ ] Do not remove deleted records (`purgeDeleted`) before the server has them.

## 4. Improvements to the extension

- [ ] Let the user put the groups in a manual order.
- [ ] Let the user drag a bookmark to a different group.
- [ ] Add an option to discard tabs (`chrome.tabs.discard`) and not close them.
      Discarded tabs use less memory and stay in the tab strip.
- [ ] Show a warning before a save if the group already has many bookmarks
      with the same domain.
- [ ] Add an undo for **Delete** and **Restore**.
- [ ] Find old bookmarks (for example, older than 90 days) to help the user
      clean the shelf.
- [ ] Add keyboard navigation in the bookmark list of the manager (up, down,
      `Enter` to open).

## 5. Publication (optional)

- [ ] Make a 1280×800 screenshot for the Chrome Web Store.
- [ ] Write a privacy policy. The extension sends no data now, but sync will
      send data to the server of the user.
- [ ] Remove the `key` from `manifest.json` for the store upload. The store
      gives its own key. Then update the CORS origin of the server.
