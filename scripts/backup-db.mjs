import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const dbFile = path.resolve(process.env.TENNIS_DB_FILE || path.join(repoRoot, 'data', 'tennis.db'));
const backupDir = path.resolve(process.env.TENNIS_BACKUP_DIR || path.join(path.dirname(dbFile), 'backups'));
const retentionDays = Number.parseInt(process.env.TENNIS_BACKUP_RETENTION_DAYS || '30', 10);

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function removeOldBackups() {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const entry of fs.readdirSync(backupDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/^tennis-\d{8}-\d{6}\.db$/.test(entry.name)) continue;

    const fullPath = path.join(backupDir, entry.name);
    const stat = fs.statSync(fullPath);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(fullPath);
      removed += 1;
    }
  }

  return removed;
}

if (!fs.existsSync(dbFile)) {
  console.error(`[backup] database not found: ${dbFile}`);
  process.exit(1);
}

fs.mkdirSync(backupDir, { recursive: true });

const finalPath = path.join(backupDir, `tennis-${stamp()}.db`);
const tmpPath = `${finalPath}.tmp`;

try {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  await db.backup(tmpPath);
  db.close();

  fs.renameSync(tmpPath, finalPath);
  const removed = removeOldBackups();
  const size = fs.statSync(finalPath).size;

  console.log(`[backup] created ${finalPath} (${size} bytes), removed ${removed} old backup(s)`);
} catch (err) {
  try {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  } catch {}
  console.error(`[backup] failed: ${err?.stack || err}`);
  process.exit(1);
}
