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
- **Flosa import** — moving from [Flosa](https://my.flosa.app)? Settings → Import from Flosa
  gives you a copyable console script that exports your Flosa data (`flosa_full.json`),
  then imports everything — statuses, salary ranges, milestone history, and notes — with a
  full preview before anything is written. Re-imports can atomically replace earlier ones.

## Build & run

Prerequisites: [Node.js](https://nodejs.org/), [Rust](https://rustup.dev/), and the
Visual Studio C++ Build Tools (Windows).

```powershell
npm install
npm run tauri dev        # dev window (Windows: use dev_env.cmd — see below)
npm run tauri build      # standalone exe at src-tauri/target/release/jobtracker.exe
```

On this machine, `rustc` needs the Visual Studio environment, so every cargo-invoking
command is wrapped:

```powershell
.\dev_env.cmd npm run tauri dev
```

## Stack

Tauri 2 · React 18 · TypeScript · Rust (rusqlite) · d3 (sankey flow chart)

## Data & privacy

Everything is stored locally at `%APPDATA%\com.jobtracker.app\jobtracker.db`.
No telemetry, no network calls from the app. The Flosa import script runs in *your*
browser session on my.flosa.app and only saves a file to your own Downloads folder.
