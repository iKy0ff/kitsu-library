// enrich.mjs — the enrichment sync. Runs AFTER sync-library.mjs (which writes
// library.js from Kitsu). For each title it finds the matching mangabaka
// series and pulls everything we display: cover, author, synopsis, publication
// status, total chapters, genres, weighted/grouped tags_v2, news, and
// cross-site links (AniList / MAL / MangaUpdates / Anime-Planet / Shikimori /
// raw referrer URLs — rendered as the Entry page's source chips).
//
// comick was removed from the project entirely (2026-07): its API is unstable
// (domain hops, Cloudflare 403s on any datacenter IP) and the chapter list was
// its only contribution. Any comick URL mangabaka knows still shows up in the
// Entry page's links row — we just never call comick ourselves.
//
// Output:
//   entries/<kitsuId>.json   full per-title detail read by Entry.html
//   library.js               patched in place with the light fields the
//                            Library grid + notify.mjs need
//   sync_errors.log          every failure, with URL + HTTP status
//
// ── API endpoints (VERIFIED, do not "upgrade" to /v2/) ─────────────────────
// mangabaka's public API is version /v1/ — confirmed against the official
// docs (api.mangabaka.dev cites `GET /v1/series/1`) and against the
// comictagger "mangabaka_talker" plugin. Search response shape:
// `{ data: [...], pagination: { page, limit, count, next } }`.
//
// ── Matching (the important part) ───────────────────────────────────────────
// The first search hit is often WRONG — e.g. the NOVEL of a series instead of
// the manhwa (real case: "The Demon King Has Too Many Heroes" matched the
// completed 273-ch novel instead of the releasing 40-ch manhwa, producing a
// bogus "Completed" notification). Matching now works like this:
//   1. VERIFIED — a result whose source.kitsu.id equals our Kitsu id wins
//      immediately.
//   2. Results whose kitsu link points at a DIFFERENT Kitsu id are heavily
//      penalized: mangabaka itself says they belong to another Kitsu entry
//      (real case: Quanzhi Gaoshou's cancelled first run vs. its remake).
//   3. Novels are excluded outright — the Kitsu library is manga-kind only.
//   4. Remaining candidates are SCORED on: exact/partial title match
//      (including native/romanized/secondary titles), format agreement
//      (kitsu subtype vs mangabaka type), year proximity, publication-status
//      agreement, chapter-count proximity, and synopsis word overlap.
// The winner is stored with a confidence level — verified / high / medium /
// low — persisted in the entry (`match`) and shown on the Entry page.
// Bump MATCH_VERSION to force a full re-match of every title on the next run
// (the freshness cache is bypassed when an entry's matchVersion is older).
//
// ── Pacing & rate limits ────────────────────────────────────────────────────
// mangabaka rate-limits per endpoint "kind"; CACHED responses don't count
// (cf-cache-status: HIT). The reference client self-limits to 60 req/min.
// We pace at PACE_MS between EVERY call (default 1100 ms ≈ 55/min), back off
// 20 s on any 429, and never send cache-busting params. ~3 requests/title →
// a full ~380-title (re)match takes ~25 min.
//
// ── Per-run cap (MAX_PER_RUN) ───────────────────────────────────────────────
//   * in code:   edit DEFAULT_MAX_PER_RUN below
//   * per run:   MAX_PER_RUN=50 node scripts/enrich.mjs        (local)
//                repo Variable MAX_PER_RUN (GitHub — wired in sync.yml)

import fs from 'node:fs';
import path from 'node:path';

const KITSU_ID_FIELD = 'kitsuId';
// How long an entry's data is considered fresh before the sync re-resolves
// it (full re-match + re-fetch). Set to 0: EVERY run re-checks the entire
// library, so upstream fixes on mangabaka/Kitsu appear on the very next
// sync. Practical effect on the 15-min schedule: a full pass (~26 min for
// ~385 titles) outlasts the interval, so syncs run back-to-back around the
// clock (~55 passes/day, ~60k requests — paced at ~1/s and mostly served
// from mangabaka's cache, which doesn't count toward their rate limit).
// Raise via the REFRESH_HOURS env var / repo variable (e.g. 6 = four
// passes/day) if that ever becomes a problem.
const REFRESH_HOURS = process.env.REFRESH_HOURS !== undefined && process.env.REFRESH_HOURS !== ''
  ? Math.max(0, Number(process.env.REFRESH_HOURS) || 0)
  : 0;
const MATCH_VERSION = 2;                         // bump to force a global re-match
const DEFAULT_MAX_PER_RUN = 500;                 // <-- edit me (or set MAX_PER_RUN env)
const MAX_PER_RUN = Math.max(1, Number(process.env.MAX_PER_RUN) || DEFAULT_MAX_PER_RUN);
const PACE_MS = 1100;                            // delay between EVERY network call
const RETRY_429_DELAY_MS = 20000;                // wait after a 429 before retrying
const MAX_TRIES = 3;                             // tries per request (429/5xx only)
const ABORT_AFTER_CONSECUTIVE_FAILS = 6;

// api.mangabaka.dev and api.mangabaka.org are interchangeable mirrors;
// .dev is the one the official docs + reference client use.
const MB = 'https://api.mangabaka.dev/v1';

// content_rating must be REPEATED (all four values), otherwise results are
// silently filtered to "safe" only.
const RATINGS = ['safe', 'suggestive', 'erotica', 'pornographic']
  .map((r) => 'content_rating=' + r).join('&');

const SEARCH_MB = (q) => `${MB}/series/search?q=${encodeURIComponent(q)}&${RATINGS}&page=1&limit=50`;
const SERIES_MB = (id) => `${MB}/series/${id}`;
const NEWS_MB   = (id) => `${MB}/series/${id}/news`;

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
      if (t.name) dict['name:' + t.name.toLowerCase()] = dict[t.id];
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
async function getJson(url) {
  let lastErr = 'unknown';
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    await sleep(PACE_MS);
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' } });
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

// ── candidate scoring ────────────────────────────────────────────────────────
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
const isNovelType = (t) => /novel/i.test(String(t || ''));

function candidateTitles(r) {
  const out = [r.title, r.native_title, r.romanized_title];
  const sec = r.secondary_titles;
  if (sec && typeof sec === 'object') {
    for (const arr of Object.values(sec)) {
      if (Array.isArray(arr)) for (const t of arr) out.push(t && (t.title || t.name || t));
    }
  }
  return out.filter(Boolean).map(String);
}

function titleScore(r, wanted) {
  const w = norm(wanted);
  if (!w) return 0;
  let best = 0;
  for (const t of candidateTitles(r)) {
    const n = norm(t);
    if (!n) continue;
    if (n === w) best = Math.max(best, 40);
    else if (n.startsWith(w) || w.startsWith(n)) best = Math.max(best, 25);
    else if (n.includes(w) || w.includes(n)) best = Math.max(best, 12);
  }
  return best;
}

// word-overlap between the Kitsu synopsis and a candidate's description —
// both usually derive from the same publisher blurb, so real matches overlap
// heavily while different works (e.g. novel vs unrelated manhwa) don't.
function synopsisScore(kitsuSyn, desc) {
  const toks = (s) => new Set(String(s || '').toLowerCase().match(/[a-z]{5,}/g) || []);
  const a = toks(kitsuSyn), b = toks(desc);
  if (a.size < 8 || b.size < 8) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return Math.round(25 * (inter / Math.min(a.size, b.size)));
}

function scoreCandidate(r, item, kid) {
  let s = 0;
  const kLink = r.source && r.source.kitsu && r.source.kitsu.id != null ? String(r.source.kitsu.id) : null;
  // linked to a DIFFERENT kitsu entry -> mangabaka says this is another series
  if (kLink && kLink !== kid) s -= 60;
  s += titleScore(r, item.title);
  // format agreement (kitsu subtype vs mangabaka type)
  const st = String(item.subtype || '').toLowerCase();
  const mt = String(r.type || '').toLowerCase();
  if (st && mt) s += (st === mt ? 15 : -8);     // both comics but manga-vs-manhwa mismatch is suspicious
  // year proximity
  const dy = (Number(item.year) && Number(r.year)) ? Math.abs(Number(item.year) - Number(r.year)) : null;
  if (dy !== null) s += dy === 0 ? 10 : dy === 1 ? 6 : dy <= 2 ? 3 : dy >= 6 ? -5 : 0;
  // publication status agreement (needs kitsuPubStatus from sync-library)
  if (item.kitsuPubStatus && r.status && mapStatus(r.status) === item.kitsuPubStatus) s += 6;
  // chapter-count proximity
  const kt = Number(item.total) || 0, mtot = Number(r.total_chapters) || Number(r.final_chapter) || 0;
  if (kt > 0 && mtot > 0) s += Math.round(8 * (Math.min(kt, mtot) / Math.max(kt, mtot)));
  // synopsis overlap (needs synopsis from sync-library)
  s += synopsisScore(item.synopsis, r.description);
  return s;
}

// returns { hit, match: {confidence, method, score} } or null
function pickMangabaka(results, item) {
  const kid = String(item[KITSU_ID_FIELD] || '');
  const usable = results.filter((r) => r && r.id != null);
  // 1. verified: mangabaka's own kitsu link equals our id — beats everything,
  //    including format (mangabaka occasionally types things differently).
  const linked = usable.find((r) => r.source && r.source.kitsu && String(r.source.kitsu.id) === kid);
  if (linked) return { hit: linked, match: { confidence: 'verified', method: 'kitsu-link', score: 100 } };
  // 2. scored fallback — novels excluded outright.
  const comics = usable.filter((r) => !isNovelType(r.type));
  if (!comics.length) return null;
  const scored = comics.map((r) => ({ r, s: scoreCandidate(r, item, kid) }))
    .sort((a, b) => b.s - a.s);
  const top = scored[0];
  if (top.s < 10) return null;                   // nothing plausibly the same work
  const confidence = top.s >= 60 ? 'high' : top.s >= 30 ? 'medium' : 'low';
  return { hit: top.r, match: { confidence, method: 'scored', score: top.s } };
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
  const picked = pickMangabaka(results, item);
  if (!picked) {
    logError(`no plausible mangabaka match for "${item.title}" (${results.length} results, novels excluded)`);
    return null;
  }
  const id = picked.hit.id;
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
    mangabakaUrl: `https://mangabaka.org/${id}`,
    match: picked.match,
    cover: coverUrl(d.cover),
    author: Array.isArray(d.authors) ? d.authors.join(', ') : (d.authors || ''),
    synopsis: d.description || '',
    status: mapStatus(d.status),
    // mangabaka's own rating; normalize to a 0–10 scale (their UI shows /100
    // in places), one decimal. null when absent so Kitsu's score stays.
    rating: (function () {
      let r = Number(d.rating);
      if (!isFinite(r) || r <= 0) return null;
      if (r > 10) r = r / 10;
      return Math.round(r * 10) / 10;
    })(),
    total: Number(d.total_chapters) || Number(d.final_chapter) || null,
    type: d.type || '',
    genres: Array.isArray(d.genres) ? d.genres.map((g) => (typeof g === 'string' ? g : g.name)).filter(Boolean) : [],
    tags: buildTags(d, dict),
    news,
    // Cross-links: `source` is keyed by tracker (kitsu/anilist/myanimelist/
    // mangaupdates/anime_planet/shikimori...), each { id, rating }. `links`
    // is a flat list of raw referrer URLs (may include a comick page — kept
    // as a plain outbound link; we never call comick's API).
    sources: d.source && typeof d.source === 'object'
      ? Object.fromEntries(Object.entries(d.source)
          .filter(([, v]) => v && v.id != null)
          .map(([k, v]) => [k, String(v.id)]))
      : {},
    links: Array.isArray(d.links) ? d.links.filter((u) => typeof u === 'string') : [],
  };
}

// fresh = entry exists, is recent, AND was matched by the current matcher.
function readEntry(kid) {
  try { return JSON.parse(fs.readFileSync(path.join(ENTRIES_DIR, kid + '.json'), 'utf8')); } catch { return null; }
}
function isFresh(kid) {
  const j = readEntry(kid);
  if (!j) return false;
  if ((j.matchVersion || 0) !== MATCH_VERSION) return false;   // matcher changed — re-match
  return j.updatedAt && (Date.now() - new Date(j.updatedAt).getTime() < REFRESH_HOURS * 3600000);
}

// comick was removed from the project — scrub its leftovers from old entries.
const OBSOLETE_KEYS = ['comickHid', 'comickSlug', 'comickVerified', 'chapters', 'chapterCount'];

async function main() {
  if (!fs.existsSync(LIB_FILE)) { console.warn('library.js missing — run sync-library.mjs first.'); return; }
  if (!fs.existsSync(ENTRIES_DIR)) fs.mkdirSync(ENTRIES_DIR, { recursive: true });
  const dict = loadTagDict();
  const lib = parseLibrary();
  const startedAt = Date.now();
  console.log(`enrich: ${lib.length} titles in library, cap ${MAX_PER_RUN}/run, pace ${PACE_MS}ms, match v${MATCH_VERSION}`);

  let done = 0, fails = 0, skipped = 0, noMatch = 0;
  for (const item of lib) {
    const kid = String(item[KITSU_ID_FIELD] || item.slug || item.title || '');
    if (!kid) continue;
    if (isFresh(kid)) { patchFromEntry(item, kid); skipped++; continue; }
    if (done >= MAX_PER_RUN) break;
    if (fails >= ABORT_AFTER_CONSECUTIVE_FAILS) {
      logError(`too many consecutive failures (${fails}) — stopping this run, will resume next time`);
      break;
    }

    const prev = readEntry(kid);
    // Seed from the previous entry so a transient failure keeps stale-but-real
    // data — then scrub fields from removed features.
    const entry = { ...(prev || {}), kitsuId: kid, title: item.title,
                    updatedAt: new Date().toISOString(), matchVersion: MATCH_VERSION };
    for (const k of OBSOLETE_KEYS) delete entry[k];

    try {
      const mb = await resolveMangabaka(item, dict);
      if (mb) {
        Object.assign(entry, mb);
      } else {
        noMatch++;
        // no plausible match — record that honestly instead of keeping a
        // possibly-wrong old match from a previous matcher version
        entry.mangabakaId = null; entry.match = { confidence: 'none', method: 'no-match', score: 0 };
      }
      fs.writeFileSync(path.join(ENTRIES_DIR, kid + '.json'), JSON.stringify(entry, null, 2));
      applyToLibrary(item, entry);
      done++; fails = 0;
      if (done % 10 === 0) {
        writeLibrary(lib); // checkpoint so a mid-run crash keeps progress
        console.log(`enrich: ${done}/${Math.min(MAX_PER_RUN, lib.length)} done (${Math.round((Date.now() - startedAt) / 60000)} min elapsed)`);
      }
    } catch (e) {
      logError(`mangabaka failed for "${item.title}" — ${e.message}`);
      fails++;
    }
  }

  writeLibrary(lib);
  console.log(`enrich: ${done} enriched (${noMatch} with no plausible match), ${skipped} fresh/skipped, ` +
    `finished in ${Math.round((Date.now() - startedAt) / 60000)} min (cap ${MAX_PER_RUN}).`);
}

// light fields onto the library row (grid, filters + notifications need these)
function applyToLibrary(item, e) {
  if (e.cover) item.cover = e.cover;
  if (e.author && !item.author) item.author = e.author;
  // total: mangabaka wins when it has one (it's usually the most current);
  // Kitsu's count stays as the fallback.
  if (e.total) item.total = e.total;
  // score: same policy — mangabaka's rating when present, Kitsu otherwise.
  if (e.rating != null) item.score = e.rating;
  if (e.status) item.mangabakaStatus = e.status;
  item.mangabakaId = e.mangabakaId || null;      // notify.mjs uses this to spot re-matches
  item.mangabakaUrl = e.mangabakaUrl || (e.mangabakaId ? 'https://mangabaka.org/' + e.mangabakaId : null);
  if (e.match) {                                 // Database.html reads these
    item.matchConfidence = e.match.confidence;
    item.matchMethod = e.match.method;
    item.matchScore = e.match.score;
  }
  if (e.genres) item.genres = e.genres;
  if (Array.isArray(e.tags)) item.tags = e.tags.map((t) => t && t.name).filter(Boolean);
  if (Array.isArray(e.news)) item.newsCount = e.news.length;
}
function patchFromEntry(item, kid) {
  const j = readEntry(kid);
  if (j) applyToLibrary(item, j);
}

main();
