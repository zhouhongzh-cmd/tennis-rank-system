import http from 'node:http';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.TENNIS_DB_FILE || path.join(__dirname, 'tennis.db');
const HTML_FILE = path.join(__dirname, 'tennis_ranks.html');
const LAYOUT_TEST_FILE = path.join(__dirname, 'layout_test.html');
const ASSETS_DIR = path.join(__dirname, 'assets');
const PASSWORD = process.env.TENNIS_ADMIN_PASSWORD;
const SESSION_COOKIE = 'tennis_auth';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INIT = 1500;
const K = 24;
const WEIGHT = { tiebreak7: 0.45, tiebreak11: 0.60, short4: 0.80, standard_set: 1.00 };

const sessions = new Map();
const db = new Database(DB_FILE);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  mode TEXT NOT NULL,
  match_type TEXT NOT NULL,
  team_a_player_1_id INTEGER NOT NULL REFERENCES players(id),
  team_a_player_2_id INTEGER REFERENCES players(id),
  team_b_player_1_id INTEGER NOT NULL REFERENCES players(id),
  team_b_player_2_id INTEGER REFERENCES players(id),
  team_a_score INTEGER NOT NULL,
  team_b_score INTEGER NOT NULL,
  winner_team TEXT NOT NULL,
  format_weight REAL NOT NULL,
  score_multiplier REAL NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS player_ratings (
  player_id INTEGER NOT NULL REFERENCES players(id),
  mode TEXT NOT NULL,
  current_rating REAL NOT NULL DEFAULT 1500,
  total_matches INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (player_id, mode)
);

CREATE TABLE IF NOT EXISTS rating_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  player_id INTEGER NOT NULL REFERENCES players(id),
  rating_before REAL NOT NULL,
  rating_after REAL NOT NULL,
  rating_delta REAL NOT NULL,
  k_value REAL NOT NULL DEFAULT 24,
  expected_score REAL NOT NULL,
  actual_score REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_match_mode_date ON matches(mode, date, id);
CREATE INDEX IF NOT EXISTS idx_rh_player_mode ON rating_history(player_id, mode);
`);

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function setCookie(res, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (options.maxAge != null) parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
  if (options.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function authStatus(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    sessions.delete(token);
    return false;
  }
  return true;
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('请求体过大');
  }
  if (!raw) return {};
  return JSON.parse(raw);
}

function safeJsonForHtml(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\\u2028', '\\u2028')
    .replaceAll('\\u2029', '\\u2029');
}

function sendHtml(res) {
  readFile(HTML_FILE, 'utf8')
    .then((html) => {
      const bootstrap = safeJsonForHtml({ state: exportState() });
      const body = html.replace(
        'window.__TENNIS_BOOTSTRAP__ = null;',
        `window.__TENNIS_BOOTSTRAP__ = ${bootstrap};`,
      );
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=30, s-maxage=60',
      });
      res.end(body);
    })
    .catch((err) => text(res, 500, `无法读取页面: ${err.message}`));
}

function sendLayoutTest(res) {
  readFile(LAYOUT_TEST_FILE)
    .then((body) => {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
      });
      res.end(body);
    })
    .catch((err) => text(res, 500, `无法读取测试页: ${err.message}`));
}

function sendAsset(res, pathname) {
  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname.slice('/assets/'.length));
  } catch {
    text(res, 400, 'Bad Request');
    return;
  }

  const filePath = path.resolve(ASSETS_DIR, relativePath);
  if (!filePath.startsWith(`${ASSETS_DIR}${path.sep}`)) {
    text(res, 403, 'Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml; charset=utf-8',
  }[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, body) => {
    if (err) {
      text(res, err.code === 'ENOENT' ? 404 : 500, err.code === 'ENOENT' ? 'Not Found' : '无法读取资源');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': body.length,
      'Cache-Control': 'public, max-age=2592000, immutable',
    });
    res.end(body);
  });
}

function issueSession(res) {
  const token = createHash('sha256').update(randomUUID()).digest('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  setCookie(res, SESSION_COOKIE, token, { maxAge: SESSION_TTL_MS });
}

function revokeSession(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  clearCookie(res, SESSION_COOKIE);
}

function expected(rTeam, rOpp) {
  return 1 / (1 + Math.pow(10, (rOpp - rTeam) / 400));
}

function scoreMultiplier(type, sa, sb) {
  const w = Math.max(sa, sb);
  const l = Math.min(sa, sb);
  const d = w - l;
  if (type === 'tiebreak7') return d <= 2 ? 0.90 : d === 3 ? 1.00 : d <= 5 ? 1.10 : 1.20;
  if (type === 'tiebreak11') return d <= 2 ? 0.90 : d <= 4 ? 1.00 : d <= 6 ? 1.10 : 1.20;
  if (type === 'short4') return ({ 1: 0.90, 2: 1.00, 3: 1.12 })[d] ?? 1.20;
  if (type === 'standard_set') {
    const t = { '7,6': 0.85, '7,5': 0.95, '6,4': 1.00, '6,3': 1.08, '6,2': 1.15, '6,1': 1.20, '6,0': 1.25 };
    return t[`${w},${l}`] ?? ({ 1: 0.85, 2: 0.95, 3: 1.08, 4: 1.15, 5: 1.20 }[d] ?? 1.25);
  }
  return 1.0;
}

function normalizeTeam(team, mode, label) {
  if (!Array.isArray(team)) throw new Error(`${label} 队数据无效`);
  const expectedCount = mode === 'doubles' ? 2 : 1;
  if (team.length !== expectedCount) throw new Error(`${label} 队人数不正确`);
  const ids = team.map((v) => Number(v));
  if (ids.some((n) => !Number.isInteger(n))) throw new Error(`${label} 队球员无效`);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} 队球员重复`);
  return ids;
}

function computeMatchDeltas(ratings, match) {
  const ra = match.a.reduce((sum, id) => sum + ratings[id], 0) / match.a.length;
  const rb = match.b.reduce((sum, id) => sum + ratings[id], 0) / match.b.length;
  const eA = expected(ra, rb);
  const eB = 1 - eA;
  const f = K * WEIGHT[match.type] * scoreMultiplier(match.type, match.sa, match.sb);
  const aWin = match.sa > match.sb;
  const out = new Map();
  for (const id of match.a) out.set(id, { e: eA, s: aWin ? 1 : 0, delta: f * ((aWin ? 1 : 0) - eA) });
  for (const id of match.b) out.set(id, { e: eB, s: aWin ? 0 : 1, delta: f * ((aWin ? 0 : 1) - eB) });
  return out;
}

function exportState() {
  const players = db.prepare(`
    SELECT id, name, created_at, updated_at
    FROM players
    ORDER BY id
  `).all().map((row) => ({
    id: row.id,
    name: row.name,
    created: row.created_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));

  const matches = db.prepare(`
    SELECT id, date, mode, match_type, team_a_player_1_id, team_a_player_2_id,
           team_b_player_1_id, team_b_player_2_id, team_a_score, team_b_score,
           winner_team, format_weight, score_multiplier, note, created_at
    FROM matches
    ORDER BY date, id
  `).all().map((row) => ({
    id: row.id,
    date: row.date,
    mode: row.mode,
    type: row.match_type,
    match_type: row.match_type,
    a: [row.team_a_player_1_id, row.team_a_player_2_id].filter((v) => v !== null),
    b: [row.team_b_player_1_id, row.team_b_player_2_id].filter((v) => v !== null),
    sa: row.team_a_score,
    sb: row.team_b_score,
    note: row.note ?? '',
    winner_team: row.winner_team,
    format_weight: row.format_weight,
    score_multiplier: row.score_multiplier,
    created_at: row.created_at,
  }));

  return { players, matches };
}

function rebuildDerivedTables() {
  db.prepare('DELETE FROM rating_history').run();
  db.prepare('DELETE FROM player_ratings').run();

  const players = db.prepare('SELECT id FROM players ORDER BY id').all().map((row) => row.id);
  const matchesByMode = {
    singles: db.prepare(`
      SELECT *
      FROM matches
      WHERE mode = ?
      ORDER BY date, id
    `),
    doubles: db.prepare(`
      SELECT *
      FROM matches
      WHERE mode = ?
      ORDER BY date, id
    `),
  };

  const insertHistory = db.prepare(`
    INSERT INTO rating_history (
      match_id, mode, player_id, rating_before, rating_after, rating_delta,
      k_value, expected_score, actual_score
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertRating = db.prepare(`
    INSERT INTO player_ratings (
      player_id, mode, current_rating, total_matches, wins, losses, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  for (const mode of ['singles', 'doubles']) {
    const ratings = Object.fromEntries(players.map((id) => [id, INIT]));
    const stats = Object.fromEntries(players.map((id) => [id, { rating: INIT, n: 0, w: 0, l: 0 }]));
    const rows = matchesByMode[mode].all(mode);

    for (const row of rows) {
      const match = {
        a: [row.team_a_player_1_id, row.team_a_player_2_id].filter((v) => v !== null),
        b: [row.team_b_player_1_id, row.team_b_player_2_id].filter((v) => v !== null),
        sa: row.team_a_score,
        sb: row.team_b_score,
        type: row.match_type,
      };
      const deltas = computeMatchDeltas(ratings, match);
      const aWin = row.team_a_score > row.team_b_score;

      for (const id of [...match.a, ...match.b]) {
        const before = ratings[id];
        const detail = deltas.get(id);
        const after = before + detail.delta;
        ratings[id] = after;

        stats[id].rating = after;
        stats[id].n += 1;
        const win = match.a.includes(id) ? aWin : !aWin;
        if (win) stats[id].w += 1;
        else stats[id].l += 1;

        insertHistory.run(
          row.id,
          mode,
          id,
          before,
          after,
          detail.delta,
          K,
          detail.e,
          detail.s,
        );
      }
    }

    for (const id of players) {
      const stat = stats[id];
      insertRating.run(id, mode, stat.rating, stat.n, stat.w, stat.l);
    }
  }
}

const rewriteState = db.transaction((payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('无效的数据格式');
  const playersInput = Array.isArray(payload.players) ? payload.players : [];
  const matchesInput = Array.isArray(payload.matches) ? payload.matches : [];

  const seenNames = new Set();
  const oldToNew = new Map();
  const now = new Date().toISOString();

  const normalizedPlayers = playersInput.map((player, index) => {
    if (!player || typeof player !== 'object') throw new Error(`球员 ${index + 1} 数据无效`);
    const name = String(player.name || '').trim();
    if (!name) throw new Error(`球员 ${index + 1} 姓名不能为空`);
    if (seenNames.has(name)) throw new Error(`球员姓名重复：${name}`);
    seenNames.add(name);
    const sourceId = String(player.id ?? `tmp-${index}`);
    return {
      sourceId,
      name,
      created_at: String(player.created_at || player.created || now),
      updated_at: String(player.updated_at || player.updated || player.created_at || player.created || now),
    };
  });

  db.prepare('DELETE FROM rating_history').run();
  db.prepare('DELETE FROM player_ratings').run();
  db.prepare('DELETE FROM matches').run();
  db.prepare('DELETE FROM players').run();

  const insertPlayer = db.prepare(`
    INSERT INTO players (name, created_at, updated_at)
    VALUES (?, ?, ?)
  `);
  for (const player of normalizedPlayers) {
    const info = insertPlayer.run(player.name, player.created_at, player.updated_at);
    oldToNew.set(player.sourceId, Number(info.lastInsertRowid));
  }

  const insertMatch = db.prepare(`
    INSERT INTO matches (
      date, mode, match_type,
      team_a_player_1_id, team_a_player_2_id,
      team_b_player_1_id, team_b_player_2_id,
      team_a_score, team_b_score,
      winner_team, format_weight, score_multiplier, note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const normalizedMatches = matchesInput.map((match, index) => {
    if (!match || typeof match !== 'object') throw new Error(`比赛 ${index + 1} 数据无效`);
    const mode = match.mode === 'singles' ? 'singles' : match.mode === 'doubles' ? 'doubles' : null;
    if (!mode) throw new Error(`比赛 ${index + 1} 模式无效`);
    const type = String(match.type || match.match_type || '');
    if (!Object.hasOwn(WEIGHT, type)) throw new Error(`比赛 ${index + 1} 赛制无效`);
    const a = normalizeTeam(match.a, mode, 'A');
    const b = normalizeTeam(match.b, mode, 'B');
    const ids = [...a, ...b];
    if (new Set(ids).size !== ids.length) throw new Error(`比赛 ${index + 1} 中存在重复球员`);
    const date = String(match.date || '').trim() || now.slice(0, 10);
    const sa = Number(match.sa);
    const sb = Number(match.sb);
    if (!Number.isInteger(sa) || !Number.isInteger(sb)) throw new Error(`比赛 ${index + 1} 比分无效`);
    if (sa === sb) throw new Error(`比赛 ${index + 1} 比分不能相同`);
    const note = match.note == null ? null : String(match.note);
    const created_at = String(match.created_at || match.created || now);
    return {
      mode,
      type,
      a,
      b,
      sa,
      sb,
      date,
      note,
      created_at,
      winner_team: sa > sb ? 'A' : 'B',
      format_weight: WEIGHT[type],
      score_multiplier: scoreMultiplier(type, sa, sb),
    };
  });

  for (const match of normalizedMatches) {
    const mappedA = match.a.map((id) => {
      const newId = oldToNew.get(String(id));
      if (!newId) throw new Error(`比赛引用了不存在的球员：${id}`);
      return newId;
    });
    const mappedB = match.b.map((id) => {
      const newId = oldToNew.get(String(id));
      if (!newId) throw new Error(`比赛引用了不存在的球员：${id}`);
      return newId;
    });
    if (new Set([...mappedA, ...mappedB]).size !== mappedA.length + mappedB.length) {
      throw new Error('比赛中存在重复球员');
    }
    insertMatch.run(
      match.date,
      match.mode,
      match.type,
      mappedA[0],
      mappedA[1] ?? null,
      mappedB[0],
      mappedB[1] ?? null,
      match.sa,
      match.sb,
      match.winner_team,
      match.format_weight,
      match.score_multiplier,
      match.note,
      match.created_at,
    );
  }

  rebuildDerivedTables();
  return exportState();
});

function loadLegacyJsonIfNeeded() {
  const hasRows = db.prepare('SELECT COUNT(*) AS n FROM players').get().n > 0
    || db.prepare('SELECT COUNT(*) AS n FROM matches').get().n > 0;
  const legacyPath = path.join(__dirname, 'tennis-data.json');
  if (hasRows || !fs.existsSync(legacyPath)) return;
  try {
    const raw = fs.readFileSync(legacyPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    rewriteState(parsed);
  } catch (err) {
    console.warn(`[tennis] legacy JSON import skipped: ${err.message}`);
  }
}

loadLegacyJsonIfNeeded();

function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/tennis_ranks.html')) {
    sendHtml(res);
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/layout-test' || url.pathname === '/layout_test.html')) {
    sendLayoutTest(res);
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
    sendAsset(res, url.pathname);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    json(res, 200, exportState());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/me') {
    json(res, 200, { canWrite: authStatus(req) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    readBody(req)
      .then((body) => {
        const password = String(body.password || '');
        if (password !== PASSWORD) {
          json(res, 401, { error: '密码错误' });
          return;
        }
        issueSession(res);
        json(res, 200, { ok: true, canWrite: true });
      })
      .catch((err) => json(res, 400, { error: err.message || '登录失败' }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    revokeSession(req, res);
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === 'PUT' && url.pathname === '/api/state') {
    if (!authStatus(req)) {
      json(res, 401, { error: '未授权' });
      return;
    }
    readBody(req)
      .then((body) => {
        const state = rewriteState(body);
        json(res, 200, state);
      })
      .catch((err) => json(res, 400, { error: err.message || '保存失败' }));
    return;
  }

  text(res, 404, 'Not Found');
}

process.on('unhandledRejection', (err) => {
  console.error(err);
});

if (!PASSWORD) {
  console.error('[tennis] TENNIS_ADMIN_PASSWORD 未设置，服务已停止。');
  process.exit(1);
}

http.createServer(route).listen(PORT, () => {
  console.log(`[tennis] listening on http://127.0.0.1:${PORT}`);
});
