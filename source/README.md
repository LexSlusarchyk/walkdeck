# Source

You do not need this folder to use Walkdeck. The website is the `index.html` and `assets` folder in the parent directory.

If you change these files later:

```bash
cd source
npm install
npm run build
```

Then copy everything inside `source/dist/` over the parent folder (do not delete `source/` or the parent `README.md`). Commit and push. GitHub Pages updates from the parent folder.
