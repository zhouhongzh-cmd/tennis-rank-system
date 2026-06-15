import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const unitTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tennis-unit-'));
process.env.TENNIS_NO_LISTEN = '1';
process.env.TENNIS_DB_FILE = path.join(unitTmp, 'tennis.db');
process.env.TENNIS_ADMIN_PASSWORD = 'unit-secret';

const {
  scoreMultiplier,
  validateScoreByType,
  computeMatchDeltas,
  rewriteState,
  exportState,
} = await import('../server.js');

function assertValid(type, sa, sb) {
  assert.equal(validateScoreByType(type, sa, sb), null, `${type} ${sa}:${sb} should be valid`);
}

function assertInvalid(type, sa, sb) {
  assert.notEqual(validateScoreByType(type, sa, sb), null, `${type} ${sa}:${sb} should be invalid`);
}

function testScoreValidation() {
  assertValid('standard_set', 6, 4);
  assertValid('standard_set', 7, 6);
  assertInvalid('standard_set', 70, 4);
  assertInvalid('standard_set', 5, 3);

  assertValid('tiebreak7', 7, 5);
  assertValid('tiebreak7', 8, 6);
  assertInvalid('tiebreak7', 8, 5);
  assertInvalid('tiebreak7', 2, 1);

  assertValid('tiebreak11', 11, 9);
  assertValid('tiebreak11', 12, 10);
  assertInvalid('tiebreak11', 11, 10);

  assertValid('short4', 4, 0);
  assertValid('short4', 4, 3);
  assertValid('short4', 5, 0);
  assertValid('short4', 5, 4);
  assertInvalid('short4', 6, 4);
}

function testScoreMultipliers() {
  assert.equal(scoreMultiplier('standard_set', 7, 6), 0.85);
  assert.equal(scoreMultiplier('standard_set', 6, 0), 1.25);
  assert.equal(scoreMultiplier('tiebreak7', 7, 5), 0.90);
  assert.equal(scoreMultiplier('tiebreak7', 7, 4), 1.00);
  assert.equal(scoreMultiplier('tiebreak11', 11, 5), 1.10);
  assert.equal(scoreMultiplier('short4', 4, 3), 0.90);
  assert.equal(scoreMultiplier('short4', 4, 0), 1.20);
}

function testEngineZeroSum() {
  const ratings = { 1: 1500, 2: 1510, 3: 1490, 4: 1520 };
  const deltas = computeMatchDeltas(ratings, {
    mode: 'doubles',
    type: 'standard_set',
    a: [1, 2],
    b: [3, 4],
    sa: 6,
    sb: 4,
  });
  const sum = [...deltas.values()].reduce((acc, row) => acc + row.delta, 0);
  assert.ok(Math.abs(sum) < 1e-9, `deltas should be zero-sum, got ${sum}`);
}

function testRewriteVersionConflictAndRecalc() {
  const initial = exportState();
  const state1 = rewriteState({
    version: initial.version,
    players: [
      { id: -1, name: '甲' },
      { id: -2, name: '乙' },
    ],
    matches: [
      { mode: 'singles', type: 'standard_set', a: [-1], b: [-2], sa: 6, sb: 4, date: '2026-06-15' },
    ],
  });

  assert.equal(state1.players.length, 2);
  assert.equal(state1.matches.length, 1);
  assert.ok(state1.version);
  assert.notEqual(state1.version, initial.version);

  assert.throws(() => rewriteState({
    version: initial.version,
    players: state1.players,
    matches: state1.matches,
  }), /数据已被其他人更新/);

  const afterDelete = rewriteState({
    version: state1.version,
    players: state1.players,
    matches: [],
  });
  assert.equal(afterDelete.matches.length, 0);
  assert.notEqual(afterDelete.version, state1.version);
}

async function httpRequest(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { res, body, text };
}

async function testHttpLoginAndVersion() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tennis-smoke-'));
  const dbFile = path.join(tmp, 'tennis.db');
  const port = 34000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: {
      ...process.env,
      PORT: String(port),
      TENNIS_DB_FILE: dbFile,
      TENNIS_ADMIN_PASSWORD: 'secret-strong-test',
      TENNIS_COOKIE_SECURE: '0',
      TENNIS_TRUST_PROXY: '1',
      TENNIS_NO_LISTEN: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    const started = Date.now();
    while (Date.now() - started < 5000) {
      try {
        const r = await fetch(`${base}/api/state`);
        if (r.ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const bad = await httpRequest(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
      body: JSON.stringify({ password: 'bad' }),
    });
    assert.equal(bad.res.status, 401);

    const good = await httpRequest(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
      body: JSON.stringify({ password: 'secret-strong-test' }),
    });
    assert.equal(good.res.status, 200);
    const cookie = good.res.headers.get('set-cookie');
    assert.match(cookie || '', /tennis_auth=/);

    const state = await httpRequest(`${base}/api/state`);
    assert.equal(state.res.status, 200);
    assert.ok(state.body.version);

    const conflict = await httpRequest(`${base}/api/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ players: [], matches: [], version: 'stale' }),
    });
    assert.equal(conflict.res.status, 409);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  testScoreValidation();
  testScoreMultipliers();
  testEngineZeroSum();
  testRewriteVersionConflictAndRecalc();
  await testHttpLoginAndVersion();
  fs.rmSync(unitTmp, { recursive: true, force: true });
  console.log('[smoke] all checks passed');
}

main().catch((err) => {
  fs.rmSync(unitTmp, { recursive: true, force: true });
  console.error(err);
  process.exit(1);
});
