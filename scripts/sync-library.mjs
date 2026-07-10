// sync-library.mjs — pulls your full Kitsu manga library (per title) and
// writes it to library.js as `window.libraryData = [...]`, the file the
// Library page reads. Companion to sync.mjs (which only tracks the single
// aggregate chapter count). Runs in GitHub Actions; browsers can't call
// Kitsu directly (CORS), so this must run server-side.
//
// Kitsu returns JSON:API "compound documents": each library-entry only
// references its manga by id; the manga objects arrive in a separate
// top-level `included` array and are joined here by hand.
//
// Pointing at your own account: change KITSU_USER_ID below. Find yours via
//   https://kitsu.app/api/edge/users?filter[name]=YOUR_USERNAME  -> data[0].id

import fs from 'node:fs';
import path from 'node:path';

const KITSU_USER_ID = '1699796';
const OUT_FILE = path.join(process.cwd(), 'library.js');
const ERROR_LOG = path.join(process.cwd(), 'sync_errors.log');
const PAGE_LIMIT = 40;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// Same field set the Kitsu web app requests for its library view.
const MANGA_FIELDS = [
  'slug', 'posterImage', 'canonicalTitle', 'titles', 'description', 'subtype',
  'startDate', 'status', 'averageRating', 'popularityRank', 'ratingRank',
  'chapterCount', 'volumeCount',
].join(',');

const BASE = 'https://kitsu.app/api/edge/library-entries';

// Kitsu status -> UI label. `dropped` is kept as its own bucket (do not
// fold it into anything else); `on_hold`/`planned` are just relabels.
const STATUS_LABEL = {
  current: 'Reading',
  completed: 'Completed',
  on_hold: 'On Hold',
  planned: 'Plan to Read',
  dropped: 'Dropped',
};

// Kitsu MANGA publication status (attributes.status on the manga object,
// distinct from the library-entry reading status above). Used by enrich.mjs
// as a matching signal and kept on the row for display.
const PUB_LABEL = {
  current: 'Releasing',
  finished: 'Completed',
  tba: 'Upcoming',
  unreleased: 'Upcoming',
  upcoming: 'Upcoming',
};

function logError(msg) {
  fs.appendFileSync(ERROR_LOG, `[${new Date().toString()}] [library] ${msg}\n`);
  console.error(msg);
}

function buildUrl(offset) {
  const p = new URLSearchParams();
  p.set('fields[manga]', MANGA_FIELDS);
  p.set('fields[users]', 'id');
  p.set('filter[kind]', 'manga');
  p.set('filter[user_id]', KITSU_USER_ID);
  p.set('include', 'manga');
  p.set('page[limit]', String(PAGE_LIMIT));
  p.set('page[offset]', String(offset));
  p.set('sort', 'status,-progressed_at');
  return `${BASE}?${p.toString()}`;
}

async function fetchJson(url) {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/vnd.api+json' } });
      lastStatus = res.status;
      if (res.ok) return await res.json();
      logError(`Attempt ${attempt}/${MAX_RETRIES} - HTTP ${res.status} for ${url}`);
    } catch (err) {
      logError(`Attempt ${attempt}/${MAX_RETRIES} - ${err.message}`);
    }
    if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  logError(`LIBRARY SYNC FAILED after ${MAX_RETRIES} attempts (last status ${lastStatus})`);
  process.exit(1);
}

// Stable hue from a string, so titles without a cover still get a tint.
function hueFromString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function relativeUpdated(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 60) return mins <= 1 ? 'just now' : `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

async function main() {
  const entries = [];
  const mangaById = new Map();
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const json = await fetchJson(buildUrl(offset));
    const data = json.data || [];
    for (const inc of json.included || []) {
      if (inc.type === 'manga') mangaById.set(inc.id, inc.attributes || {});
    }
    for (const e of data) entries.push(e);
    total = json.meta && typeof json.meta.count === 'number' ? json.meta.count : data.length;
    if (!data.length) break;
    offset += PAGE_LIMIT;
  }

  const library = entries.map((e) => {
    const a = e.attributes || {};
    const mangaId = e.relationships && e.relationships.manga && e.relationships.manga.data
      ? e.relationships.manga.data.id : null;
    const m = (mangaId && mangaById.get(mangaId)) || {};

    const titles = m.titles || {};
    const title = m.canonicalTitle || titles.en || titles.en_jp || titles.ja_jp || 'Untitled';
    const poster = m.posterImage || {};
    const cover = poster.small || poster.medium || poster.original || poster.large || poster.tiny || '';
    const read = Number(a.progress) || 0;
    // NOTE: Kitsu chapterCount is frequently null; total then falls back to
    // read count until enriched from mangabaka (Entry-page phase).
    const total = Number(m.chapterCount) || null;
    // averageRating is a 0-100 string; show as 0-10. Fallback to user rating.
    const avg = m.averageRating ? Math.round((parseFloat(m.averageRating) / 10) * 10) / 10 : null;
    const userScore = a.ratingTwenty ? Math.round((a.ratingTwenty / 2) * 10) / 10 : null;
    const year = m.startDate ? Number(String(m.startDate).slice(0, 4)) : null;

    return {
      kitsuId: mangaId,
      slug: m.slug || '',
      url: m.slug ? `https://kitsu.app/manga/${m.slug}` : '',
      title,
      author: '',                       // not in Kitsu manga fields — filled from mangabaka later
      status: STATUS_LABEL[a.status] || a.status || '',
      read,
      total,
      score: avg != null ? avg : userScore,
      year,
      subtype: m.subtype || '',         // manga / manhwa / manhua / novel …
      kitsuPubStatus: PUB_LABEL[m.status] || '',
      // trimmed Kitsu description — enrich.mjs compares it against mangabaka
      // candidates' descriptions as a matching signal
      synopsis: String(m.description || '').replace(/\s+/g, ' ').trim().slice(0, 600),
      cover,
      hue: hueFromString(title),
      updated: relativeUpdated(a.progressedAt),
      progressedAt: a.progressedAt || null,
    };
  });

  const header = `// AUTO-GENERATED by scripts/sync-library.mjs — do not edit by hand.\n` +
    `// ${library.length} entries · generated ${new Date().toISOString()}\n`;
  fs.writeFileSync(OUT_FILE, `${header}window.libraryData = ${JSON.stringify(library, null, 2)};\n`);
  console.log(`Wrote ${library.length} library entries to library.js`);
}

main();
