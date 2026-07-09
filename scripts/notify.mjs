// notify.mjs — turns library changes into notifications and PERSISTS them.
//
// Persistence (so notices never reset between runs):
//   notifications/notification_DD-MM-YYYY.js   one file per day, appended to
//   notifications.js                           rolling aggregate the page reads
//   notify_state.json                          last-seen snapshot, for diffing
// Files older than RETENTION_DAYS are auto-deleted (change it like the Kitsu ID).
//
// What gets a notice (for EVERY entry — no follow filtering):
//   * publication-status change -> hiatus / cancelled / resumed / completed
//   * new news                  -> when a title's mangabaka news count rises
// Publication status comes ONLY from mangabaka (`mangabakaStatus`); the
// user's reading status (`status`) is never part of the diff. When a title's
// matched mangabaka series changes (re-match), the transition is recorded
// silently — comparing statuses across two different series is meaningless.
// News uses `newsCount`, written by scripts/enrich.mjs.

import fs from 'node:fs';
import path from 'node:path';

const RETENTION_DAYS = 30;                 // <-- change retention here
const LIB_FILE = path.join(process.cwd(), 'library.js');
const STATE_FILE = path.join(process.cwd(), 'notify_state.json');
const NOTIF_DIR = path.join(process.cwd(), 'notifications');
const OUT_FILE = path.join(process.cwd(), 'notifications.js');

function parseAssign(file, name) {
  if (!fs.existsSync(file)) return null;
  const txt = fs.readFileSync(file, 'utf8');
  const m = txt.match(new RegExp(name + '\\s*=\\s*(\\[[\\s\\S]*\\]);'));
  if (!m) return null;
  try { return (new Function('return ' + m[1]))(); } catch { return null; }
}
const loadLibrary = () => parseAssign(LIB_FILE, 'window\\.libraryData') || [];
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { titles: {} };
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { titles: {} }; }
}

const keyOf = (m, i) => String(m.kitsuId || m.slug || m.title || i);
const dstamp = (d) => String(d.getDate()).padStart(2, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + d.getFullYear();

function mk(kind, m, text) {
  return { id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
           kind, title: m.title, kitsuId: m.kitsuId || null,
           text, unread: true, at: new Date().toISOString() };
}

function main() {
  const lib = loadLibrary();
  const prev = (loadState().titles) || {};
  const fresh = [];
  const curTitles = {};

  lib.forEach((m, i) => {
    const k = keyOf(m, i);
    // PUBLICATION status only (mangabaka). Never mix in m.status — that's the
    // user's READING status ('Reading', 'Plan to Read', ...) and mixing the
    // two once produced a bogus "Reading → Releasing" notice for every title.
    const pub = m.mangabakaStatus || '';
    const mbId = m.mangabakaId || null;
    const newsCount = Number(m.newsCount) || 0;
    curTitles[k] = { title: m.title, pub, mbId, newsCount };
    const before = prev[k];
    if (!before) return;                                   // first sighting — don't announce
    // Older state files stored a mixed `status` and no `pub`/`mbId` — treat
    // that as a first sighting under the new schema (records, no announce).
    if (before.pub === undefined) return;
    // The matched mangabaka series changed (re-match, e.g. after a matcher
    // fix) — a status "change" across two different series is meaningless.
    if (before.mbId && mbId && before.mbId !== mbId) return;

    // Publication status change — every entry
    if (before.pub !== pub && pub) {
      if (pub === 'Completed') fresh.push(mk('completed', m, `Marked Completed.`));
      else if (/hiatus|on hold/i.test(pub)) fresh.push(mk('hiatus', m, 'Status changed to ' + pub + '.'));
      else if (/cancel|dropped/i.test(pub)) fresh.push(mk('cancelled', m, 'Status changed to ' + pub + '.'));
      else if (/releasing/i.test(pub) && /hiatus|on hold/i.test(before.pub)) fresh.push(mk('resumed', m, 'Resumed — back to ' + pub + '.'));
      else if (before.pub) fresh.push(mk('status', m, 'Status: ' + before.pub + ' → ' + pub + '.'));
    }
    // New news — every entry
    if (newsCount > (before.newsCount || 0) && before.newsCount > 0) {
      const d = newsCount - before.newsCount;
      fresh.push(mk('news', m, `${d} new news post${d === 1 ? '' : 's'}.`));
    }
  });

  // Persist today's fresh notices
  if (!fs.existsSync(NOTIF_DIR)) fs.mkdirSync(NOTIF_DIR, { recursive: true });
  if (fresh.length) {
    const today = dstamp(new Date());
    const dayFile = path.join(NOTIF_DIR, `notification_${today}.js`);
    const existing = parseAssign(dayFile, 'window\\.notificationsDay') || [];
    fs.writeFileSync(dayFile, `// notices generated ${today}\nwindow.notificationsDay = ${JSON.stringify(fresh.concat(existing), null, 2)};\n`);
  }

  // Prune old daily files
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  for (const f of fs.readdirSync(NOTIF_DIR)) {
    const mm = f.match(/^notification_(\d{2})-(\d{2})-(\d{4})\.js$/);
    if (!mm) continue;
    if (new Date(`${mm[3]}-${mm[2]}-${mm[1]}T00:00:00`).getTime() < cutoff) {
      try { fs.unlinkSync(path.join(NOTIF_DIR, f)); } catch {}
    }
  }

  // Aggregate -> notifications.js (newest first)
  let all = [];
  for (const f of fs.readdirSync(NOTIF_DIR)) {
    if (!/^notification_\d{2}-\d{2}-\d{4}\.js$/.test(f)) continue;
    all = all.concat(parseAssign(path.join(NOTIF_DIR, f), 'window\\.notificationsDay') || []);
  }
  all.sort((a, b) => new Date(b.at) - new Date(a.at));
  const withTime = all.map(n => ({ ...n, time: relTime(n.at) }));
  fs.writeFileSync(OUT_FILE, `// AUTO-GENERATED by scripts/notify.mjs — aggregate of notifications/ (last ${RETENTION_DAYS} days).\nwindow.notificationsData = ${JSON.stringify(withTime, null, 2)};\n`);

  fs.writeFileSync(STATE_FILE, JSON.stringify({ titles: curTitles, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(`notify: +${fresh.length} new, ${withTime.length} total across last ${RETENTION_DAYS} days.`);
}

function relTime(iso) {
  if (!iso) return '';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const h = Math.floor(mins / 60); if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24); if (d < 7) return d + 'd ago';
  const w = Math.floor(d / 7); if (w < 5) return w + 'w ago';
  return Math.floor(d / 30) + 'mo ago';
}

main();
