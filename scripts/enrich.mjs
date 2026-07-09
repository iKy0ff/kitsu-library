// enrich.mjs — the enrichment sync. Runs AFTER sync-library.mjs (which writes
// library.js from Kitsu). For each title it resolves the matching mangabaka
// series and comick comic, then pulls everything we display:
//
//   mangabaka  ->  cover, author, synopsis, status, total chapters,
//                  genres (flat), tags_v2 (weighted) grouped via the tag
//                  dictionary, and news
//   comick     ->  chapter list + release dates (English, de-duplicated)
//
// Output:
//   entries/<kitsuId>.json   full per-title detail read by Entry.html
//   library.js               patched in place with the light fields the
//                            Library grid + notify.mjs need (cover, author,
//                            total, mangabakaStatus, genres, newsCount, ...)
//   sync_errors.log          every failure, with URL + HTTP status
//
// ── API endpoints (VERIFIED, do not "upgrade" to /v2/) ─────────────────────
// mangabaka's public API is version /v1/ — confirmed against the official
// docs (api.mangabaka.dev cites `GET /v1/series/1`) and against the
// comictagger "mangabaka_talker" plugin, which uses
// `https://api.mangabaka.dev/v1/` + `series/search?q=&content_rating=...`.
// A previous build used /v2/ and every call 404'd. Search response shape:
// `{ data: [...], pagination: { page, limit, count, next } }`.
//
// ── Pacing & rate limits ────────────────────────────────────────────────────
// mangabaka rate-limits per endpoint "kind"; CACHED responses don't count
// (cf-cache-status: HIT). The reference client self-limits to 60 req/min.
// We pace at PACE_MS between EVERY network call (default 1100 ms ≈ 55/min),
// back off 20 s on any 429 (up to 3 tries), and never send cache-busting
// params (they'd defeat the free cached tier). A full-library run
// (~6 requests/title) takes roughly 6–7 s per title — ~40–45 min for ~380
// titles. That's fine: slow and complete beats fast and banned.
//
// ── Per-run cap (MAX_PER_RUN) ───────────────────────────────────────────────
// How many titles may be (re)enriched in one run. Change it two ways:
//   * in code:   edit DEFAULT_MAX_PER_RUN below
//   * per run:   MAX_PER_RUN=50 node scripts/enrich.mjs        (local)
//                repo Variable MAX_PER_RUN (GitHub — wired in sync.yml)
// Suggested values: 50–100 for the first test runs; 500 to let the whole
// library fill in one run; 400–500 as a ceiling if the library grows to
// 1k–2k entries so a single run stays under ~1 h.
//
// Cost control: each title is cached in its entries/ file and only refreshed
// after REFRESH_DAYS, so after the initial fill each run only touches stale
// titles. Every network call is guarded — failures keep Kitsu values and
// never abort the whole run (only ABORT_AFTER_CONSECUTIVE_FAILS structural
// failures in a row stop it early, with the reason in sync_errors.log).

import fs from 'node:fs';
import path from 'node:path';

const KITSU_ID_FIELD = 'kitsuId';
const REFRESH_DAYS = 7;
const DEFAULT_MAX_PER_RUN = 500;                 // <-- edit me (or set MAX_PER_RUN env)
const MAX_PER_RUN = Math.max(1, Number(process.env.MAX_PER_RUN) || DEFAULT_MAX_PER_RUN);
const PACE_MS = 1100;                            // delay between EVERY network call
const RETRY_429_DELAY_MS = 20000;                // wait after a 429 before retrying
const MAX_TRIES = 3;                             // tries per request (429/5xx only)
const ABORT_AFTER_CONSECUTIVE_FAILS = 6;

// api.mangabaka.dev and api.mangabaka.org are interchangeable mirrors;
// .dev is the one the official docs + reference client use.
const MB = 'https://api.mangabaka.dev/v1';
const CM = 'https://api.comick.dev';

// content_rating must be REPEATED (all four values) on both search APIs,
// otherwise results are silently filtered to "safe" only.
const RATINGS = ['safe', 'suggestive', 'erotica', 'pornographic']
  .map((r) => 'content_rating=' + r).join('&');

const SEARCH_MB = (q) => `${MB}/series/search?q=${encodeURIComponent(q)}&${RATINGS}&page=1&limit=50`;
const SERIES_MB = (id) => `${MB}/series/${id}`;
const NEWS_MB   = (id) => `${MB}/series/${id}/news`;
const SEARCH_CM = (q) => `${CM}/v1.0/search?type=comic&q=${encodeURIComponent(q)}&limit=25&page=1&${RATINGS}`;
const CHAPS_CM  = (hid, page) => `${CM}/v1.0/comic/${hid}/chapters?page=${page}&limit=100`;
const CM_HEADERS = { Accept: 'application/json', Referer: 'https://comick.dev/', Origin: 'https://comick.dev' };

const LIB_FILE = path.join(process.cwd(), 'library.js');
const TAGS_FILE = path.join(process.cwd(), 'mangabaka_tags.json');
const ENTRIES_DIR = path.join(process.cwd(), 'entries');
const ERROR_LOG = path.join(process.cwd(), 'sync_errors.log');

function logError(msg) {
  fs.appendFileSync(ERROR_LOG, `[${new Date().toString()}] [enrich] ${msg}\n`);
  console.error(msg);
}

// ---- tag dictionary: id -> { name, group, isGenre } -----------------------
function loadTagDict() {
  const dict = {};
  try {
    const arr = JSON.parse(fs.readFileSync(TAGS_FILE, 'utf8')).data || [];
    for (const t of arr) {
      const segs = (t.name_path || t.name || '').split('>').map((s) => s.trim()).filter(Boolean);
      dict[t.id] = {
        name: t.name || segs[segs.length - 1] || '',
        group: t.is_genre ? 'Genre' : (segs.length > 1 ? segs[0] : 'Tag'),
        isGenre: !!t.is_genre,
      };
      if (t.name) dict['name:' + t.name.toLowerCase()] = dict[t.id]; // allow name-keyed lookup too
    }
  } catch (e) { console.warn('tag dictionary unavailable:', e.message); }
  return dict;
}

function parseLibrary() {
  const txt = fs.readFileSync(LIB_FILE, 'utf8');
  const m = txt.match(/window\.libraryData\s*=\s*(\[[\s\S]*\]);/);
  if (!m) return [];
  return (new Function('return ' + m[1]))();
}
function writeLibrary(lib) {
  const header = `// AUTO-GENERATED by scripts/sync-library.mjs + enrich.mjs — do not edit by hand.\n// ${lib.length} entries · enriched ${new Date().toISOString()}\n`;
  fs.writeFileSync(LIB_FILE, `${header}window.libraryData = ${JSON.stringify(lib, null, 2)};\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Paced, retrying GET. No cache-busting params — mangabaka's cached
// responses are free (don't count toward the rate limit), so we WANT hits.
async function getJson(url, headers) {
  let lastErr = 'unknown';
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    await sleep(PACE_MS);
    let res;
    try {
      res = await fetch(url, { headers: headers || { Accept: 'application/json' } });
    } catch (e) {
      lastErr = e.message;
      logError(`network error (try ${attempt}/${MAX_TRIES}) ${url} — ${e.message}`);
      continue;
    }
    if (res.ok) return res.json();
    lastErr = 'HTTP ' + res.status;
    if (res.status === 429) {
      logError(`429 rate-limited (try ${attempt}/${MAX_TRIES}) ${url} — backing off ${RETRY_429_DELAY_MS / 1000}s`);
      await sleep(RETRY_429_DELAY_MS);
      continue;
    }
    if (res.status >= 500) {
      logError(`HTTP ${res.status} (try ${attempt}/${MAX_TRIES}) ${url}`);
      continue;
    }
    // 4xx other than 429: retrying won't help (404 = wrong path / no match)
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  throw new Error(`${lastErr} for ${url} (after ${MAX_TRIES} tries)`);
}

const listOf = (j) => (j && (j.data || j.results)) || (Array.isArray(j) ? j : []);

function coverUrl(cover) {
  if (!cover) return '';
  const pick = (v) => (typeof v === 'string' ? v : (v && (v.x2 || v.x1)) || '');
  return pick(cover.x350) || pick(cover.x250) || pick(cover.raw) || pick(cover.x150) || '';
}
function mapStatus(s) {
  if (!s) return '';
  s = String(s).toLowerCase();
  if (s.includes('releasing') || s.includes('ongoing')) return 'Releasing';
  if (s.includes('complete') || s.includes('finished')) return 'Completed';
  if (s.includes('hiatus')) return 'Hiatus';
  if (s.includes('cancel')) return 'Cancelled';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// weighted + grouped tags from a series' tags_v2 using the dictionary
function buildTags(series, dict) {
  const raw = series.tags_v2 || series.tags || [];
  const out = [];
  for (const t of raw) {
    const id = (t && (t.id ?? t.tag_id));
    const nm = (t && (t.name || t.tag)) || '';
    const info = (id != null && dict[id]) || dict['name:' + String(nm).toLowerCase()] || null;
    out.push({
      name: (info && info.name) || nm || String(id),
      group: (info && info.group) || 'Tag',
      weight: (t && (t.weight || t.rank)) || 'unweighted',
    });
  }
  return out;
}

async function resolveMangabaka(item, dict) {
  const results = listOf(await getJson(SEARCH_MB(item.title)));
  if (!results.length) return null;
  const kid = String(item[KITSU_ID_FIELD] || '');
  let hit = results.find((r) => r && r.source && r.source.kitsu && String(r.source.kitsu.id) === kid) || results[0];
  const id = hit && hit.id;
  if (!id) return null;
  const dj = await getJson(SERIES_MB(id));
  const d = (dj && dj.data) || dj || {};
  let news = [];
  try {
    news = listOf(await getJson(NEWS_MB(id))).map((n) => ({
      title: n.title || n.headline || '', date: n.date || n.published || n.published_at || n.created_at || '', url: n.url || n.link || '',
    }));
  } catch { /* news optional */ }
  return {
    mangabakaId: id,
    cover: coverUrl(d.cover),
    author: Array.isArray(d.authors) ? d.authors.join(', ') : (d.authors || ''),
    synopsis: d.description || '',
    status: mapStatus(d.status),
    total: Number(d.total_chapters) || null,
    genres: Array.isArray(d.genres) ? d.genres.map((g) => (typeof g === 'string' ? g : g.name)).filter(Boolean) : [],
    tags: buildTags(d, dict),
    news,
  };
}

function dedupeChapters(chapters) {
  const byNum = new Map();
  for (const c of chapters) {
    if ((c.lang || c.iso639_1) !== 'en') continue;   // lang param is ignored server-side — filter here
    const num = c.chap != null ? String(c.chap) : (c.chapter != null ? String(c.chapter) : null);
    if (num === null) continue;
    const up = Number(c.up_count) || 0;
    const prev = byNum.get(num);
    if (!prev || up > prev._up) byNum.set(num, { num, title: c.title || '', date: c.created_at || c.updated_at || '', _up: up });
  }
  return Array.from(byNum.values())
    .map((c) => ({ num: c.num, title: c.title, date: c.date }))
    .sort((a, b) => parseFloat(b.num) - parseFloat(a.num));
}

async function resolveComick(item) {
  const results = listOf(await getJson(SEARCH_CM(item.title), CM_HEADERS));
  if (!results.length) return null;
  const kid = String(item[KITSU_ID_FIELD] || '');
  let hit = results.find((r) => r && r.links && String(r.links.kt) === kid) || results[0];
  const hid = hit && hit.hid;
  if (!hid) return null;
  let all = [], page = 1, guardTotal = Infinity;
  while (page <= 10) {                        // cap ~1000 chapters
    const j = await getJson(CHAPS_CM(hid, page), CM_HEADERS);
    const chs = listOf(j);
    if (!chs.length) break;
    all = all.concat(chs);
    guardTotal = j.total || guardTotal;
    if (all.length >= guardTotal) break;
    page++;
  }
  return { comickHid: hid, chapters: dedupeChapters(all) };
}

function isFresh(kitsuId) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ENTRIES_DIR, kitsuId + '.json'), 'utf8'));
    return j.updatedAt && (Date.now() - new Date(j.updatedAt).getTime() < REFRESH_DAYS * 86400000);
  } catch { return false; }
}

async function main() {
  if (!fs.existsSync(LIB_FILE)) { console.warn('library.js missing — run sync-library.mjs first.'); return; }
  if (!fs.existsSync(ENTRIES_DIR)) fs.mkdirSync(ENTRIES_DIR, { recursive: true });
  const dict = loadTagDict();
  const lib = parseLibrary();
  const startedAt = Date.now();
  console.log(`enrich: ${lib.length} titles in library, cap ${MAX_PER_RUN}/run, pace ${PACE_MS}ms`);

  let done = 0, fails = 0, skipped = 0;
  for (const item of lib) {
    const kid = String(item[KITSU_ID_FIELD] || item.slug || item.title || '');
    if (!kid) continue;
    if (isFresh(kid)) { patchFromEntry(item, kid); skipped++; continue; }
    if (done >= MAX_PER_RUN) break;
    if (fails >= ABORT_AFTER_CONSECUTIVE_FAILS) {
      logError(`too many consecutive failures (${fails}) — stopping this run, will resume next time`);
      break;
    }

    const entry = { kitsuId: kid, title: item.title, updatedAt: new Date().toISOString() };
    let ok = false;
    try { const mb = await resolveMangabaka(item, dict); if (mb) { Object.assign(entry, mb); ok = true; } }
    catch (e) { logError(`mangabaka failed for "${item.title}" — ${e.message}`); }
    try { const cm = await resolveComick(item); if (cm) { Object.assign(entry, cm); ok = true; } }
    catch (e) { logError(`comick failed for "${item.title}" — ${e.message}`); }

    if (ok) {
      fs.writeFileSync(path.join(ENTRIES_DIR, kid + '.json'), JSON.stringify(entry, null, 2));
      applyToLibrary(item, entry);
      done++; fails = 0;
      if (done % 10 === 0) {
        writeLibrary(lib); // checkpoint so a mid-run crash keeps progress
        console.log(`enrich: ${done}/${Math.min(MAX_PER_RUN, lib.length)} done (${Math.round((Date.now() - startedAt) / 60000)} min elapsed)`);
      }
    } else {
      fails++;
    }
  }

  writeLibrary(lib);
  console.log(`enrich: ${done} enriched, ${skipped} fresh/skipped, finished in ${Math.round((Date.now() - startedAt) / 60000)} min (cap ${MAX_PER_RUN}).`);
}

// light fields onto the library row (grid + notifications need these)
function applyToLibrary(item, e) {
  if (e.cover) item.cover = e.cover;
  if (e.author && !item.author) item.author = e.author;
  if (e.total && !item.total) item.total = e.total;
  if (e.status) item.mangabakaStatus = e.status;
  if (e.genres) item.genres = e.genres;
  if (Array.isArray(e.news)) item.newsCount = e.news.length;
  if (Array.isArray(e.chapters)) item.chapterCount = e.chapters.length;
}
function patchFromEntry(item, kid) {
  try { applyToLibrary(item, JSON.parse(fs.readFileSync(path.join(ENTRIES_DIR, kid + '.json'), 'utf8'))); } catch {}
}

main();
