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

`enrich.mjs` re-enriches at most `MAX_PER_RUN` (40) titles per run and caches each in `entries/<id>.json`, refreshing after `REFRESH_DAYS` (7). With a 4x/day cron a full 381-title library fills over ~2–3 days, then just stays fresh — this keeps well under the APIs' rate limits. Tag chips on the Entry page are sized by mangabaka weight (core › defining › recurrent › incidental).

**First-run note:** the two *search* endpoints (`SEARCH_MB`, `SEARCH_CM` at the top of `enrich.mjs`) are the only paths I couldn't verify from the build environment. If a search 404s, adjust those two constants — the series/chapters/news paths are confirmed, and every call falls back gracefully (Kitsu values are kept) so a wrong search path never breaks the sync.

## Notifications (persistent)

Notices never reset. `notify.mjs` writes one file per day — `notifications/notification_DD-MM-YYYY.js` — appends each run's new notices, rebuilds `notifications.js` as a rolling aggregate the page reads, and auto-deletes files past `RETENTION_DAYS` (default 30, one constant to change). Notice types: **status change** and **new news**, for every entry. Chapters are intentionally not notified.

## Stats data source

Automatic indicator (no toggle): uses this repo's `manga_history_data.js` if it has data, else the published Pace Ledger, fetched live. Repo variable **`SYNC_SOURCE=ledger`** skips `sync.mjs` (rely on the Pace Ledger); default `repo` runs it.

---

## Setup (once)

1. **Push these files** (clone the repo, copy everything in — including `.github/` and dotfiles — commit & push; overwrite the auto-created README).
2. **Pages:** Settings → Pages → branch `main`, folder `/ (root)`.
3. **Actions:** Settings → Actions → General → allow workflows + "Read and write permissions".
4. **Variables:** `SYNC_MODE` = `cron` / `github` / `both` / `manual`; `SYNC_SOURCE` = `repo` / `ledger`.
5. **cron-job.org PAT (when ready):** fine-grained, this repo only, Contents R/W + Actions R/W.

Wired in: **Kitsu user ID `1699796`**, timezone **`Europe/Paris`**.

MIT — see `LICENSE`.
