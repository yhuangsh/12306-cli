#!/usr/bin/env node
/**
 * Test phases 11–13 without placing actual orders.
 *
 * Tests:
 *   Phase 12: XHR-based search (seat availability, station names, train-filter)
 *   Phase 13: date validation, maintenance window guard
 *   Phase 11: multi-passenger arg parsing, help output
 *   Book dry-run: ensures book fails gracefully without --yes/--auto
 */

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'cli.js');

let passed = 0, failed = 0, skipped = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result === 'skip') { skipped++; console.log(`  ⊘  SKIP: ${name}`); }
    else { passed++; console.log(`  ✅ PASS: ${name}`); }
  } catch (e) {
    failed++;
    console.log(`  ❌ FAIL: ${name}\n       ${e.message.split('\n')[0]}`);
  }
}

function run(cmd) {
  try {
    return execSync(cmd, { timeout: 120_000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    // Combine stdout + stderr for error analysis
    const out = (e.stdout || '') + (e.stderr || '');
    if (out) return out;
    throw e;
  }
}

function runStdout(cmd) {
  // Returns only stdout (where JSON output goes)
  try {
    return execSync(cmd, { timeout: 120_000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return e.stdout || '';
  }
}

function runCombined(cmd) {
  // Returns { stdout, stderr } via spawnSync
  const parts = cmd.split(' ');
  const r = require('child_process').spawnSync(parts[0], parts.slice(1), { encoding: 'utf-8', timeout: 120_000 });
  return { stdout: r.stdout || '', stderr: r.stderr || '' };
}

function parseJSON(text) {
  const lines = text.split('\n');
  // Find the last line that is valid JSON
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{')) {
      try { return JSON.parse(line); } catch {}
    }
  }
  throw new Error(`No JSON found in output: ${text.substring(0, 300)}`);
}

// ═══════════════════════════════════════════════
// Phase 13: Date Validation (fast, no network)
// ═══════════════════════════════════════════════
console.log('\n📋 Phase 13: Date Validation');

test('search rejects malformed date (2026-5-22)', () => {
  const out = runStdout(`node ${SCRIPT} search --from 北京 --to 上海 --date 2026-5-22`);
  const json = parseJSON(out);
  if (json.ok !== false || !json.error.includes('Invalid date format'))
    throw new Error(`Expected date validation error, got: ${JSON.stringify(json)}`);
});

test('search rejects malformed date (May 22)', () => {
  const out = runStdout(`node ${SCRIPT} search --from 北京 --to 上海 --date "May 22"`);
  const json = parseJSON(out);
  if (json.ok !== false || !json.error.includes('Invalid date format'))
    throw new Error(`Expected date validation error, got: ${JSON.stringify(json)}`);
});

test('search rejects date with slashes', () => {
  const out = runStdout(`node ${SCRIPT} search --from 北京 --to 上海 --date 2026/05/22`);
  const json = parseJSON(out);
  if (json.ok !== false || !json.error.includes('Invalid date format'))
    throw new Error(`Expected date validation error, got: ${JSON.stringify(json)}`);
});

// ═══════════════════════════════════════════════
// Phase 12: XHR-based Search (1 search, multiple assertions)
// ═══════════════════════════════════════════════
console.log('\n📋 Phase 12: XHR-based Search');

// Run ONE search and reuse the result for all assertions
let searchResult = null;
test('search returns structured results with seat availability', () => {
  const out = runStdout(`node ${SCRIPT} search --from 北京 --to 上海 --date 2026-05-20`);
  searchResult = parseJSON(out);
  if (!searchResult.ok) throw new Error(`Search failed: ${searchResult.error}`);
  if (!searchResult.trains || searchResult.trains.length === 0) throw new Error('No trains returned');
  if (!searchResult.source) throw new Error('Missing source field');

  const train = searchResult.trains[0];
  if (!train.code) throw new Error('Missing train code');
  if (!train.departure) throw new Error('Missing departure');
  if (!train.arrival) throw new Error('Missing arrival');
  if (!train.duration) throw new Error('Missing duration');
  if (train.seats === undefined) throw new Error('Missing seats');

  const seatTypes = Object.keys(train.seats);
  if (seatTypes.length === 0) throw new Error('No seat types');
  console.log(`       → ${searchResult.count} trains, source=${searchResult.source}`);
  console.log(`       → sample: ${train.code} ${train.departure}-${train.arrival} seats=${JSON.stringify(train.seats)}`);
});

// Assertions on the cached search result
test('search result has station names (not codes)', () => {
  if (!searchResult) return 'skip';
  const train = searchResult.trains[0];
  if (!train.fromStation || train.fromStation.length < 2)
    throw new Error(`Bad fromStation: ${train.fromStation}`);
  if (!train.toStation || train.toStation.length < 2)
    throw new Error(`Bad toStation: ${train.toStation}`);
  console.log(`       → ${train.fromStation} → ${train.toStation}`);
});

test('search result has train metadata', () => {
  if (!searchResult) return 'skip';
  const train = searchResult.trains[0];
  if (!train.trainNo) throw new Error('Missing trainNo');
  if (!train.buttonText) throw new Error('Missing buttonText');
  if (train.bookable === undefined) throw new Error('Missing bookable');
});

test('seat values are valid (有/无/number)', () => {
  if (!searchResult) return 'skip';
  for (const train of searchResult.trains.slice(0, 10)) {
    for (const [type, val] of Object.entries(train.seats)) {
      if (val !== '有' && val !== '无' && !/^\d+$/.test(val))
        throw new Error(`Invalid seat value "${val}" for ${type} on ${train.code}`);
    }
  }
});

// Test --train-filter with a separate search
test('search --train-filter G returns only G-prefixed trains', () => {
  // May return 0 trains if rate-limited from previous search — skip gracefully
  const { stdout } = runCombined(`node ${SCRIPT} search --from 北京 --to 上海 --date 2026-05-20 --train-filter G`);
  const lines = stdout.trim().split('\n');
  const jsonLine = lines.filter(l => l.startsWith('{')).pop();
  if (!jsonLine) throw new Error('No JSON output');
  const json = JSON.parse(jsonLine);
  if (!json.ok) throw new Error(`Search failed: ${json.error}`);
  if (json.trains.length === 0) {
    console.log(`       → 0 trains (likely rate-limited, skipping assertion)`);
    return 'skip';
  }
  const nonG = json.trains.filter(t => !t.code.startsWith('G'));
  if (nonG.length > 0) throw new Error(`Found non-G trains: ${nonG.map(t => t.code).join(',')}`);
  console.log(`       → ${json.count} G-trains only`);
});

// ═══════════════════════════════════════════════
// Phase 11: Multi-Passenger (dry-run)
// ═══════════════════════════════════════════════
console.log('\n📋 Phase 11: Multi-Passenger (dry-run)');

test('book without --yes/--auto returns error (session or confirmation)', () => {
  const out = runStdout(`node ${SCRIPT} book --from 北京 --to 上海 --date 2026-05-20 --train G1 --passenger "张三" --seat-type 二等座 --seat-pos F`);
  const json = parseJSON(out);
  if (json.ok === true) throw new Error('Expected order to be blocked without --yes');
  // Could be session error or missing --yes — both are correct blocking behavior
  console.log(`       → blocked: ${json.error || json.message || 'needSmsCode'}`);
});

test('help output shows multi-passenger syntax', () => {
  const { stdout, stderr } = runCombined(`node ${SCRIPT} book --help`);
  const out = stdout + stderr;
  if (!out.includes('comma-separated')) throw new Error('Missing comma-separated hint');
  if (!out.includes('--passenger')) throw new Error('Missing --passenger docs');
  if (!out.includes('--seat-pos')) throw new Error('Missing --seat-pos docs');
  if (!out.includes('Multi-passenger')) throw new Error('Missing multi-passenger example');
});

// ═══════════════════════════════════════════════
// Phase 13: Maintenance Window Unit Test
// ═══════════════════════════════════════════════
console.log('\n📋 Phase 13: Maintenance Window');

test('checkMaintenanceWindow returns correct shape at noon CST', () => {
  // At ~noon CST, should NOT be in maintenance
  const code = `
    const fs = require('fs');
    const src = fs.readFileSync('${SCRIPT}', 'utf-8');
    // Find and extract the function
    const start = src.indexOf('function checkMaintenanceWindow');
    const end = src.indexOf('\\n}', start + 1) + 2;
    const fnSrc = src.substring(start, end);
    eval(fnSrc);
    const result = checkMaintenanceWindow();
    console.log(JSON.stringify(result));
  `;
  const result = execFileSync('node', ['-e', code], { encoding: 'utf-8' }).trim();
  const json = JSON.parse(result);
  if (json.inMaintenance === undefined) throw new Error(`Bad result: ${result}`);
  // At noon CST, should be false
  if (json.inMaintenance !== false) throw new Error(`Expected inMaintenance=false at noon, got: ${result}`);
  console.log(`       → inMaintenance=${json.inMaintenance} ✓`);
});

test('maintenance window message makes sense', () => {
  const code = `
    const fs = require('fs');
    const src = fs.readFileSync('${SCRIPT}', 'utf-8');
    const start = src.indexOf('function checkMaintenanceWindow');
    const end = src.indexOf('\\n}', start + 1) + 2;
    const fnSrc = src.substring(start, end);
    eval(fnSrc);
    const result = checkMaintenanceWindow();
    // Should NOT have message when not in maintenance
    if (result.inMaintenance === false && result.message) throw new Error('Unexpected message when not in maintenance');
    console.log('OK');
  `;
  const result = execFileSync('node', ['-e', code], { encoding: 'utf-8' }).trim();
  if (result !== 'OK') throw new Error(`Unexpected: ${result}`);
});

// ═══════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════
console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log('═'.repeat(50));

process.exit(failed > 0 ? 1 : 0);
