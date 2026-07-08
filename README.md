# Kitsu Library

A self-hosted manga library, reading-stats dashboard, and update tracker built on top of your Kitsu account. It's a **static site on GitHub Pages** with a **GitHub Actions sync job** that pulls data from Kitsu (and later mangabaka + comick) and commits it as plain `.js` data files the pages read. No server, no database, no API keys.

Live site (once Pages is enabled): `https://iky0ff.github.io/kitsu-library/`

---

## How it works

Browsers can't call Kitsu/mangabaka/comick directly (CORS, rate limits, referer gating). So a scheduled Actions job does the fetching and writes static data files; the pages just read those files. Each data file is a small `.js` that assigns a global (`window.libraryData = [...]`) and is loaded with `<script src>`, which works the same over `file://` and HTTP.

```
Kitsu / mangabaka / comick --> Actions (scripts/*.mjs) --> commits .js data files --> GitHub Pages --> pages read them
```

Every page is plain HTML/CSS/JS — no framework, no build step.

---

## Pages

| File | Page | Reads |
|---|---|---|
| `index.html` | Redirect to the Library | — |
| `Library.html` | **Home** — your library (cards / covers / list, filter, sort, search) | `library.js` |
| `Stats.html` | Reading-stats dashboard — tabs: Dashboard / Goals / History / Preferences | `manga_history_data.js` (+ live Pace-Ledger option) |
| `Sources.html` | Service health (Kitsu / mangabaka / comick) | `sources_status.js` + `manga_history_data.js` |
| `Notifications.html` | Status & new-chapter notices | `notifications.js` |
| `Settings.html` | Theme, chart defaults, stale threshold, config export/import | `localStorage` |

Settings sync app-wide through shared `localStorage` keys (`kitsuTheme`, `kitsuGoals`, `kitsuChartView`, ...), so the theme you pick in Settings applies everywhere.

## Backend (scripts/)

| Script | Writes | Purpose |
|---|---|---|
| `sync.mjs` | `manga_history_data.js` (+ backups) | Aggregate chapter-count ledger over time (drives Stats) |
| `sync-library.mjs` | `library.js` | Your full per-title library from Kitsu (covers, status, progress) |
| `notify.mjs` | `notifications.js`, `notify_state.json` | Diffs each sync against the last to emit completed / on-hold / new-chapter notices |
| `healthcheck.mjs` | `sources_status.js` | Pings each service's site + API (server-side, so no CORS block) |

`.github/workflows/sync.yml` runs all four on a schedule and commits the results.

**You never hand-edit the data files** — `manga_history_data.js`, `library.js`, `notifications.js`, `sources_status.js`, `notify_state.json`, the backups, and `sync_errors.log` are all written and committed by the workflow. They ship seeded empty and fill in on the first run.

Also in the repo: `favicons/`, `LICENSE` (MIT), `.nojekyll`, `.gitignore`, and `daily_backup/` (rolling + 30-day dated ledger backups).

---

## Setup (once)

1. **Push these files** to the repo (clone it, copy everything in — including the `.github/` folder and dotfiles — then commit & push; overwrite the auto-created README).
2. **Enable Pages:** Settings → Pages → Source = "Deploy from a branch", branch = `main`, folder = `/ (root)`.
3. **Enable Actions:** Settings → Actions → General → allow workflows, and set "Read and write permissions" so the sync can commit.
4. **Pick a sync mode:** Settings → Secrets and variables → Actions → Variables → add `SYNC_MODE` (`cron` if you'll trigger from cron-job.org — recommended; or `github`, `both`, `manual`). See the comments in `sync.yml`.
5. **(cron-job.org) PAT when ready** — a fine-grained token scoped to *only this repo* with **Contents: Read and write** + **Actions: Read and write**, used to POST the `workflow_dispatch` API.

Your account is wired in: **Kitsu user ID `1699796`**, timezone **`Europe/Paris`**. These appear in the two sync scripts, `sync.yml` (TZ), and the Stats live-check — change them together if you ever switch accounts.

---

## Notes

- **Stats data source:** the Stats page has a **This Repo / Pace Ledger** toggle. Before this repo's first sync, flip to *Pace Ledger* to see your accumulated history from `https://iky0ff.github.io/manga-pace-ledger/`; switch back once this repo has synced. The remote URL is a single constant near the bottom of `Stats.html`.
- **Sources / Notifications start empty** — they populate after the workflow runs at least once (Sources needs one health-check; Notifications needs two syncs to diff).
- **Totals & authors:** Kitsu often returns `null` for chapter counts and doesn't expose author on the library endpoint, so progress bars use whatever total Kitsu has for now. Both fill in when mangabaka/comick enrichment lands (the Entry-detail phase), which also activates the Library's genre/tag Filters.

## License

MIT — see `LICENSE`.
