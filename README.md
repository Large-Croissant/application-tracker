# JobTracker

A fast, local-first job application tracker for Windows. Native desktop app (Tauri 2) —
no Electron, no browser, no account. Your data lives in a SQLite database on your machine.

## What it does

- **Applications table** — track every application with status, salary, source, location,
  and a full timeline of events (applied, acknowledgements, calls, interviews, decisions).
- **Kanban / flow views** — drag applications through your pipeline, and see the whole
  history drawn as a flow chart driven by each application's status trail.
- **Insights** — funnel and monthly activity charts built from your real timeline events.
- **Quick-paste vault** — fill forms fast: profile fields, reference contacts, prepared
  answers, and resume versions, all one-click copy.
- **Backups & export** — an automatic database backup every time the app closes
  (with configurable retention), manual one-click backups, and CSV export via a native
  save dialog.
- **Flosa import** — moving from [Flosa](https://my.flosa.app)? Settings → Import from Flosa
  gives you a copyable console script that exports your Flosa data (`flosa_full.json`),
  then imports everything — statuses, salary ranges, milestone history, and notes — with a
  full preview before anything is written. Re-imports can atomically replace earlier ones.

## Two-way cloud sync

Sync across machines through your own Dropbox app folder:

- **Merge, not overwrite** — every row carries a stable UUID, so two devices combine
  their changes instead of clobbering each other. Per-row conflicts resolve by
  last-writer-wins.
- **Deletes propagate** — deleting an application (and its timeline) records a
  tombstone that merges cleanly on the other device. An edit made after a deletion
  restores the item.
- **End-to-end encrypted by default** — data is encrypted with your passphrase before
  upload (Argon2id key derivation + XChaCha20-Poly1305); Dropbox only ever stores
  ciphertext. The passphrase never leaves your devices unless you opt into remembering
  it locally.
- **One "Sync now" button** — pulls cloud changes (only when the cloud moved), merges,
  then pushes. A pre-merge backup is written automatically before any incoming data is
  applied, and closing the app runs the same cycle automatically.

## Install

Download the installer from the
[Releases page](https://github.com/Large-Croissant/application-tracker/releases):

- `JobTracker_*_x64-setup.exe` — standard installer (NSIS)
- `JobTracker_*_x64_en-US.msi` — MSI installer

Installing a newer version over an old one is safe: application data lives outside the
install directory and database migrations run automatically on first launch.

## Build & run

Prerequisites: [Node.js](https://nodejs.org/), [Rust](https://rustup.dev/), and the
Visual Studio C++ Build Tools (Windows).

```powershell
npm install
npm run tauri dev        # dev window (Windows: use dev_env.cmd — see below)
npm run tauri build      # standalone exe at src-tauri/target/release/jobtracker.exe
```

On some Windows setups `rustc` needs the Visual Studio environment first; `dev_env.cmd`
in the repo root wraps any command with it:

```powershell
.\dev_env.cmd npm run tauri dev
```

## Stack

Tauri 2 · React 18 · TypeScript · Rust (rusqlite) · d3 (sankey flow chart)

## Data & privacy

Everything is stored locally at `%APPDATA%\com.jobtracker.app\jobtracker.db` —
backups and sync config live alongside it in the same folder. No telemetry. The only
network calls the app makes are to Dropbox (only when you connect sync) and to GitHub
(only when you explicitly check for updates). The Flosa import script runs in *your*
browser session on my.flosa.app and only saves a file to your own Downloads folder.
