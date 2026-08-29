# Grimoire

A small, self-hosted [Owlbear Rodeo](https://www.owlbear.rodeo/) extension, inspired by GM Vault, built for a
narrower job: keep your **rules references and lore** — PDFs and Markdown notes living in your own Google Drive —
organized into folders, and reveal them to your players exactly when you want to.

- Folders, nested as deep as you like — rulebooks, monster stat blocks, faction lore, house rules, whatever
  structure fits your table.
- Add PDFs, Markdown files, or plain links, from a Google Drive "anyone with the link" share URL.
- A 👁️ / 🙈 toggle per item (or whole folder) controls whether players can see it.
- PDFs open in a full-screen viewer instantly, no setup.
- Markdown files render properly (headers, bold, lists, tables, code blocks — not raw `#`/`**` text) once you add a
  free Google API key — see [Enabling full Markdown rendering](#enabling-full-markdown-rendering-optional) below.
- It's your code. There's no account, no backend, no subscription — just a static site you host yourself and can
  edit however you like.

This is a from-scratch project, not affiliated with or a redistribution of GM Vault or its author.

## How it works, in short

The whole grimoire (your folder structure, item names, Drive links, and hidden/visible flags) is stored in the
Owlbear room's own metadata, which Owlbear already syncs live to every connected client. There's no server of
yours involved and no login — reading and writing it happens entirely through the Owlbear SDK, in the browser.
See [Data model & privacy notes](#data-model--privacy-notes) for the details and the one caveat worth knowing
about.

## Prerequisites

- [Node.js](https://nodejs.org/) 20 or newer (for building the extension).
- A free [GitHub](https://github.com/) account (to host it — Owlbear extensions must be loaded from a public
  `https://` URL).
- A Google account with the material you want to share stored in Google Drive.

## Quick start

```bash
npm install
npm run dev
```

This starts a local dev server (usually `http://localhost:5173`). To try it inside Owlbear Rodeo before deploying
anywhere: open your Owlbear profile → **Extensions** → **Add Custom Extension**, and paste in
`http://localhost:5173/manifest.json`. Then enable it for a room you create. Local extensions only work while
`npm run dev` is running on your machine, so this is just for testing changes — see below for the real deploy.

## Deploying to GitHub Pages

This project already includes a GitHub Actions workflow (`.github/workflows/deploy.yml`) that builds and deploys
the extension automatically. You don't need to run any build commands by hand for this part.

1. Create a new **public** GitHub repository — `owlbear-grimoire` is a good name, but anything works — (Owlbear
   needs to be able to fetch the manifest and files over the open internet, so private repos won't work) and push
   this project to it:

   ```bash
   git init
   git add -A
   git commit -m "Initial Grimoire setup"
   git branch -M main
   git remote add origin https://github.com/<your-username>/owlbear-grimoire.git
   git push -u origin main
   ```

2. In the repo on GitHub, go to **Settings → Pages**, and under **Build and deployment → Source**, choose
   **GitHub Actions**. (You only need to do this once — after that, every push to `main` redeploys automatically.)

3. Go to the **Actions** tab and confirm the "Deploy Grimoire to GitHub Pages" workflow runs successfully. It
   takes about a minute. Once it's green, your extension is live at:

   ```
   https://<your-username>.github.io/owlbear-grimoire/manifest.json
   ```

   (Settings → Pages will also show you the exact base URL once the first deploy finishes.)

## Installing it in Owlbear Rodeo

1. Open your Owlbear Rodeo profile (bottom-left) → **Extensions** → **Add Custom Extension**.
2. Paste in your manifest URL from above (ending in `/manifest.json`) and confirm.
3. Open (or create) a room, go to the room's extension list, and enable Grimoire for that room.
4. You should now see the Grimoire icon in the room's action bar. Click it to open the popover.

Extensions are enabled per-room, so do this once for each campaign room you want it in. Since the grimoire is
stored in that room's own metadata, each room gets its own independent set of folders/references.

## Using it

Click the Grimoire icon to open the popover. As the GM you'll see a role badge, a **+** button to add items at
the root, and a **⚙** settings button.

- **Add a folder/PDF/Markdown/link**: click **+** (at the top for root level, or on a folder row to add inside
  it), choose a type, give it a name, and for PDF/Markdown paste the item's Google Drive share link. For a link
  item, paste any URL.
- **Google Drive links**: open the file in Drive, click **Share**, set access to "Anyone with the link" (Viewer is
  enough), then **Copy link** and paste that into Grimoire. Any of Drive's usual link shapes work
  (`.../file/d/<id>/view`, `.../open?id=<id>`, etc.) — Grimoire pulls the file id out automatically.
- **Reveal/hide**: hover a row and click the eye icon. New items start hidden by default, so nothing leaks to
  players the moment you add it — handy for lore you're still drip-feeding, or a stat block you're not ready to
  show. Hiding a folder hides everything inside it, regardless of each item's own toggle.
- **Reorder / reorganize**: hover a row for ↑ / ↓ (reorder among siblings), ⤤ (move to a different folder), ✎
  (rename), and 🗑 (delete — click once to arm it, click again within 3 seconds to confirm; this avoids relying on
  browser confirm dialogs, which don't reliably work inside embedded extensions).
- **Viewing**: click an item's name to open it full-screen. PDFs show Drive's own preview. Markdown renders inline
  if you've set up the API key (below); otherwise you'll get a prompt to add one, plus a fallback link to open the
  raw file in Drive. Link items open in a new browser tab (most sites refuse to be embedded in an iframe, so
  Grimoire doesn't try).
- **Players** see a read-only version of the tree with only revealed items/folders, and no editing controls.

## Enabling full Markdown rendering (optional)

PDFs work out of the box. Markdown needs a small, free, one-time setup because Google Drive doesn't hand out raw
file contents to a random web page without an API key attached:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a new project (or reuse one).
2. Go to **APIs & Services → Library**, search for **Google Drive API**, and click **Enable**.
3. Go to **APIs & Services → Credentials → Create Credentials → API key**. Copy the key.
4. Click into the new key's settings and, under **Application restrictions**, choose **Websites** and add your
   GitHub Pages URL (e.g. `https://<your-username>.github.io/*`). This stops the key from being usable from
   anywhere except your own extension.
5. Under **API restrictions**, restrict the key to just the **Google Drive API**.
6. Back in Grimoire, open the popover → **⚙ Settings**, paste the key in, and click **Save**.

Do this once and every Markdown file in the grimoire will render for you and your players from then on (the key
is stored with the rest of the vault data — see the privacy note below for what that means).

## Data model & privacy notes

- Everything Grimoire stores (folder structure, names, Drive links, hidden flags, and the Drive API key if you
  set one) lives in the **room's** Owlbear metadata, under one JSON key. It's not sent to any server of ours —
  Owlbear itself syncs it to every connected client, the same mechanism any Owlbear extension uses to share state.
- **Owlbear caps total room metadata at 16kB.** Grimoire keeps a safety margin under that, and will warn you if
  an edit would push it over the limit instead of silently failing. In practice that's room for on the order of a
  hundred items — plenty for a rules/lore reference, but if you outgrow it, split content across scenes/rooms or
  trim item names.
- **"Hidden" is a display filter, not real access control.** Room metadata syncs to every connected client,
  players included — a hidden item's data does technically reach a player's browser, Grimoire's UI just doesn't
  render it for them. A player poking around in their browser's developer tools could see it. This is the same
  tradeoff basically every Owlbear content-sharing extension makes (there's no per-player backend to enforce real
  secrecy), and it's a non-issue for the "keep spoilers out of the way during play" use case, but it's not a
  vault in the security sense — don't put anything in there you'd be upset about a determined player digging out.
- **The Drive API key is a public, referrer-restricted key**, not a login credential — it can't read your Drive
  beyond what's already shared "anyone with the link," and step 4 above locks it to only work when loaded from
  your own extension's URL. That's why it's fine for it to sync to players' clients the same way everything else
  does — it needs to, since players' browsers are what fetch and render Markdown for them too.

## Project layout

```
public/manifest.json   Owlbear extension manifest
public/icon.svg         Toolbar icon
index.html              Popover entry point
viewer.html              Full-screen content viewer entry point
src/main.ts               Popover UI: tree rendering, GM editing, settings panel
src/viewer.ts              Viewer: picks how to render a PDF / Markdown / link item
src/store.ts                Reads/writes the grimoire to Owlbear room metadata
src/tree.ts                  Pure helpers for the folder tree (children, visibility, moving)
src/drive.ts                  Parses Google Drive share links, builds preview/API URLs
src/markdown.ts                 Fetches + renders Markdown (marked + DOMPurify)
src/theme.ts                     Mirrors Owlbear's light/dark theme into CSS variables
src/style.css                     All styling
.github/workflows/deploy.yml       Builds & deploys dist/ to GitHub Pages on push to main
```

It's plain TypeScript with no UI framework, so most changes are just editing the relevant file above. A few ideas
if you want to extend it further: right-click a token to link its reference (like GM Vault's token linking), a
"push this to everyone's screen now" broadcast instead of click-to-open, drag-and-drop reordering, or Notion
support alongside Drive.

## Troubleshooting

- **Extension doesn't show up after adding the manifest URL**: make sure the URL ends in `/manifest.json` and
  loads a valid JSON file in your browser directly. If you just enabled GitHub Pages, give the Actions workflow a
  minute to finish first.
- **Icon shows but the popover is blank/broken**: open your browser's dev tools while the popover is open and
  check the console — most often this is a stale build (rerun the deploy) or a browser cache issue (hard refresh).
- **Markdown shows an error instead of rendering**: double-check the file is shared "Anyone with the link," that
  the Drive API is enabled on the Google Cloud project your key belongs to, and that the key's website
  restriction includes your exact GitHub Pages URL.
- **"Vault is over the 16kB limit" toast**: delete a few items or shorten names; see the privacy notes above.
