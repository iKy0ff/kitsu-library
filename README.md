# Kitsu Library

A self-hosted manga library, reading-stats dashboard, and update tracker built on your Kitsu account. A **static site on GitHub Pages** with a **GitHub Actions sync job** that pulls from Kitsu, mangabaka, and comick and commits plain `.js`/`.json` data files the pages read. No server, no database, no API keys.

Live site (once Pages is enabled): `https://iky0ff.github.io/kitsu-library/`

---

## How it works

Browsers can't call Kitsu/mangabaka/comick directly (CORS, rate limits, referer gating), so a scheduled Actions job fetches and writes static data files; the pages read them. Every page is plain HTML/CSS/JS — no framework, no build step.

```
Kitsu     -> library entries + cumulative chapter totals -> Library grid + Stats
mangabaka -> cover, author, synopsis, status, genres, weighted tags, news -> Entry + Filters + Notifications
comick    -> chapter lists + release dates -> Entry
```

## Pages

| File | Page | Reads |
|---|---|---|
| `index.html` | Redirect to the Library | — |
| `Library.html` | Home — cards / covers / list, status filter, **genre filter**, sort, search | `library.js`, `notifications.js` |
| `Entry.html` | Per-title detail (synopsis, weighted+grouped tags, chapters, news) via `Entry.html?id=<kitsuId>` | `library.js`, `entries/<id>.json` |
| `Stats.html` | Reading-stats dashboard — Dashboard / Goals / History / Preferences | `manga_history_data.js` (or Pace Ledger) |
| `Sources.html` | Service health (Kitsu / mangabaka / comick) | `sources_status.js` |
| `Notifications.html` | Status & news notices | `notifications.js` |
| `Settings.html` | Theme, chart defaults, stale threshold, config export/import | `localStorage` |

## Backend (scripts/)

| Script | Writes | Purpose |
|---|---|---|
| `sync.mjs` | `manga_history_data.js` (+ backups) | Aggregate chapter-count ledger (drives Stats) |
| `sync-library.mjs` | `library.js` | Per-title library from Kitsu (status, progress, score, cover fallback) |
| `enrich.mjs` | `entries/<id>.json`, patches `library.js` | mangabaka (cover, author, synopsis, status, genres, weighted tags, news) + comick (chapters). Matches on `source.kitsu.id` / `links.kt`, batched + cached |
| `notify.mjs` | `notifications/`, `notifications.js`, `notify_state.json` | Diffs each sync to emit **status + news** notices for every entry (chapters are not notified) |
| `healthcheck.mjs` | `sources_status.js` | Pings each service server-side |

`mangabaka_tags.json` is the committed tag dictionary (2,694 tags) `enrich.mjs` uses to group tags (Genre / Themes / Setting / …) from their `name_path`.

**You never hand-edit the generated data files** — `library.js`, `entries/`, `notifications*`, `sources_status.js`, `notify_state.json`, and the backups are all written by the workflow. They ship seeded empty and fill in as the sync runs.

## Enrichment: how it fills in

`enrich.mjs` re-enriches at most `MAX_PER_RUN` titles per run (default **500** — the whole library in one go; override with the `MAX_PER_RUN` env var / repo variable) and caches each in `entries/<id>.json`, refreshing after `REFRESH_DAYS` (7). It paces itself at ~1 request/second (the rate the reference mangabaka client uses), backs off 20 s on any 429, and checkpoints `library.js` every 10 titles, so a full ~380-title fill takes ~45 minutes once and routine runs finish in seconds. Every failure is appended to `sync_errors.log` with the URL and HTTP status. Tag chips on the Entry page are sized by mangabaka weight (core › defining › recurrent › incidental).

**API paths are verified:** mangabaka's public API is **`/v1/`** (`https://api.mangabaka.dev/v1/series/search`, `/v1/series/{id}`, `/v1/series/{id}/news`) — confirmed against the official docs and the comictagger `mangabaka_talker` client. Both search APIs need `content_rating` repeated four times or results are silently "safe"-only; comick additionally needs the `Referer: https://comick.dev/` header. All of this is encoded in `scripts/enrich.mjs`.

## Notifications (persistent)

Notices never reset. `notify.mjs` writes one file per day — `notifications/notification_DD-MM-YYYY.js` — appends each run's new notices, rebuilds `notifications.js` as a rolling aggregate the page reads, and auto-deletes files past `RETENTION_DAYS` (default 30, one constant to change). Notice types: **status change** and **new news**, for every entry. Chapters are intentionally not notified.

## Stats data source

Automatic indicator (no toggle): uses this repo's `manga_history_data.js` if it has data, else the published Pace Ledger, fetched live. Repo variable **`SYNC_SOURCE=ledger`** skips `sync.mjs` (rely on the Pace Ledger); default `repo` runs it.

---

## Setup — full walkthrough

### 0. Prerequisites

- A **GitHub account**. The repo must be **public** for free GitHub Pages + Actions.
- **Git** installed locally (`git --version` to check), or use GitHub Desktop / the web upload.
- **Node 18+** only if you want to run the sync scripts locally (`node --version`).
  The GitHub Actions job installs its own Node — nothing to install for the hosted setup.
- Your **Kitsu account** must have a public library (default) — the sync uses the
  public API, no login or API key.

### 1. Point it at *your* Kitsu account

The Kitsu numeric user ID is hardcoded in three places. Find yours by opening
`https://kitsu.app/api/edge/users?filter[name]=YOUR_USERNAME` in a browser and
reading `data[0].id`. Then replace the ID in:

| File | Constant |
|---|---|
| `scripts/sync.mjs` | `KITSU_USER_ID` |
| `scripts/sync-library.mjs` | `KITSU_USER_ID` |
| `scripts/healthcheck.mjs` | the `api:` URL of the Kitsu service entry |

Also set your timezone in `.github/workflows/sync.yml` (`TZ:` env, IANA name like
`Europe/Paris`) — it drives the Stats page's streaks/heatmap/hour charts.

### 2. Create the repo and push

```bash
# from the folder containing these files
git init
git add -A
git commit -m "initial import"
git branch -M main
git remote add origin https://github.com/YOUR_USER/kitsu-library.git
git push -u origin main
```

Make sure **dotfiles are included** — `.github/` (the workflow), `.nojekyll`, and
`.gitignore` are all required. `git add -A` picks them up; drag-and-drop web
upload often silently skips them, so prefer git.

### 3. Enable Actions (the sync job)

1. Repo → **Settings → Actions → General**.
2. Under *Actions permissions*: **Allow all actions and reusable workflows**.
3. Under *Workflow permissions*: select **Read and write permissions**
   (the job commits the data files back to the repo — without this every run
   fails at the push step).

### 4. Enable Pages (the site)

1. Repo → **Settings → Pages**.
2. Source: **Deploy from a branch** → branch **`main`**, folder **`/ (root)`** → Save.
3. The site appears at `https://YOUR_USER.github.io/kitsu-library/` after a
   minute or two. (`index.html` redirects to the Library.)

### 5. Repository variables (optional but recommended)

Repo → **Settings → Secrets and variables → Actions → Variables** tab → *New repository variable*:

| Variable | Values | Meaning |
|---|---|---|
| `SYNC_MODE` | `github` (default-ish) / `cron` / `both` / `manual` | Which trigger may run the sync. Leave unset or `github` to just use GitHub's schedule. |
| `SYNC_SOURCE` | `repo` (default) / `ledger` | `ledger` skips the aggregate chapter-count sync and lets Stats read the published Pace Ledger instead. |
| `MAX_PER_RUN` | number, e.g. `50` | Caps how many titles `enrich.mjs` (re)enriches per run. **Unset = 500** (whole library in one run). |

### 6. First run — do a small test first

1. Repo → **Actions → Sync Kitsu Library → Run workflow** (the `workflow_dispatch` button).
2. For the very first run, set the repo variable `MAX_PER_RUN` to **`50`** before
   dispatching — the run should finish in ~6–8 minutes and enrich 50 titles.
3. Watch the run's logs: the *Sync per-title library* step should say
   `Wrote N library entries to library.js`; the *Enrich* step prints progress
   every 10 titles and a final `enrich: 50 enriched, ...` line.
4. Check the site: Library cards should now show covers/authors for the first
   50 titles, and clicking a card opens its Entry page.
5. If all is well, delete the `MAX_PER_RUN` variable (or set it to `500`) and
   dispatch again — the full library fills in one run (~45 min for ~380 titles
   at the deliberately slow ~1 request/second pace). Already-enriched titles
   are cached and skipped, so this run only does the remainder.
6. From then on the schedule keeps things fresh: each title is re-enriched at
   most once every `REFRESH_DAYS` (7), so routine runs finish in seconds.

**Timing note:** the schedule in `sync.yml` fires every 15 minutes — that
frequency exists for the aggregate chapter-count ledger (Stats). The enrichment
step self-limits via its cache, so it does *not* re-hit the APIs every 15 min.

### 7. Running locally instead (optional)

The scripts are plain Node (built-in `fetch`, zero npm installs):

```bash
node scripts/sync-library.mjs        # writes library.js from Kitsu
MAX_PER_RUN=20 node scripts/enrich.mjs   # enrich a few titles as a test
node scripts/notify.mjs
node scripts/healthcheck.mjs
```

On **Windows** (PowerShell), set the env var on its own line:

```powershell
$env:MAX_PER_RUN = "20"
node scripts/enrich.mjs
```

Then open `Library.html` directly in a browser — the data files are `.js`
globals precisely so `file://` viewing works without a local server.

### 8. Troubleshooting

- **Enrichment "didn't work" / cards have no covers:** open `sync_errors.log`
  in the repo root — every failed request is logged there with its URL and HTTP
  status (the workflow commits it). `HTTP 404` on a mangabaka URL means the API
  path drifted (it is `/v1/` — see the header comment in `scripts/enrich.mjs`);
  repeated `429` means slow down: raise `PACE_MS` or lower `MAX_PER_RUN`.
- **Run fails at "Commit and push":** Workflow permissions aren't Read/Write (step 3).
- **Pages shows an old version:** Pages redeploys on each push; hard-refresh
  (Ctrl+F5) — the data `.js` files can be cached by the browser.
- **Everything empty on first visit:** the data files ship seeded empty; run
  the workflow once (step 6).

### 9. cron-job.org external trigger (optional, later)

For tighter scheduling than GitHub's best-effort cron: create a fine-grained
PAT (this repo only, **Contents: R/W** + **Actions: R/W**), then have
cron-job.org POST to the `workflow_dispatch` endpoint. Set `SYNC_MODE=cron`
(external only) or `both`.

Wired in right now: **Kitsu user ID `1699796`**, timezone **`Europe/Paris`** — change per step 1 if these aren't yours.

MIT — see `LICENSE`.
