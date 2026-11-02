# Tab Stash: how to install, update and move

This document tells you how to install Tab Stash on a new computer. It also
tells you how to move your saved tabs, update the extension, and remove it.

For the use of the extension, read [README.md](README.md).

## Contents

1. [Requirements](#1-requirements)
2. [Get the files](#2-get-the-files)
3. [Install the extension](#3-install-the-extension)
4. [Make sure that the extension works](#4-make-sure-that-the-extension-works)
5. [Move your saved tabs to a different computer](#5-move-your-saved-tabs-to-a-different-computer)
6. [Update the extension](#6-update-the-extension)
7. [Remove the extension](#7-remove-the-extension)
8. [Troubleshooting](#8-troubleshooting)
9. [Install the development tools (optional)](#9-install-the-development-tools-optional)

## 1. Requirements

| Item | Requirement |
| ---- | ----------- |
| Browser | Google Chrome 116 or later. Chromium 116 or later also works. |
| Operating system | Linux, macOS or Windows. |
| Git | Optional. You can download a ZIP file of the files. |
| Node.js | Not necessary to use the extension. Node.js 20 or later is necessary only for the tests. |

NOTE: The author tested the extension in Chromium 156 on Linux. Other browsers
that use Chromium (for example Microsoft Edge or Brave) can also load the
extension. The author did not test them.

## 2. Get the files

Use one of the two procedures that follow.

### 2.1 With Git

1. Open a terminal.
2. Go to the folder where you want to keep the extension. For example:

   ```sh
   cd ~/apps
   ```

3. Clone the repository:

   ```sh
   git clone https://github.com/sadeq-n-yazdi/my-tab-stash.git
   ```

The extension is in the `my-tab-stash/extension` folder.

### 2.2 Without Git

1. Go to <https://github.com/sadeq-n-yazdi/my-tab-stash>.
2. Click **Code**.
3. Click **Download ZIP**.
4. Extract the ZIP file into a folder where you want to keep the extension.

The extension is in the `extension` folder of the extracted files.

CAUTION: KEEP THE FILES IN THIS FOLDER AFTER THE INSTALLATION. CHROME LOADS THE
EXTENSION FROM THIS FOLDER EACH TIME THAT IT STARTS. IF YOU DELETE THE FOLDER,
THE EXTENSION STOPS.

## 3. Install the extension

1. Start Chrome.
2. Type `chrome://extensions` in the address bar.
3. Push `Enter`.
4. Set **Developer mode** to on. The switch is at the top right of the page.
5. Click **Load unpacked**.
6. Select the `extension` folder. Select the folder that contains the
   `manifest.json` file, not the folder above it.
7. Make sure that the **Tab Stash** card shows on the page.
8. Make sure that the ID on the card is `icppdneajfbmmpkgejjpjfegkppmneej`.
9. Click the puzzle icon in the toolbar.
10. Click the pin icon near **Tab Stash**. The Tab Stash icon shows in the toolbar.

The extension ID is the same on all computers, because `manifest.json` has a
fixed `key`. Thus, the location of the folder has no effect on the ID.

## 4. Make sure that the extension works

1. Open a web page, for example <https://example.com>.
2. Push `Alt+Shift+S`. The Tab Stash popup opens.
3. Make sure that **Group** shows "Inbox".
4. Push `Enter`. The tab closes.
5. Push `Alt+Shift+M`. The manager page opens.
6. Make sure that the manager page shows the page from step 1.
7. Click **Restore**. The page opens again.
8. Look at the **Shortcuts** part of the manager page. Make sure that each
   shortcut shows a key.

If a shortcut shows "not set", another extension or Chrome uses the same keys.
Do the procedure in [Shortcuts show "not set"](#shortcuts-show-not-set).

## 5. Move your saved tabs to a different computer

The extension keeps the saved tabs only in the Chrome profile on one computer.
Chrome does not sync them. Use export and import to move them.

On the old computer:

1. Open the manager page (`Alt+Shift+M`).
2. Click **Export**.
3. Chrome downloads a file with the name `tab-stash-YYYY-MM-DD.json`.
4. Copy the file to the new computer. For example, use a USB drive or your
   cloud storage.

On the new computer:

1. Install the extension. Do the procedures in sections 2 and 3.
2. Open the manager page (`Alt+Shift+M`).
3. Click **Import**.
4. Select the file from the old computer.
5. Make sure that the status line shows the number of imported groups and
   bookmarks.

You can import the same file again. The import does not make duplicates. If a
record is on the computer and also in the file, the import keeps the newer
record.

NOTE: The export file contains the URLs, titles and notes of your saved tabs.
Keep the file in a safe location.

## 6. Update the extension

CAUTION: EXPORT YOUR SAVED TABS BEFORE YOU UPDATE. AN ERROR IN A NEW VERSION
CAN CAUSE A LOSS OF DATA.

1. Export your saved tabs. Do the steps "On the old computer" in section 5.
2. Get the new files:
   - If you used Git, open a terminal in the `my-tab-stash` folder and type:

     ```sh
     git pull
     ```

   - If you used a ZIP file, download the new ZIP file. Replace the old files
     with the new files. Use the same folder.
3. Go to `chrome://extensions`.
4. Find the **Tab Stash** card. Click the reload icon (↻) on the card.

The update keeps your saved tabs, because the extension ID does not change.

## 7. Remove the extension

WARNING: EXPORT YOUR SAVED TABS BEFORE YOU REMOVE THE EXTENSION. CHROME
DELETES ALL SAVED TABS WHEN IT REMOVES THE EXTENSION. YOU CANNOT GET THEM BACK.

1. Export your saved tabs. Do the steps "On the old computer" in section 5.
2. Go to `chrome://extensions`.
3. Find the **Tab Stash** card. Click **Remove**.
4. Optional: delete the folder of the extension.

## 8. Troubleshooting

### Chrome shows "Manifest file is missing or unreadable"

You selected the wrong folder. Click **Load unpacked** again. Select the
`extension` folder, which contains `manifest.json`.

### The extension stops after a restart of Chrome

Chrome cannot find the folder of the extension. Make sure that the folder is
at the same location as at the installation. If you moved the folder, do these
steps:

1. Go to `chrome://extensions`.
2. Remove the **Tab Stash** card.
3. Click **Load unpacked** and select the folder at its new location.

Chrome keeps the data under the extension ID, and the ID does not change. But
if you click **Remove**, Chrome deletes the data. Thus, if the extension still
opens, export your saved tabs before you remove the card.

### Shortcuts show "not set"

1. Go to `chrome://extensions/shortcuts`.
2. Find **Tab Stash**.
3. Click the pencil icon near the shortcut.
4. Push a different key combination. Use `Alt+Shift` or `Ctrl+Shift` and a
   letter.

NOTE: Chromium does not accept some keys, because it uses them. For example,
Chromium 156 does not accept `Alt+Shift+W`, `Alt+Shift+A`, `Alt+Shift+C`,
`Alt+Shift+P`, `Alt+Shift+X` and `Alt+Shift+Z`.

### The icon shows a red "!"

An error occurred. Put the mouse pointer on the icon to read the error. For
more data, do these steps:

1. Go to `chrome://extensions`.
2. On the **Tab Stash** card, click **service worker**.
3. Read the messages in the **Console** tab.

### A saved tab does not open

Chrome does not let an extension open some URLs, for example `file://` URLs
and some `chrome://` URLs. The manager shows "can fail to open" for these URLs.
Copy the URL from the **Edit** window and paste it into the address bar.

### Chrome shows "Disable developer mode extensions"

Chrome can show this message when it starts. Click the close button (✕). Do
not click **Disable**. If you click **Disable**, go to `chrome://extensions`
and set the switch on the **Tab Stash** card to on.

## 9. Install the development tools (optional)

Do this procedure only if you want to change the code or run the tests.

1. Install Node.js 20 or later from <https://nodejs.org>.
2. Open a terminal in the `my-tab-stash` folder.
3. Run the unit tests:

   ```sh
   npm test
   ```

4. Install the browser for the smoke test:

   ```sh
   npm install
   npx playwright install chromium
   ```

5. Run the smoke test:

   ```sh
   npm run test:smoke
   ```

6. Make sure that the last line is `SMOKE TEST PASSED`.

After you change the code, click the reload icon (↻) on the **Tab Stash** card
in `chrome://extensions`.
