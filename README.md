# Walkdeck

Desk remote for an **EnergyFIT EF-X512NS** walking treadmill, for a MacBook Pro (including M4).

It talks to the pad over Bluetooth, the same way the Spax phone app does. Walks are saved in the browser on your Mac. Nothing is uploaded.

You do **not** need Node, npm, or a build step. This folder is already the website.

Safari cannot open Bluetooth. Use **Google Chrome**, **Microsoft Edge**, **Brave**, or **Arc**.

---

## Publish it on GitHub Pages

### 1. Create an empty public repository

1. Open [https://github.com/new](https://github.com/new).
2. Repository name: `walkdeck` (any name is fine).
3. Set the repository to **Public**. GitHub Pages on a free account only serves public repositories. Your walks are not in this repository — they stay in the browser.
4. Leave **Add a README**, **Add .gitignore**, and **Choose a license** turned **off**. This folder already has the files.
5. Click **Create repository**.

### 2. Put these files on GitHub

On your Mac, unzip the archive. You will get a folder named `walkdeck`.

**Easiest way — GitHub Desktop or the Terminal**

If you use Terminal:

```bash
cd ~/Downloads/walkdeck
git init
git add -A
git commit -m "Publish Walkdeck"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/walkdeck.git
git push -u origin main
```

Replace `YOUR_USERNAME` and `walkdeck` with your GitHub username and repository name. GitHub will ask you to sign in.

**Without Terminal**

1. On the new empty repository page, click **uploading an existing file**.
2. In Finder, open the unzipped `walkdeck` folder. Press **Command + Shift + .** so hidden files appear. You must include the file named `.nojekyll`.
3. Drag these into the GitHub page:
   - `.nojekyll`
   - `index.html`
   - `favicon.svg`
   - `manifest.webmanifest`
   - `sw.js`
   - `icon-192.png`
   - `icon-512.png`
   - `README.md`
   - the whole `assets` folder
4. You can skip the `source` folder. It is only there if you later want to change the app.
5. Click **Commit changes**.

If `.nojekyll` did not upload, on GitHub click **Add file → Create new file**, name it exactly `.nojekyll`, leave it empty, and commit.

### 3. Turn on GitHub Pages

1. In the repository, open **Settings**.
2. In the left sidebar, open **Pages**.
3. Under **Build and deployment**:
   - **Source:** Deploy from a branch
   - **Branch:** `main`
   - **Folder:** `/ (root)`
4. Click **Save**.
5. Wait about a minute and refresh the Pages settings. GitHub shows a link like:

   `https://YOUR_USERNAME.github.io/walkdeck/`

6. On your MacBook Pro, open that link in **Chrome, Edge, Brave, or Arc**. The address must start with `https://`.

Bookmark it. That bookmark is your remote.

### 4. Optional — open it like an app

In Chrome: menu → **Cast, save, and share** → **Install page as app** (the menu wording varies). It opens in its own window and can live in the Dock. Leave the lid open while the belt is moving. Closing the lid drops Bluetooth. Walkdeck will reconnect and will not restart the belt by itself.

---

## Use it with the EF-X512NS

1. Quit **Spax** on your phone. The pad only stays linked to one device.
2. Power the treadmill on and clip in the safety key.
3. On the Mac: **System Settings → Privacy & Security → Bluetooth**. Turn the switch on for Chrome (or Edge, Brave, or Arc).
4. Do **not** pair the treadmill in the macOS Bluetooth device list. Web Bluetooth pairs from the page. If you already paired it there, click the info button next to it and choose **Forget This Device**.
5. On the Walkdeck page, click **Connect pad**. Choose the device. The name usually starts with `FS`.
6. If it is not in the list, click **Show every Bluetooth device** and pick it.
7. Click **Start belt**.

Keyboard, when you are not typing in a box:

| Key | Action |
| --- | --- |
| `1` – `6` | Jump to that speed |
| `↑` `→` | 0.1 km/h faster |
| `↓` `←` | 0.1 km/h slower |
| `space` | Pause or resume |
| `esc` | Stop |

The pad is rated **1–6 km/h** and **100 kg**. Incline is the manual feet, not a button. The safety key still cuts the motor. Stay on the belt.

Walks are saved in this browser on this Mac. They do not sync with Spax. **Download CSV** saves a file in Downloads. Deleting the site's data in Chrome settings deletes the history.

---

## If it will not connect

- You opened the page in **Safari** or **Firefox**. Switch to Chrome, Edge, Brave, or Arc.
- The address does not start with `https://`. GitHub Pages links do. A file you opened from Finder (`file://`) cannot use Bluetooth.
- Spax is still open on the phone, or another computer is already linked. Quit it and try again.
- Chrome is not allowed under **System Settings → Privacy & Security → Bluetooth**.
- The pad is paired in the macOS Bluetooth list. Forget it there, then connect from the page.
- The chooser closed with nothing listed. Turn the pad on, wait a few seconds, click **Show every Bluetooth device**.
- The page says it heard the device but there is no control channel. Open **Bluetooth log** at the bottom, click **Copy log**, and keep that text. The protocol selector can be set to **FitShow (Spax pads)** and then you reconnect.

Speed changes are sent once the belt says it is running. **Stop** is immediate. The handheld remote still works.

---

## What is in this folder

| File | Why it is here |
| --- | --- |
| `index.html`, `assets/` | The website GitHub Pages serves |
| `.nojekyll` | Tells GitHub not to run Jekyll on this site |
| `manifest.webmanifest`, `sw.js`, `icon-*.png` | Lets Chrome install it as a Dock app |
| `source/` | The original project. Ignore it unless you want to change the remote |

The `source` folder is not required for the site to work.
