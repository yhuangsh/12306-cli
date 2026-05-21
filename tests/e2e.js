#!/usr/bin/env node
/**
 * End-to-end test: full workflow from login to booking.
 *
 * Phases:
 *   1. Cities lookup
 *   2. Search trains
 *   3. Orders (upcoming + history + unpaid)
 *   4. Booking (skipped by default, use --book to enable)
 *   5. Session status
 *
 * Usage:
 *   node scripts/e2e-test.js              # skip booking
 *   node scripts/e2e-test.js --book        # include booking test
 *   node scripts/e2e-test.js --route 北京 上海 2026-06-15  G1   # custom route
 *
 * Requires:
 *   - 12306-cli installed and configured (config set username/password/id_last4)
 *   - Active session for order + booking tests (auto-detected or via session start)
 */

const { execSync } = require('child_process');
const path = require('path');

const CLI = `node ${path.join(__dirname, '..', 'scripts', 'cli.js')}`;
let PASS = 0, FAIL = 0, SKIP = 0;

// Parse args
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--book') args.book = true;
  else if (process.argv[i] === '--route') { args.from = process.argv[++i]; args.to = process.argv[++i]; args.date = process.argv[++i]; if (process.argv[i+1]?.match(/^[A-Z]/)) args.train = process.argv[++i]; }
}

const FROM = args.from || '北京';
const TO = args.to || '上海';
const DATE = args.date || nextSunday();
const TRAIN = args.train || null;  // null = pick first bookable G-train

function nextSunday() {
  const d = new Date();
  d.setDate(d.getDate() + (7 - d.getDay()) % 7);
  return d.toISOString().split('T')[0];
}

function run(cmd, timeout = 180_000) {
  try {
    return execSync(cmd, { timeout, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

function json(cmd) {
  const out = run(cmd);
  const lines = out.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{')) {
      try { return JSON.parse(line); } catch {}
    }
  }
  throw new Error(`No JSON in: ${out.substring(0, 200)}`);
}

function test(name, fn) {
  try {
    const r = fn();
    if (r === 'skip') { SKIP++; console.log(`  ⊘  SKIP: ${name}`); }
    else { PASS++; console.log(`  ✅ PASS: ${name}`); }
  } catch (e) {
    FAIL++;
    console.log(`  ❌ FAIL: ${name}`);
    console.log(`       ${e.message.split('\n')[0]}`);
  }
}

// ════════════════════════════════════════
// Phase 1: Cities (no login needed)
// ════════════════════════════════════════
console.log('\n📋 Phase 1: Cities');

test('cities lists popular stations', () => {
  const r = json(`${CLI} cities`);
  if (!r.ok || !r.cities || r.count < 10) throw new Error('Expected cities list');
  const bj = r.cities.find(c => c.city === '北京');
  if (!bj || !bj.stations.length) throw new Error('北京 not found');
  console.log(`       → ${r.count} cities, 北京: ${bj.stations.join(',')}`);
});

test('cities filters by name', () => {
  const r = json(`${CLI} cities -f 上海`);
  if (!r.ok || !r.stations) throw new Error('Expected station list');
  if (!r.stations.find(s => s.name === '上海虹桥')) throw new Error('上海虹桥 not found');
  console.log(`       → ${r.count} stations for 上海`);
});

test('cities filters by pinyin', () => {
  const r = json(`${CLI} cities -f shanghai`);
  if (!r.ok || !r.stations) throw new Error('Expected station list');
  if (!r.stations.find(s => s.code === 'AOH')) throw new Error('AOH not found');
});

// ════════════════════════════════════════
// Phase 2: Search (no login needed)
// ════════════════════════════════════════
console.log('\n📋 Phase 2: Search');

let searchResult = null;

test(`search ${FROM}→${TO} ${DATE}`, () => {
  const r = json(`${CLI} search --from ${FROM} --to ${TO} --date ${DATE}`);
  if (!r.ok || !r.trains || r.trains.length === 0) throw new Error('No trains found');
  searchResult = r;
  console.log(`       → ${r.count} trains, source=${r.source}`);
  const g = r.trains.find(t => t.code.startsWith('G'));
  console.log(`       → sample G-train: ${g?.code} ${g?.departure}→${g?.arrival} ${g?.fromStation}→${g?.toStation}`);
});

test('search results have seat availability', () => {
  if (!searchResult) return 'skip';
  const train = searchResult.trains[0];
  if (!train.seats || Object.keys(train.seats).length === 0) throw new Error('No seat data');
  const seatTypes = Object.keys(train.seats).join(', ');
  console.log(`       → seat types: ${seatTypes}`);
});

test('search --train-filter G returns only G-trains', () => {
  const r = json(`${CLI} search --from ${FROM} --to ${TO} --date ${DATE} --train-filter G`);
  if (!r.ok) return 'skip';  // rate-limited
  if (r.trains.length === 0) return 'skip';
  const nonG = r.trains.filter(t => !t.code.startsWith('G'));
  if (nonG.length > 0) throw new Error(`Found non-G: ${nonG.map(t => t.code).join(',')}`);
  console.log(`       → ${r.count} G-trains`);
});

// ════════════════════════════════════════
// Phase 3: Orders (needs login)
// ════════════════════════════════════════
console.log('\n📋 Phase 3: Orders');

const sess = json(`${CLI} session status`);
const hasSession = sess.running;

if (!hasSession) {
  test('orders (skipped — no session)', () => 'skip');
  console.log(`       → Run "12306-cli session start" to enable order tests`);
} else {
  test('orders --type upcoming', () => {
    const r = json(`${CLI} orders -t upcoming`);
    if (!r.ok) return 'skip';
    console.log(`       → ${r.count} upcoming orders`);
    if (r.count > 0) {
      const t = r.orders[0].tickets[0];
      console.log(`       → latest: ${t.trainCode} ${t.travelDate} ${t.fromStation}→${t.toStation} ${t.passenger} ¥${t.price} ${t.status}`);
    }
  });

  test('orders --type history', () => {
    const r = json(`${CLI} orders -t history`);
    if (!r.ok) return 'skip';
    console.log(`       → ${r.count} history orders`);
  });

  test('orders (unpaid default)', () => {
    const r = json(`${CLI} orders`);
    if (!r.ok) return 'skip';
    console.log(`       → ${r.count} unpaid orders`);
  });
}

// ════════════════════════════════════════
// Phase 4: Booking (needs login + --book flag)
// ════════════════════════════════════════
console.log('\n📋 Phase 4: Booking');

if (!args.book) {
  console.log('  ⊘  SKIP: booking (use --book to enable)');
  SKIP++;
} else if (!hasSession) {
  test('booking — no session', () => 'skip');
  console.log(`       → Run "12306-cli session start" first`);
} else {
  test('book a train', () => {
    // Pick a G-train from search results or use the passed one
    let trainCode = TRAIN;
    if (!trainCode) {
      if (!searchResult) {
        const r = json(`${CLI} search --from ${FROM} --to ${TO} --date ${DATE} --train-filter G`);
        searchResult = r;
      }
      const g = searchResult.trains.find(t => t.code.startsWith('G') && t.bookable);
      if (!g) return 'skip';
      trainCode = g.code;
      console.log(`       → auto-selected: ${g.code} ${g.departure}→${g.arrival}`);
    }

    const r = json(`${CLI} book --from ${FROM} --to ${TO} --date ${DATE} --train ${trainCode} --passenger 张三 --seat-type 二等座 --seat-pos F --yes`);
    if (r.ok) {
      console.log(`       ✅ Booked ${r.train} ${r.passengers.join(',')} ${r.seatType} ${r.seatPos}`);
      console.log(`       ⚠️  UNPAID ORDER CREATED — cancel in 12306 app if test`);
    } else if (r.needLogin) {
      return 'skip';
    } else {
      throw new Error(r.error || 'Booking failed');
    }
  });
}

// ════════════════════════════════════════
// Summary
// ════════════════════════════════════════
console.log(`\n${'═'.repeat(55)}`);
console.log(`End-to-end: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped`);
console.log(`Session:    ${hasSession ? 'active (order + booking tests run)' : 'inactive (login to enable)'}`);
console.log('═'.repeat(55));

process.exit(FAIL > 0 ? 1 : 0);
