// Node.js port of fetch_manga_stats.vbs — same logic, same file format,
// meant to run in GitHub Actions instead of Windows Task Scheduler.

import fs from 'node:fs';
import path from 'node:path';

const DATA_FILE = path.join(process.cwd(), 'manga_history_data.js');
const ERROR_LOG = path.join(process.cwd(), 'sync_errors.log');
const DAILY_BACKUP_DIR = path.join(process.cwd(), 'daily_backup');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const ANOMALY_THRESHOLD = 500; // flag jumps of this many chapters or more instead of trusting them
const KITSU_URL = 'https://kitsu.app/api/edge/users/1699796/stats';
const KEEP_DAILY_BACKUPS = 30; // days of dated backups to retain before auto-deleting older ones

function logError(msg) {
  const line = `[${new Date().toString()}] ${msg}\n`;
  fs.appendFileSync(ERROR_LOG, line);
  console.error(msg);
}

// Matches the VBS date format: "02-Jul-26 6:26:11 AM"
function formatVBSStyle(d) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dd = String(d.getDate()).padStart(2, '0');
  const mon = months[d.getMonth()];
  const yy = String(d.getFullYear()).slice(-2);
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${dd}-${mon}-${yy} ${h}:${mm}:${ss} ${ampm}`;
}

async function fetchWithRetry() {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${KITSU_URL}?cachebuster=${Date.now()}`, {
        headers: {
          Accept: 'application/vnd.api+json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Pragma: 'no-cache',
        },
      });
      lastStatus = res.status;
      if (res.ok) return await res.text();
      logError(`Attempt ${attempt}/${MAX_RETRIES} failed - HTTP status ${res.status}`);
    } catch (err) {
      logError(`Attempt ${attempt}/${MAX_RETRIES} failed - request error: ${err.message}`);
    }
    if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  logError(`SYNC FAILED after ${MAX_RETRIES} attempts - last status: ${lastStatus}`);
  process.exit(1);
}

function extractUnits(json) {
  let pos = json.indexOf('"kind":"manga-amount-consumed"');
  if (pos === -1) pos = json.indexOf('"kind": "manga-amount-consumed"');
  if (pos === -1) {
    logError("SYNC FAILED - 'manga-amount-consumed' kind not found in API response (unexpected payload)");
    process.exit(1);
  }
  const chunk = json.slice(pos, pos + 300);
  const match = chunk.match(/"units"\s*:\s*(\d+)/);
  if (!match) {
    logError("SYNC FAILED - could not parse 'units' value from response chunk near manga-amount-consumed");
    process.exit(1);
  }
  return parseInt(match[1], 10);
}

function loadExisting() {
  if (!fs.existsSync(DATA_FILE)) return [];
  const content = fs.readFileSync(DATA_FILE, 'utf8');
  const arrayMatch = content.match(/const mangaHistoryData\s*=\s*(\[[\s\S]*\]);/);
  if (!arrayMatch) return [];
  // The data file only ever contains data we generated ourselves, so this is safe.
  const build = new Function(`return ${arrayMatch[1]};`);
  return build();
}

function serialize(entries) {
  const lines = entries.map(
    (e) => `  { date1: "${e.date1}", date2: "${e.date2}", chapters: ${e.chapters} }`
  );
  return `const mangaHistoryData = [\n${lines.join(',\n')}\n];\n`;
}

function backup() {
  if (!fs.existsSync(DATA_FILE)) return;
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');

  if (!fs.existsSync(DAILY_BACKUP_DIR)) fs.mkdirSync(DAILY_BACKUP_DIR, { recursive: true });

  const dated = path.join(DAILY_BACKUP_DIR, `manga_history_data_${y}${m}${d}.bak.js`);
  const rolling = path.join(process.cwd(), 'manga_history_data.bak');
  try {
    fs.copyFileSync(DATA_FILE, rolling);
    fs.copyFileSync(DATA_FILE, dated);
  } catch (err) {
    logError(`WARNING: backup copy failed - ${err.message}`);
  }

  pruneOldBackups();
}

function pruneOldBackups() {
  if (!fs.existsSync(DAILY_BACKUP_DIR)) return;
  const cutoff = Date.now() - KEEP_DAILY_BACKUPS * 24 * 60 * 60 * 1000;
  const pattern = /^manga_history_data_(\d{4})(\d{2})(\d{2})\.bak\.js$/;

  for (const file of fs.readdirSync(DAILY_BACKUP_DIR)) {
    const match = file.match(pattern);
    if (!match) continue;
    const [, yy, mm, dd] = match;
    const fileDate = new Date(`${yy}-${mm}-${dd}T00:00:00`).getTime();
    if (fileDate < cutoff) {
      try {
        fs.unlinkSync(path.join(DAILY_BACKUP_DIR, file));
      } catch (err) {
        logError(`WARNING: failed to prune old backup ${file} - ${err.message}`);
      }
    }
  }
}

async function main() {
  const json = await fetchWithRetry();
  const units = extractUnits(json);
  const entries = loadExisting();
  const now = new Date();
  const fmt = formatVBSStyle(now);

  if (entries.length === 0) {
    entries.push({ date1: fmt, date2: fmt, chapters: units });
    fs.writeFileSync(DATA_FILE, serialize(entries));
    console.log(`Initialized data file with ${units} chapters.`);
    return;
  }

  const last = entries[entries.length - 1];
  const diff = units - last.chapters;

  if (diff >= ANOMALY_THRESHOLD) {
    logError(
      `ANOMALY - new units value ${units} is ${diff} higher than last recorded ${last.chapters} ` +
        `(threshold ${ANOMALY_THRESHOLD}). Entry skipped - review manually before re-running.`
    );
    process.exit(1);
  }

  backup();

  if (units === last.chapters) {
    // Same number: just refresh the "last checked" timestamp on the final entry.
    last.date2 = fmt;
    console.log(`No new chapters. Updated last-checked time to ${fmt}.`);
  } else {
    entries.push({ date1: fmt, date2: fmt, chapters: units });
    console.log(`New entry: ${units} chapters at ${fmt}.`);
  }

  fs.writeFileSync(DATA_FILE, serialize(entries));
}

main();
