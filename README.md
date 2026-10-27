# Walkdeck

https://lexslusarchyk.github.io/walkdeck/

Desk remote for an **EnergyFIT EF-X512NS** walking treadmill, for a MacBook Pro (including M4).

It talks to the pad over Bluetooth, the same way the Spax phone app does. Walks are saved in the browser on your Mac. Nothing is uploaded.

You do **not** need Node, npm, or a build step. This folder is already the website.

Safari cannot open Bluetooth. Use **Google Chrome**, **Microsoft Edge**, **Brave**, or **Arc**.

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


## Change the app later

The `source` folder is the project. GitHub Pages does not build it. Editing those files does nothing until you rebuild and replace the site files in the repository root.

You need [Node.js](https://nodejs.org) installed on your Mac. You only need it for this step, not for walking.

```bash
cd source
npm install
npm run build

npm run build writes a new site into source/dist/.
Copy everything inside source/dist/ over the repository root (the folder that contains index.html and assets).
Do not delete the source folder or this README.md.
Open the new index.html and check the assets/...css and assets/...js names.
Commit index.html and those new files.
Delete the old files in assets that the new index.html no longer mentions. Vite renames them on every build. An old .css or .js left behind is unused.
Push. The GitHub Pages site updates in about a minute.
To try a change before you publish:
cd source
npm install
npm run dev
Open http://127.0.0.1:5173 in Chrome, Edge, Brave, or Arc. Safari cannot connect to the treadmill.