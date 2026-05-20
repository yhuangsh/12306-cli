#!/usr/bin/env node
/**
 * 12306 CLI — China Railway ticket tool
 *
 * Output: JSON to stdout, progress/diagnostics to stderr
 */

const { Command } = require('commander');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Use Playwright's bundled Chromium (auto-installed by postinstall).
// Override with CHROME_PATH env var if you need a custom browser.
const CHROME_PATH = process.env.CHROME_PATH || null;

// ── Config ──
//
// Profiles: ~/.config/12306-cli/profiles/<name>.conf
// Default:  ~/.config/12306-cli/default → symlink to profiles/<name>.conf
// Sessions: ~/.config/12306-cli/sessions/<name>.cookies.json
//
// Lookup: --profile <name> > TRAIN_PROFILE env var > "default" symlink
// Override: --conf <path> (bypasses profile system entirely)

const CONFIG_DIR = path.join(process.env.HOME || '/tmp', '.config', '12306-cli');

function getConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  return CONFIG_DIR;
}

function parseConfFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf-8');
  const vars = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

function resolveProfile(args) {
  // --profile > TRAIN_PROFILE env > "default" symlink
  const name = args.profile || process.env.TRAIN_PROFILE || 'default';
  const configDir = getConfigDir();
  const profilesDir = path.join(configDir, 'profiles');
  if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });

  let confPath;
  if (name === 'default') {
    const defaultLink = path.join(configDir, 'default');
    if (fs.existsSync(defaultLink)) {
      confPath = fs.realpathSync(defaultLink);
    } else {
      confPath = path.join(profilesDir, 'default.conf');
      if (!fs.existsSync(confPath)) {
        return { name: 'default', conf: null, cookies: path.join(configDir, 'sessions', 'default.cookies.json') };
      }
    }
  } else {
    confPath = path.join(profilesDir, `${name}.conf`);
    if (!fs.existsSync(confPath)) return { name, conf: null, cookies: path.join(configDir, 'sessions', `${name}.cookies.json`) };
  }

  return { name, conf: confPath, cookies: path.join(configDir, 'sessions', `${name}.cookies.json`) };
}

function loadConfig(args) {
  // --conf bypasses profile system
  if (args.conf) {
    const profile = { name: 'custom', conf: args.conf, cookies: path.join(getConfigDir(), 'sessions', 'custom.cookies.json') };
    return { profile, vars: parseConfFile(args.conf) };
  }

  const profile = resolveProfile(args);
  const fileVars = profile.conf ? parseConfFile(profile.conf) : {};

  // Env vars override file vars (env vars = lowest priority in file, but override file)
  const vars = {
    ...fileVars,
    TRAIN_USERNAME: process.env.TRAIN_USERNAME || fileVars.TRAIN_USERNAME,
    TRAIN_PASSWORD: process.env.TRAIN_PASSWORD || fileVars.TRAIN_PASSWORD,
    TRAIN_ID_LAST4: process.env.TRAIN_ID_LAST4 || fileVars.TRAIN_ID_LAST4,
    // Non-sensitive defaults from config
    TRAIN_FROM: process.env.TRAIN_FROM || fileVars.TRAIN_FROM || '',
    TRAIN_TO: process.env.TRAIN_TO || fileVars.TRAIN_TO || '',
    TRAIN_PASSENGER: process.env.TRAIN_PASSENGER || fileVars.TRAIN_PASSENGER || '',
    TRAIN_SEAT_TYPE: process.env.TRAIN_SEAT_TYPE || fileVars.TRAIN_SEAT_TYPE || '',
    TRAIN_SEAT_POS: process.env.TRAIN_SEAT_POS || fileVars.TRAIN_SEAT_POS || '',
  };

  return { profile, vars };
}

const IS_TTY = process.stdin.isTTY === true;

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].substring(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      args[key] = argv[i + 1] || '';
      i++;
    }
  }
  return args;
}

function ask(question, defaultVal) {
  if (!IS_TTY) return Promise.resolve(defaultVal || '');
  const hint = defaultVal ? ` (${defaultVal})` : '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(`${question}${hint}: `, answer => {
    rl.close();
    resolve((answer.trim() || defaultVal || '').trim());
  }));
}

function askChoice(question, options) {
  if (!IS_TTY) {
    console.error(`Interactive prompt blocked (no TTY): ${question}`);
    return Promise.resolve(0);
  }
  console.log('\n' + question);
  options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question('Choose: ', answer => {
    rl.close();
    const idx = parseInt(answer.trim()) - 1;
    resolve(idx >= 0 && idx < options.length ? idx : 0);
  }));
}

function output(obj) {
  console.log(JSON.stringify(obj));
  return obj;
}

// ── Maintenance Window ──

function checkMaintenanceWindow() {
  // 12306 is unavailable for booking ~1:00 AM – 6:00 AM daily
  const now = new Date();
  // Use China Standard Time (UTC+8)
  const cst = new Date(now.getTime() + (8 - now.getTimezoneOffset() / -60) * 3600000);
  const hour = cst.getHours();
  if (hour >= 1 && hour < 6) {
    return { inMaintenance: true, message: `12306 maintenance window (1:00–6:00 AM CST). Current CST time: ${cst.getHours()}:${String(cst.getMinutes()).padStart(2, '0')}. Booking unavailable.` };
  }
  return { inMaintenance: false };
}

// ── Browser Pool ──
// Persistent Chromium launched via CDP. The browser stays alive between
// CLI commands — commands reconnect via chromium.connectOverCDP().
// State file: ~/.config/12306-cli/browser.json

const { execFile } = require('child_process');
const BROWSER_FILE = path.join(CONFIG_DIR, 'browser.json');

const BROWSER_ARGS = [
  '--headless=new',
  '--disable-blink-features=AutomationControlled',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
];

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

class BrowserPool {
  _readInfo() {
    try { return fs.existsSync(BROWSER_FILE) ? JSON.parse(fs.readFileSync(BROWSER_FILE, 'utf-8')) : null; }
    catch { return null; }
  }

  _saveInfo(info) {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(BROWSER_FILE, JSON.stringify(info, null, 2), { mode: 0o600 });
  }

  _deleteInfo() {
    try { if (fs.existsSync(BROWSER_FILE)) fs.unlinkSync(BROWSER_FILE); } catch {}
  }

  /** Connect to running browser. Throws if no session. */
  async connect() {
    const info = this._readInfo();
    if (!info?.wsEndpoint) throw new Error('No active session. Run: 12306-cli session start');
    let browser;
    try { browser = await chromium.connectOverCDP(info.wsEndpoint); }
    catch { this._deleteInfo(); throw new Error('Session died. Run: 12306-cli session start'); }
    const contexts = browser.contexts();
    if (contexts.length === 0) { browser.close(); this._deleteInfo(); throw new Error('Session lost. Run: 12306-cli session start'); }
    const context = contexts[0];
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();
    return { browser, context, page };
  }

  /** Disconnect CDP without killing browser. */
  disconnect(browser) { try { browser.close(); } catch {} }

  /** Launch a new Chromium process, save wsEndpoint. */
  async launch(headless = true) {
    const existing = this._readInfo();
    if (existing?.wsEndpoint) {
      try { const b = await chromium.connectOverCDP(existing.wsEndpoint); b.close(); }
      catch { this._deleteInfo(); }
      if (existing.wsEndpoint) throw new Error('Session already active. Run `12306-cli session stop` first to restart.');
    }

    const browserPath = CHROME_PATH || chromium.executablePath();
    const args = headless ? [...BROWSER_ARGS] : BROWSER_ARGS.filter(a => a !== '--headless=new');
    const proc = execFile(browserPath, [...args, '--remote-debugging-port=0'], { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.unref(); proc.stdout?.unref(); proc.stderr?.unref();

    const wsEndpoint = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { proc.kill(); reject(new Error('Browser launch timed out (15s)')); }, 15000);
      proc.stderr.on('data', (data) => {
        const m = data.toString().match(/DevTools listening on (ws:\/\/.+)/);
        if (m) { clearTimeout(timeout); resolve(m[1]); }
      });
      proc.on('error', (err) => { clearTimeout(timeout); reject(new Error(`Browser launch failed: ${err.message}`)); });
      proc.on('exit', (code) => { clearTimeout(timeout); if (code) reject(new Error(`Browser exited with code ${code}`)); });
    });

    // Connect briefly to create context and apply init script
    const browser = await chromium.connectOverCDP(wsEndpoint);
    let context = browser.contexts()[0];
    if (!context) context = await browser.newContext({
      userAgent: USER_AGENT, viewport: { width: 1440, height: 900 },
    });
    if (context.pages().length === 0) await context.newPage();

    this._saveInfo({ wsEndpoint, pid: proc.pid, startedAt: new Date().toISOString() });
    browser.close(); // disconnect, browser stays alive
    return { wsEndpoint };
  }

  /** Kill browser process. */
  async kill() {
    const info = this._readInfo();
    if (info?.pid) { try { process.kill(info.pid, 'SIGKILL'); } catch {} }
    // Also clean up any old state files
    const sessionsDir = path.join(CONFIG_DIR, 'sessions');
    if (fs.existsSync(sessionsDir)) {
      for (const f of fs.readdirSync(sessionsDir)) {
        if (f.endsWith('.state.json') || f.endsWith('.cookies.json')) fs.unlinkSync(path.join(sessionsDir, f));
      }
    }
    this._deleteInfo();
  }

  /** Check if browser is running. */
  async status() {
    const info = this._readInfo();
    if (!info?.wsEndpoint) return { running: false };
    try { const b = await chromium.connectOverCDP(info.wsEndpoint); b.close(); return { running: true, info }; }
    catch { return { running: false }; }
  }
}

const pool = new BrowserPool();

/**
 * Get a browser + page. Uses CDP session if available, falls back to standalone.
 */
async function getBrowser(headless = true) {
  // Try CDP session first (fast, shared browser state)
  try {
    const { browser, context, page } = await pool.connect();
    return { browser, context, page, isSession: true };
  } catch {
    // No session — launch standalone (e.g. for search)
    const launchOpts = { headless, args: ['--disable-blink-features=AutomationControlled'] };
    if (CHROME_PATH) launchOpts.executablePath = CHROME_PATH;
    const browser = await chromium.launch(launchOpts);
    const context = await browser.newContext({
      userAgent: USER_AGENT, viewport: { width: 1440, height: 900 }
    });
    await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
    const page = await context.newPage();
    return { browser, context, page, isSession: false };
  }
}

// ── Seat click via dispatchEvent ──

async function clickSeat(page, seatId) {
  return page.evaluate((id) => {
    const el = document.querySelector('[id="' + id + '"]');
    if (!el) return { ok: false, error: 'not found' };
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y, button: 0 }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y, button: 0 }));
    return { ok: true, selected: el.classList.contains('cur') };
  }, seatId);
}

// ── Search ──
// Uses XHR interception to get clean structured data from 12306's API response.

async function cmdSearch(args, config) {
  const from = args.from || config.vars.TRAIN_FROM || await ask('🚄 出发城市');
  const to = args.to || config.vars.TRAIN_TO || await ask('🚄 到达城市');
  const date = args.date || await ask('📅 日期 (YYYY-MM-DD)');
  if (!from || !to || !date) return output({ ok: false, error: 'Missing: from, to, date' });

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return output({ ok: false, error: `Invalid date format: ${date}. Use YYYY-MM-DD.` });
  }

  const { browser, context, page, isSession } = await getBrowser(args.headless !== 'false');
  try {
    const page = await context.newPage();

    // Set up XHR interception to capture the API response
    let searchResponse = null;
    page.on('response', async resp => {
      if (resp.url().includes('/otn/leftTicket/query')) {
        try {
          const json = await resp.json();
          if (json?.data?.result) searchResponse = json;
        } catch (e) { /* ignore non-JSON or failed responses */ }
      }
    });

    // Navigate to search page with query params
    await page.goto(
      `https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=${encodeURIComponent(from)}&ts=${encodeURIComponent(to)}&date=${date}&flag=N,N,Y`,
      { waitUntil: 'networkidle' }
    );
    await page.waitForTimeout(3000);

    // Fill in form fields and trigger search
    await page.evaluate(({ fromCity, toCity, d }) => {
      $('#fromStationText').val(fromCity); $('#toStationText').val(toCity); $('#train_date').val(d);
      const gc = n => { const m = station_names.match(new RegExp('@[^|]*\\|' + n + '\\|([A-Z]+)')); return m ? m[1] : ''; };
      $('#fromStation').val(gc(fromCity)); $('#toStation').val(gc(toCity));
    }, { fromCity: from, toCity: to, d: date });

    await page.click('#query_ticket');
    await page.waitForTimeout(8000);

    // If XHR interception didn't capture the response, try DOM fallback
    if (!searchResponse || !searchResponse.data?.result) {
      console.error('⚠️  XHR interception failed, falling back to DOM parsing...');
      const trains = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('tr[id^="ticket_"]')).map(row => {
          const code = row.querySelector('.number, .train a')?.textContent?.trim() || '';
          const btn = row.querySelector('a.btn72');
          const tds = row.querySelectorAll('td');
          const raw = Array.from(tds).map(td => td.textContent?.trim()?.replace(/\s+/g, ' ') || '');
          const header = raw[0] || '';
          const timeMatch = header.match(/(\d{2}:\d{2})(\d{2}:\d{2})(\d{2}:\d{2})/);
          const stationMatch = header.match(/(?:查看票价|票价)(.+?)(\d{2}:\d{2})/);
          return {
            code,
            departure: timeMatch ? timeMatch[1] : '',
            arrival: timeMatch ? timeMatch[2] : '',
            duration: timeMatch ? timeMatch[3] : '',
            fromStation: stationMatch ? stationMatch[1].trim() : '',
            toStation: '',
            bookable: btn?.textContent.trim() === '预订',
            seats: {}
          };
        }).filter(t => t.code);
      });
      return output({ ok: true, date, from, to, trains, source: 'dom-fallback' });
    }

    // Parse structured API response
    const stationMap = searchResponse.data.map || {};
    const seatKeys = {
      26: '无座',
      28: '硬卧',
      29: '硬座',
      30: '二等座',
      31: '一等座',
      32: '商务座/特等座',
      33: '动卧',
    };

    const trains = searchResponse.data.result.map(entry => {
      const f = entry.split('|');
      const seats = {};
      for (const [idx, name] of Object.entries(seatKeys)) {
        const val = f[idx] || '';
        if (val) seats[name] = val;
      }
      return {
        code: f[3],
        fromStation: stationMap[f[6]] || f[6],
        toStation: stationMap[f[7]] || f[7],
        departure: f[8],
        arrival: f[9],
        duration: f[10],
        bookable: f[11] === 'Y',
        buttonText: f[1],
        trainNo: f[2],
        seats
      };
    }).filter(t => t.code);

    // Apply train filter if specified (e.g., --train-filter G to show only high-speed)
    let filtered = trains;
    if (args.trainFilter) {
      const prefixes = args.trainFilter.split(',').map(p => p.trim().toUpperCase());
      filtered = trains.filter(t => prefixes.some(p => t.code.startsWith(p)));
    }

    return output({
      ok: true,
      date,
      from,
      to,
      count: filtered.length,
      trains: filtered,
      source: 'api'
    });
  } finally {
    if (isSession) pool.disconnect(browser); else await browser.close();
  }
}

// ── Book ──
// Supports multi-passenger: --passenger "张三,李四" --seat-pos "F,F"

async function cmdBook(args, config) {
  const from = args.from || config.vars.TRAIN_FROM || await ask('🚄 出发城市');
  const to = args.to || config.vars.TRAIN_TO || await ask('🚄 到达城市');
  const date = args.date || await ask('📅 日期 (YYYY-MM-DD)');
  if (!from || !to || !date) return output({ ok: false, error: 'Missing: from, to, date' });

  // Validate date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return output({ ok: false, error: `Invalid date format: ${date}. Use YYYY-MM-DD.` });
  }

  // Check maintenance window
  const mw = checkMaintenanceWindow();
  if (mw.inMaintenance) return output({ ok: false, error: mw.message });

  // Parse passenger list (comma-separated)
  const passengerInput = args.passenger || config.vars.TRAIN_PASSENGER || '';
  const passengerNames = passengerInput ? passengerInput.split(',').map(p => p.trim()).filter(Boolean) : [];

  // Parse seat positions (comma-separated, one per passenger)
  const seatPosInput = args.seatPos || config.vars.TRAIN_SEAT_POS || '';
  const seatPositions = seatPosInput ? seatPosInput.split(',').map(p => p.trim().toUpperCase()).filter(Boolean) : [];

  let browser, context, page;
  try {
    ({ browser, context, page } = await pool.connect());
  } catch (e) {
    return output({ ok: false, needLogin: true, message: e.message });
  }

  try {
    // Search
    const page = await context.newPage();
    await page.goto(
      `https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=${encodeURIComponent(from)}&ts=${encodeURIComponent(to)}&date=${date}&flag=N,N,Y`,
      { waitUntil: 'networkidle' }
    );
    await page.waitForTimeout(3000);

    await page.evaluate(({ fromCity, toCity, d }) => {
      $('#fromStationText').val(fromCity); $('#toStationText').val(toCity); $('#train_date').val(d);
      const gc = n => { const m = station_names.match(new RegExp('@[^|]*\\|' + n + '\\|([A-Z]+)')); return m ? m[1] : ''; };
      $('#fromStation').val(gc(fromCity)); $('#toStation').val(gc(toCity));
    }, { fromCity: from, toCity: to, d: date });

    await page.click('#query_ticket');
    await page.waitForTimeout(8000);

    const trains = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('tr[id^="ticket_"]')).map(row => {
        const code = row.querySelector('.number, .train a')?.textContent?.trim() || '';
        const btn = row.querySelector('a.btn72');
        return { code, onclick: btn?.getAttribute('onclick') || '', bookable: btn?.textContent.trim() === '预订' };
      }).filter(t => t.code && t.bookable);
    });

    if (trains.length === 0) return output({ ok: false, error: 'No bookable trains' });

    // Select train
    let selected;
    if (args.train) {
      selected = trains.find(t => t.code === args.train);
      if (!selected) {
        console.error(`⚠️  Train ${args.train} not found.`);
        const idx = await askChoice('Select train', trains.slice(0, 20).map(t => t.code));
        selected = trains[idx];
      }
    } else {
      console.error(`\n🚄 ${trains.length} trains:`);
      const idx = await askChoice('Select train', trains.slice(0, 20).map(t => t.code));
      selected = trains[idx];
    }

    // Submit order
    await page.evaluate((oc) => eval(oc), selected.onclick);
    await page.waitForTimeout(8000);

    if (!page.url().includes('confirmPassenger/initDc')) {
      return output({ ok: false, error: 'Failed to reach passenger page. Unpaid order may exist.' });
    }

    // ── Passenger Selection ──
    await page.waitForTimeout(2000);
    const passengers = await page.evaluate(() => {
      const items = document.querySelectorAll('#normal_passenger_id li, .passenger-ul li');
      return Array.from(items).map((li, idx) => {
        const name = li.querySelector('label, .name')?.textContent?.trim() || li.textContent.trim();
        return { idx, name: name.substring(0, 20) };
      }).filter(p => p.name.length > 0 && p.name.length < 15);
    });

    if (passengers.length === 0) {
      return output({ ok: false, error: 'No passengers found on the page.' });
    }

    // Determine which passengers to select
    let selectedPassengerIndices = [];
    if (passengerNames.length > 0) {
      for (const pName of passengerNames) {
        const idx = passengers.findIndex(p => p.name.includes(pName));
        if (idx === -1) {
          console.error(`⚠️  Passenger "${pName}" not found in list: ${passengers.map(p => p.name).join(', ')}`);
          return output({ ok: false, error: `Passenger "${pName}" not found. Available: ${passengers.map(p => p.name).join(', ')}` });
        }
        selectedPassengerIndices.push(idx);
      }
    } else if (passengers.length === 1) {
      selectedPassengerIndices = [0];
    } else {
      // Interactive selection - allow multi-select
      console.error('\n👥 Passengers:');
      const multiIdx = await askChoice(
        'Select passenger (for multi-passenger, use --passenger "name1,name2")',
        passengers.map(p => p.name)
      );
      selectedPassengerIndices = [multiIdx];
    }

    console.error(`👥 Selected ${selectedPassengerIndices.length} passenger(s): ${selectedPassengerIndices.map(i => passengers[i].name).join(', ')}`);

    // Click passenger checkboxes
    for (const idx of selectedPassengerIndices) {
      await page.evaluate((i) => {
        const items = document.querySelectorAll('#normal_passenger_id li, .passenger-ul li');
        if (items[i]) {
          const cb = items[i].querySelector('input[type=checkbox], input[type=radio]');
          if (cb && !cb.checked) cb.click();
        }
      }, idx);
      await page.waitForTimeout(1000);
    }

    // ── Seat Type Selection ──
    const seatTypeInput = args.seatType || config.vars.TRAIN_SEAT_TYPE || '';

    // For multi-passenger, each gets a seatType_N dropdown (1-indexed)
    const passengerCount = selectedPassengerIndices.length;

    if (passengerCount === 1) {
      // Single passenger: use seatType_1
      const seatOptions = await page.evaluate(() => {
        const sel = document.querySelector('#seatType_1') || document.querySelector('#seatType');
        if (!sel) return [];
        return Array.from(sel.options).filter(o => o.value).map(o => ({ value: o.value, text: o.textContent.trim() }));
      });

      let seatTypeIdx = 0;
      if (seatTypeInput && seatOptions.length > 0) {
        seatTypeIdx = seatOptions.findIndex(s => s.text.includes(seatTypeInput));
        if (seatTypeIdx === -1) {
          console.error(`⚠️  Seat type "${seatTypeInput}" not found.`);
          seatTypeIdx = await askChoice('Select seat type', seatOptions.map(s => s.text));
        }
      } else if (seatOptions.length > 1) {
        seatTypeIdx = await askChoice('Select seat type', seatOptions.map(s => s.text));
      }

      if (seatOptions.length > 0) {
        await page.evaluate(({ val }) => {
          const sel = document.querySelector('#seatType_1') || document.querySelector('#seatType');
          sel.value = val;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }, { val: seatOptions[seatTypeIdx].value });
      }
      await page.waitForTimeout(1500);
    } else {
      // Multi-passenger: set seatType for each passenger
      console.error(`💺 Setting seat type for ${passengerCount} passengers...`);
      for (let i = 1; i <= passengerCount; i++) {
        const seatOptions = await page.evaluate((idx) => {
          const sel = document.querySelector(`#seatType_${idx}`);
          if (!sel) return [];
          return Array.from(sel.options).filter(o => o.value).map(o => ({ value: o.value, text: o.textContent.trim() }));
        }, i);

        if (seatOptions.length === 0) continue;

        let seatTypeIdx = 0;
        if (seatTypeInput) {
          seatTypeIdx = seatOptions.findIndex(s => s.text.includes(seatTypeInput));
          if (seatTypeIdx === -1) seatTypeIdx = 0;
        }

        console.error(`  Passenger ${i}: ${seatOptions[seatTypeIdx].text}`);
        await page.evaluate(({ idx, val }) => {
          const sel = document.querySelector(`#seatType_${idx}`);
          if (sel) {
            sel.value = val;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, { idx: i, val: seatOptions[seatTypeIdx].value });
        await page.waitForTimeout(1000);
      }
    }

    // ── Submit Order → Seat Dialog ──
    const submitBtn = await page.evaluate(() => {
      const btn = document.querySelector('#submitOrder_id, a[id*=submitOrder]');
      return btn ? btn.id : null;
    });
    if (submitBtn) await page.click(`#${submitBtn}`);
    else await page.click('text=提交订单');
    await page.waitForTimeout(5000);

    // ── Seat Position Selection ──
    const seatDialog = await page.evaluate(() => {
      const dialog = document.querySelector('#id-seat-sel');
      if (!dialog || dialog.offsetWidth === 0) return { available: false };
      const seats = [];
      dialog.querySelectorAll('a[id]').forEach(a => {
        if (a.id.match(/^[0-9]+[A-F]$/) && a.offsetWidth > 0) {
          seats.push({ id: a.id, letter: a.id.replace(/^\d+/, '') });
        }
      });
      const letters = [...new Set(seats.map(s => s.letter))];
      return { available: true, letters, seatIds: seats.map(s => s.id) };
    });

    if (seatDialog.available && seatDialog.letters.length > 0) {
      const descriptions = { A: '靠窗(左)', B: '中间', C: '过道(左)', D: '过道(右)', F: '靠窗(右)' };

      if (passengerCount === 1) {
        // Single passenger — select one seat position
        let seatPos = seatPositions.length > 0 ? seatPositions[0] : null;
        if (seatPos && !seatDialog.letters.includes(seatPos)) {
          console.error(`⚠️  Position ${seatPos} not available.`);
          seatPos = null;
        }
        if (!seatPos) {
          const idx = await askChoice('Select seat position', seatDialog.letters.map(l => `${l} (${descriptions[l] || l})`));
          seatPos = seatDialog.letters[idx];
        }

        const targetId = `1${seatPos}`;
        const clickResult = await clickSeat(page, targetId);
        if (!clickResult.selected) return output({ ok: false, error: `Seat ${targetId} click failed` });
        await page.waitForTimeout(2000);
      } else {
        // Multi-passenger — select one position per passenger row
        console.error(`💺 Selecting seats for ${passengerCount} passengers...`);
        for (let i = 1; i <= passengerCount; i++) {
          let seatPos = seatPositions.length >= i ? seatPositions[i - 1] : null;
          if (seatPos && !seatDialog.letters.includes(seatPos)) {
            console.error(`⚠️  Position ${seatPos} not available for passenger ${i}.`);
            seatPos = null;
          }
          if (!seatPos) {
            const idx = await askChoice(
              `Select seat position for passenger ${i} (${passengers[selectedPassengerIndices[i - 1]].name})`,
              seatDialog.letters.map(l => `${l} (${descriptions[l] || l})`)
            );
            seatPos = seatDialog.letters[idx];
          }

          const targetId = `${i}${seatPos}`;
          const clickResult = await clickSeat(page, targetId);
          console.error(`  Passenger ${i}: seat ${targetId} → ${clickResult.selected ? '✅' : '❌'}`);
          if (!clickResult.selected) {
            return output({ ok: false, error: `Seat ${targetId} click failed for passenger ${i}` });
          }
          await page.waitForTimeout(1500);
        }
      }
    }

    // ── Confirmation ──
    // --yes or --auto required to place order
    if (args.yes !== 'true' && args.yes !== '1' && args.auto !== 'true' && args.auto !== '1') {
      return output({ ok: false, error: 'Missing --yes or --auto. Confirm with user before placing order.' });
    }

    // Place the order
    if (seatDialog.available) {
      await page.evaluate(() => document.querySelector('#qr_submit_id')?.click());
    }

    await page.waitForTimeout(10000);

    const pageText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
    const success = pageText.includes('订单') || pageText.includes('支付') || pageText.includes('成功');

    const selectedSeatPos = passengerCount === 1
      ? (seatPositions[0] || 'auto')
      : seatPositions.slice(0, passengerCount).join(',');

    return output({
      ok: success,
      train: selected.code,
      passengers: selectedPassengerIndices.map(i => passengers[i].name),
      seatType: args.seatType || config.vars.TRAIN_SEAT_TYPE || 'default',
      seatPos: selectedSeatPos || 'auto',
      date, from, to,
      message: success ? 'Order placed (not paid). Pay in 12306 app or website.' : 'Order may have failed.',
      pageSnippet: pageText.substring(0, 300)
    });
  } finally {
    pool.disconnect(browser);
  }
}

// ── Orders (check unpaid) ──

async function cmdOrders(args, config) {
  let browser, context, page;
  try {
    ({ browser, context, page } = await pool.connect());
  } catch (e) {
    return output({ ok: false, needLogin: true, message: e.message });
  }

  try {
    const type = args.type || 'unpaid';

    // Navigate to order page to establish origin
    await page.goto('https://kyfw.12306.cn/otn/view/train_order.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
    
    // Check if we got redirected to login (session expired)
    if (page.url().includes('login')) {
      return output({ ok: false, needLogin: true, message: 'Session expired. Run: 12306-cli session start' });
    }

    // Directly call the appropriate API endpoint
    let endpoint, body;
    if (type === 'unpaid') {
      endpoint = '/otn/queryOrder/queryMyOrderNoComplete';
      body = '_json_att=';
    } else {
      // upcoming (queryType=1) or history (queryType=2)
      const queryType = type === 'history' ? '2' : '1';
      const today = new Date();
      const start = new Date(today); start.setDate(start.getDate() - 90);
      const fmt = d => d.toISOString().split('T')[0];
      endpoint = '/otn/queryOrder/queryMyOrder';
      body = `pageIndex=0&pageSize=100&queryType=${queryType}&query_where=G&sequeue_train_name=&queryStartDate=${fmt(start)}&queryEndDate=${fmt(today)}`;
    }

    const apiResult = await page.evaluate(async ({ url, body }) => {
      const r = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body
      });
      const text = await r.text();
      try { return JSON.parse(text); } catch { return { raw: text }; }
    }, { url: endpoint, body });

    // Parse the response — both endpoints use different field names
    const orderList = apiResult.data?.orderDBList
      || apiResult.data?.OrderDTODataList
      || [];

    if (apiResult.status === false || orderList.length === 0) {
      return output({
        ok: true, type, count: 0, orders: [],
        message: type === 'unpaid' ? 'No unpaid orders' : type === 'history' ? 'No history orders' : 'No upcoming (paid) orders'
      });
    }

    // Extract structured order info from order list
    // upcoming uses queryMyOrder API (snake_case), unpaid uses queryMyOrderNoComplete (camelCase on stationTrainDTO)
    const parseDate = d => (d || '').length === 8 ? `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}` : (d || '').substring(0, 10);
    const parseTime = t => (t?.match(/\d{2}:\d{2}/) || [''])[0];

    const orders = orderList.map(order => {
      const seq = order.sequence_no || order.sequenceNo || '';
      const od = order.order_date || order.orderDate || '';
      const amt = order.ticket_price_all || order.ticketPriceAll || '';

      return {
        sequenceNo: seq,
        orderDate: od,
        amount: amt ? (amt / 100).toFixed(2) : '',
        tickets: (order.tickets || []).map(t => {
          const dto = t.stationTrainDTO || {};
          const pax = t.passengerDTO || {};
          return {
            passenger: pax.passenger_name || t.passengerName || '',
            idType: pax.passenger_id_type_name || t.idTypeName || '',
            ticketNo: t.ticket_no || t.ticketNo || '',
            trainCode: dto.station_train_code || dto.trainCode || '',
            fromStation: dto.from_station_name || dto.fromStationName || '',
            toStation: dto.to_station_name || dto.toStationName || '',
            travelDate: parseDate(t.train_date || dto.start_date_str),
            departure: parseTime(dto.start_time || dto.startTime),
            arrival: parseTime(dto.arrive_time || dto.arriveTime),
            seatType: t.seat_type_name || t.seatTypeName || '',
            coach: t.coach_no || t.coach || '',
            seatNo: t.seat_no || t.seatNo || '',
            price: t.ticket_price ? (t.ticket_price / 100).toFixed(2) : (t.ticketPrice || ''),
            status: t.ticket_status_name || t.ticketStatus || ''
          };
        })
      };
    });

    return output({
      ok: true,
      type,
      count: orders.length,
      orders
    });
  } finally {
    pool.disconnect(browser);
  }
}

// ── Cancel ──

async function cmdCancel(args, config) {
  let browser, context, page;
  try {
    ({ browser, context, page } = await pool.connect());
  } catch (e) {
    return output({ ok: false, needLogin: true, message: e.message });
  }

  try {
    await page.goto('https://kyfw.12306.cn/otn/view/train_order.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    // Load order page
    await page.evaluate(() => {
      const links = document.querySelectorAll('a[data-href]');
      for (const a of links) {
        if (a.getAttribute('data-href')?.includes('train_order')) { a.click(); break; }
      }
    });
    await page.waitForTimeout(5000);

    // Look for cancel buttons
    const cancelInfo = await page.evaluate(() => {
      const btns = document.querySelectorAll('a, button');
      const cancelBtns = [];
      for (const btn of btns) {
        const t = btn.textContent?.trim();
        if (t === '取消订单' || t === '取消' || t === 'Cancel') {
          cancelBtns.push({ text: t, id: btn.id, cls: btn.className, onclick: btn.getAttribute('onclick')?.substring(0, 100) });
        }
      }
      return cancelBtns;
    });

    if (cancelInfo.length === 0) {
      const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
      if (bodyText.includes('没有未完成')) {
        return output({ ok: true, message: 'No unpaid orders to cancel' });
      }
      return output({ ok: false, error: 'Cancel button not found. May need to cancel via app.', cancelBtns: cancelInfo });
    }

    // Click the first cancel button
    await page.evaluate(() => {
      const btns = document.querySelectorAll('a, button');
      for (const btn of btns) {
        const t = btn.textContent?.trim();
        if (t === '取消订单' || t === '取消') { btn.click(); break; }
      }
    });
    await page.waitForTimeout(3000);

    // Handle confirmation dialog
    page.on('dialog', async dialog => {
      await dialog.accept();
    });

    // Look for confirm button in popup
    await page.evaluate(() => {
      const btns = document.querySelectorAll('a, button');
      for (const btn of btns) {
        const t = btn.textContent?.trim();
        if (t === '确定' || t === '确认') { btn.click(); break; }
      }
    });
    await page.waitForTimeout(5000);

    const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
    const success = bodyText.includes('取消成功') || bodyText.includes('成功') || !bodyText.includes('未完成');

    return output({ ok: success, message: success ? 'Order cancelled' : 'Cancel may have failed', bodySnippet: bodyText.substring(0, 300) });
  } finally {
    pool.disconnect(browser);
  }
}

// ── Commander Program ──

function buildArgsFromOpts(opts) {
  const args = {};
  if (opts.from) args.from = opts.from;
  if (opts.to) args.to = opts.to;
  if (opts.date) args.date = opts.date;
  if (opts.train) args.train = opts.train;
  if (opts.passenger) args.passenger = opts.passenger;
  if (opts.seatType) args.seatType = opts.seatType;
  if (opts.seatPos) args.seatPos = opts.seatPos;
  if (opts.trainFilter) args.trainFilter = opts.trainFilter;
  if (opts.profile) args.profile = opts.profile;
  if (opts.conf) args.conf = opts.conf;
  if (opts.smsCode) args.smsCode = opts.smsCode;  // login command only
  if (opts.type) args.type = opts.type;
  if (opts.headless !== undefined) args.headless = opts.headless;
  if (opts.yes) args.yes = 'true';
  if (opts.auto) args.auto = 'true';
  return args;
}

const program = new Command();

program
  .name('12306-cli')
  .description(
    '中国铁路12306 CLI — 搜索车次、在线订票、查询订单\n' +
    'China Railway 12306 CLI — search, book, and manage train tickets\n\n' +
    'First-time setup:\n' +
    '  12306-cli config set username <your_username>\n' +
    '  12306-cli config set password <your_password>\n' +
    '  12306-cli config set id_last4 <last_4_digits_of_id>\n\n' +
    'Quick start:\n' +
    '  12306-cli session start            # launch browser + login\n' +
    '  12306-cli session start --sms-code 123456  # submit SMS code\n' +
    '  12306-cli search --from 北京 --to 上海 --date 2026-06-15\n' +
    '  12306-cli book --from 北京 --to 上海 --date 2026-06-15 \\\n' +
    '    --train G35 --passenger 张三 --seat-type 二等座 --seat-pos F --yes\n\n' +
    'Maintenance window: booking unavailable 1:00–6:00 AM CST daily.'
  )
  .version('1.4.0');

// ── Station lookup ──

const STATION_URL = 'https://kyfw.12306.cn/otn/resources/js/framework/station_name.js';

async function fetchStations() {
  const https = require('https');
  return new Promise((resolve, reject) => {
    https.get(STATION_URL, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        const m = d.match(/'(.+)'/);
        if (!m) return reject(new Error('Failed to parse station data'));
        const stations = [];
        for (const entry of m[1].split('@')) {
          if (!entry) continue;
          const p = entry.split('|');
          if (p.length >= 6 && p[1]) {
            stations.push({ name: p[1], code: p[2], pinyin: p[3], short: p[4] });
          }
        }
        resolve(stations);
      });
    }).on('error', reject);
  });
}

// Popular cities for display (station name → city name for grouping)
const POPULAR = [
  '北京','上海','广州','深圳','成都','重庆','杭州','南京','武汉','西安',
  '长沙','天津','苏州','郑州','哈尔滨','昆明','大连','青岛','厦门','三亚',
  '济南','福州','合肥','南昌','沈阳','长春','贵阳','兰州','太原','石家庄',
  '南宁','乌鲁木齐','呼和浩特','拉萨','银川','西宁',
];

// ─── Cities ─────────────────────────────────────────────

program
  .command('cities')
  .description('Show supported city/station names for search and booking')
  .option('-f, --filter <keyword>', 'Filter by city name, pinyin, or station code')
  .addHelpText('after',
    '\nExamples:\n' +
    '  $ 12306-cli cities\n' +
    '  $ 12306-cli cities --filter 北京\n' +
    '  $ 12306-cli cities -f shanghai\n\n' +
    'Use the Chinese city/station name with --from and --to:\n' +
    '  $ 12306-cli search --from 北京 --to 上海 --date 2026-06-15'
  )
  .action(async (opts) => {
    try {
      const stations = await fetchStations();
      const keyword = (opts.filter || '').toLowerCase();

      if (keyword) {
        // Search by name, pinyin, or code
        const matches = stations.filter(s =>
          s.name.includes(keyword) ||
          s.pinyin.startsWith(keyword) ||
          s.short.startsWith(keyword) ||
          s.code.toLowerCase() === keyword
        );
        const result = matches.map(s => ({ name: s.name, code: s.code, pinyin: s.pinyin }));
        output({ ok: true, count: result.length, stations: result });
        return;
      }

      // No filter — show popular cities with their stations
      const cityStations = {};
      for (const s of stations) {
        // Group by city: match station name to popular city list
        const city = POPULAR.find(c => s.name.startsWith(c) || s.name === c);
        if (!city) continue;
        if (!cityStations[city]) cityStations[city] = [];
        cityStations[city].push(s);
      }

      const result = POPULAR
        .filter(c => cityStations[c])
        .map(city => ({
          city,
          stations: cityStations[city].map(s => `${s.name} (${s.code})`)
        }));

      output({ ok: true, count: result.length, cities: result });
    } catch (e) {
      output({ ok: false, error: e.message });
    }
  });

// ─── Search ─────────────────────────────────────────────

program
  .command('search')
  .description('Search trains with seat availability (no login required)')
  .requiredOption('--from <city>', 'Departure city (Chinese name, e.g. 北京)')
  .requiredOption('--to <city>', 'Arrival city (Chinese name, e.g. 上海)')
  .requiredOption('--date <YYYY-MM-DD>', 'Travel date')
  .option('--train-filter <prefix>', 'Filter by train code prefix, comma-separated (e.g. G, G,D)')
  .addOption(new (require('commander').Option)('--headless <bool>', 'Show browser').default('true').hideHelp())
  .addHelpText('after',
    '\nExamples:\n' +
    '  $ 12306-cli search --from 北京 --to 上海 --date 2026-06-15\n' +
    '  $ 12306-cli search --from 北京 --to 上海 --date 2026-06-15 --train-filter G\n\n' +
    'Output JSON:\n' +
    '  { ok: true, date, from, to, count, source,\n' +
    '    trains: [{ code, fromStation, toStation, departure, arrival,\n' +
    '               duration, bookable, seats: { "二等座": "有", ... } }] }\n\n' +
    'Seat values: "有" = available, "无" = sold out, number = remaining count.'
  )
  .action(async (opts) => {
    const args = buildArgsFromOpts(opts);
    const config = loadConfig(args);
    await cmdSearch(args, config);
  });

// ─── Book ───────────────────────────────────────────────

program
  .command('book')
  .description(
    'Book a train ticket (requires login)\n\n' +
    '  Params resolved: CLI flags > env vars > config profile > interactive prompt.\n' +
    '  Requires --yes (confirmed) or --auto (automated) to place order.\n\n' +
    '  Multi-passenger: --passenger "张三,李四" --seat-pos "F,D"\n' +
    '  Seat types: 二等座, 一等座, 特等座, 商务座\n' +
    '  Seat positions: A=window-left, B=middle, C=aisle-left, D=aisle-right, F=window-right\n' +
    '  Seat selection only available on high-speed (G) trains. For D/Z/T/K trains,\n' +
    '  seat position is auto-assigned by 12306.',
  )
  .option('--from <city>', 'Departure city')
  .option('--to <city>', 'Arrival city')
  .option('--date <YYYY-MM-DD>', 'Travel date')
  .option('--train <code>', 'Train code (e.g. G35)')
  .option('--passenger <names>', 'Passenger name(s), comma-separated for multi-passenger')
  .option('--seat-type <type>', 'Seat type: 二等座, 一等座, 商务座 (substring match)')
  .option('--seat-pos <letters>', 'Seat position(s), comma-separated (A/B/C/D/F). G-trains only.')
  .option('-y, --yes', 'Confirm order (user has approved)')
  .option('--auto', 'Automated booking (cron/recurring, no confirmation)')
  .addOption(new (require('commander').Option)('--headless <bool>', 'Show browser').default('true').hideHelp())
  .addHelpText('after',
    '\nExamples:\n' +
    '  # Single passenger:\n' +
    '  $ 12306-cli book --from 北京 --to 上海 --date 2026-06-15 \\\n' +
    '      --train G35 --passenger 张三 --seat-type 二等座 --seat-pos F --yes\n\n' +
    '  # Multi-passenger:\n' +
    '  $ 12306-cli book --from 北京 --to 上海 --date 2026-06-15 \\\n' +
    '      --train G35 --passenger "张三,李四" --seat-type 二等座 --seat-pos "F,D" --yes\n\n' +
    '  # With config defaults for passenger/route (no need to repeat):\n' +
    '  $ 12306-cli book --date 2026-06-15 --train G35 --yes\n\n' +
    'Output JSON (success):\n' +
    '  { ok: true, train, passengers: [...], seatType, seatPos,\n' +
    '    date, from, to, message }\n\n' +
    'Output JSON (not logged in):\n' +
    '  { ok: false, needLogin: true, message: "Not logged in. Run: 12306-cli session start" }\n\n' +
    'Output JSON (error):\n' +
    '  { ok: false, error: "description" }'
  )
  .action(async (opts) => {
    const args = buildArgsFromOpts(opts);
    const config = loadConfig(args);
    await cmdBook(args, config);
  });

// ─── Session ───────────────────────────────────────────

async function cmdSessionStart(args, config) {
  const headless = args.headless !== 'false';

  // If smsCode provided (phase 2), just reconnect to existing browser
  const { running } = await pool.status();

  if (args.smsCode && running) {
    // Phase 2: reconnect and submit code
    const browser = await chromium.connectOverCDP(pool._readInfo().wsEndpoint);
    const context = browser.contexts()[0];
    const page = context.pages()[0];

    try {
      await page.fill('#code', args.smsCode);
      await page.click('#sureClick');
      await page.waitForTimeout(5000);

      const isLogin = await page.evaluate(async () => {
        const r = await fetch('/otn/login/conf', { method: 'POST', credentials: 'include' });
        return (await r.json()).data?.is_login;
      });

      if (isLogin !== 'Y') {
        pool.disconnect(browser);
        return { ok: false, error: 'Login failed. Check credentials and SMS code.' };
      }

    // Navigate to home page so subsequent commands don't start on login page
    await page.goto('https://www.12306.cn', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    pool.disconnect(browser);
    return { ok: true, message: 'Session started. Browser running in background.' };
    } catch (e) {
      pool.disconnect(browser);
      return { ok: false, error: e.message };
    }
  }

  if (running) {
    return { ok: false, error: 'Session already active. Run `12306-cli session stop` first to restart.' };
  }

  const { vars } = config;
  const missing = [];
  if (!vars.TRAIN_USERNAME) missing.push('username');
  if (!vars.TRAIN_PASSWORD) missing.push('password');
  if (!vars.TRAIN_ID_LAST4) missing.push('id_last4');
  if (missing.length > 0) {
    return { ok: false, error: `Missing config: ${missing.join(', ')}. Run: 12306-cli config set <key> <value>` };
  }

  // Phase 1: Launch browser, fill credentials, send SMS
  let wsEndpoint;
  try {
    ({ wsEndpoint } = await pool.launch(headless));
  } catch (e) {
    return { ok: false, error: e.message };
  }
  console.error('🚄 Browser launched.');

  const browser = await chromium.connectOverCDP(wsEndpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0];

  try {
    await page.goto('https://kyfw.12306.cn/otn/resources/login.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    await page.fill('#J-userName', vars.TRAIN_USERNAME);
    await page.fill('#J-password', vars.TRAIN_PASSWORD);
    await page.click('#J-login');
    await page.waitForTimeout(3000);

    await page.click('#verification li:nth-child(2)');
    await page.waitForTimeout(1000);

    await page.fill('#id_card', vars.TRAIN_ID_LAST4);
    await page.waitForTimeout(500);

    await page.click('#verification_code');
    await page.waitForTimeout(3000);
    pool.disconnect(browser);
    return { ok: false, needSmsCode: true, message: 'SMS sent. Re-run: 12306-cli session start --sms-code <code>' };
  } catch (e) {
    pool.disconnect(browser);
    return { ok: false, error: e.message };
  }
}

async function cmdSessionStop() {
  await pool.kill();
  console.error('✅ Session stopped.');
  return { ok: true, message: 'Session stopped.' };
}

async function cmdSessionStatus() {
  const { running, info } = await pool.status();
  return { ok: true, running, info };
}

program
  .command('session <action>')
  .description(
    'Manage browser session (persistent Chromium via CDP)\n\n' +
    '  start    Launch browser and login via SMS\n' +
    '  stop     Kill the browser session\n' +
    '  status   Show session status\n\n' +
    '  Browser stays alive between commands — no startup overhead.\n' +
    '  Commands (search/book/orders/cancel) reconnect via CDP.'
  )
  .option('--sms-code <code>', 'SMS verification code (phase 2 of start)')
  .addOption(new (require('commander').Option)('--headless <bool>', 'Show browser').default('true').hideHelp())
  .addHelpText('after',
    '\nExamples:\n' +
    '  $ 12306-cli session start              # launch browser + send SMS\n' +
    '  $ 12306-cli session start --sms-code 123456  # submit code\n' +
    '  $ 12306-cli session status\n' +
    '  $ 12306-cli session stop\n\n' +
    'Output JSON (start - SMS sent):\n' +
    '  { ok: false, needSmsCode: true, message: "SMS sent..." }\n\n' +
    'Output JSON (start - success):\n' +
    '  { ok: true, message: "Session started..." }\n\n' +
    'Output JSON (status):\n' +
    '  { ok: true, running: true/false }'
  )
  .action(async (action, opts) => {
    const args = buildArgsFromOpts(opts);
    const config = loadConfig(args);
    if (action === 'start') {
      const result = await cmdSessionStart(args, config);
      if (result.ok) console.error('✅ ' + result.message);
      else if (result.needSmsCode) console.error('📱 ' + result.message);
      else console.error('❌ ' + (result.error || 'Failed'));
      output(result);
    } else if (action === 'stop') {
      output(await cmdSessionStop());
    } else if (action === 'status') {
      output(await cmdSessionStatus());
    } else {
      output({ ok: false, error: `Unknown action: ${action}. Use: start, stop, status` });
    }
  });

// ─── Orders ─────────────────────────────────────────────

program
  .command('orders')
  .description('Check orders (default: unpaid). Requires login.\n\n' +
    '  Types:\n' +
    '    unpaid   — Unpaid / unfinished orders (default)\n' +
    '    upcoming — Paid but not yet traveled\n' +
    '    history  — Completed / refunded orders')
  .option('-t, --type <type>', 'Order type: unpaid (default), upcoming, or history', 'unpaid')
  .addOption(new (require('commander').Option)('--headless <bool>', 'Show browser').default('true').hideHelp())
  .addHelpText('after',
    '\nExamples:\n' +
    '  $ 12306-cli orders\n' +
    '  $ 12306-cli orders --type upcoming\n' +
    '  $ 12306-cli orders -t history\n\n' +
    'Output JSON:\n' +
    '  { ok: true, type, count, orders: [{ sequenceNo, orderDate, amount,\n' +
    '    tickets: [{ passenger, trainCode, fromStation, toStation, travelDate,\n' +
    '               departure, arrival, seatType, coach, seatNo, price, status }] }] }\n\n' +
    '  When not logged in: { ok: false, needLogin: true }'
  )
  .action(async (opts) => {
    const args = buildArgsFromOpts(opts);
    const config = loadConfig(args);
    await cmdOrders(args, config);
  });

// ─── Cancel ─────────────────────────────────────────────

program
  .command('cancel')
  .description('Cancel unpaid order (requires login)\n\n' +
    '  Note: cancellation may require the 12306 mobile app.\n' +
    '  Max ~3 cancels/day before lockout.')
  .addOption(new (require('commander').Option)('--headless <bool>', 'Show browser').default('true').hideHelp())
  .addHelpText('after',
    '\nExample:\n' +
    '  $ 12306-cli cancel\n\n' +
    'Output JSON:\n' +
    '  { ok: true/false, message }\n\n' +
    '  When not logged in: { ok: false, needLogin: true }'
  )
  .action(async (opts) => {
    const args = buildArgsFromOpts(opts);
    const config = loadConfig(args);
    await cmdCancel(args, config);
  });

// ─── Config helpers ─────────────────────────────────────

const CONFIG_KEYS = [
  { key: 'TRAIN_USERNAME',  desc: '12306 username (required)', secret: true },
  { key: 'TRAIN_PASSWORD',  desc: '12306 password (required)', secret: true },
  { key: 'TRAIN_ID_LAST4',  desc: 'ID card last 4 digits (required)' },
  { key: 'TRAIN_PASSENGER', desc: 'Default passenger name(s), comma-separated for multi-passenger' },
  { key: 'TRAIN_FROM',      desc: 'Default departure city' },
  { key: 'TRAIN_TO',        desc: 'Default arrival city' },
  { key: 'TRAIN_SEAT_TYPE', desc: 'Default seat type (二等座, 一等座, 商务座)' },
  { key: 'TRAIN_SEAT_POS',  desc: 'Default seat position(s) (A/B/C/D/F)' },
];

function resolveConfPath(profileName) {
  const profilesDir = path.join(CONFIG_DIR, 'profiles');
  if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });
  const confPath = path.join(profilesDir, `${profileName}.conf`);
  return confPath;
}

function configSet(key, value, profileName = 'personal') {
  const normalizedKey = key.toUpperCase().replace(/-/g, '_');
  let fullKey;
  if (!normalizedKey.startsWith('TRAIN_')) {
    const match = CONFIG_KEYS.find(k => k.key === `TRAIN_${normalizedKey}`);
    if (match) fullKey = match.key;
    else return { ok: false, error: `Unknown key: ${key}. Run "12306-cli config list" to see valid keys.` };
  } else {
    fullKey = normalizedKey;
  }

  const valid = CONFIG_KEYS.find(k => k.key === fullKey);
  if (!valid) return { ok: false, error: `Unknown key: ${fullKey}. Run "12306-cli config list" to see valid keys.` };

  const confPath = resolveConfPath(profileName);

  // Read existing file content, preserving comments and blank lines
  let lines = [];
  if (fs.existsSync(confPath)) {
    lines = fs.readFileSync(confPath, 'utf-8').split('\n');
  }

  // Find and update the target line, or append if not found
  let found = false;
  lines = lines.map(line => {
    const m = line.match(/^\s*(TRAIN_[A-Z_0-9]+)="([^"]*)"/);
    if (m && m[1] === fullKey) { found = true; return `${fullKey}="${value}"`; }
    return line;
  });
  if (!found) {
    lines.push(`${fullKey}="${value}"`);
  }
  // Remove trailing blank lines, add one final newline
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  fs.writeFileSync(confPath, lines.join('\n') + '\n');

  // Update default symlink
  const defaultLink = path.join(CONFIG_DIR, 'default');
  if (!fs.existsSync(defaultLink)) {
    fs.symlinkSync(path.join('profiles', `${profileName}.conf`), defaultLink);
  }

  return { ok: true, key: fullKey, value, file: confPath };
}

function configGet(key, profileName = 'personal') {
  const normalizedKey = key.toUpperCase().replace(/-/g, '_');
  const fullKey = normalizedKey.startsWith('TRAIN_') ? normalizedKey : `TRAIN_${normalizedKey}`;
  const valid = CONFIG_KEYS.find(k => k.key === fullKey);
  if (!valid) return { ok: false, error: `Unknown key: ${key}.` };

  const confPath = resolveConfPath(profileName);
  const vars = parseConfFile(confPath);
  const val = vars[fullKey] || null;
  return { ok: true, key: fullKey, value: val || '(not set)', file: confPath };
}

function configList(profileName = 'personal') {
  const confPath = resolveConfPath(profileName);
  const vars = parseConfFile(confPath);
  const result = {};
  for (const k of CONFIG_KEYS) {
    result[k.key] = vars[k.key] ? (k.secret ? '***' : vars[k.key]) : '(not set)';
  }
  return {
    ok: true,
    profile: profileName,
    file: confPath,
    vars: result,
  };
}

// ─── Config Command ─────────────────────────────────────

program
  .command('config <action> [key] [value]')
  .description(
    'Manage configuration\n\n' +
    '  Actions:\n' +
    '    list    Show all config values\n' +
    '    get     Get a value\n' +
    '    set     Set a value\n' +
    '    path    Print config file path\n\n' +
    '  Config dir: ~/.config/12306-cli/\n' +
    '  Lookup order (highest priority first):\n' +
    '    CLI arg > env var > profile .conf > interactive prompt'
  )
  .option('--profile <name>', 'Profile name (default: "personal")', 'personal')
  .addHelpText('after',
    '\nExamples:\n' +
    '  $ 12306-cli config set username myname\n' +
    '  $ 12306-cli config set password mypass\n' +
    '  $ 12306-cli config set id_last4 1234\n' +
    '  $ 12306-cli config set passenger "张三"\n' +
    '  $ 12306-cli config set from 北京\n' +
    '  $ 12306-cli config set seat_type 二等座\n' +
    '  $ 12306-cli config list\n' +
    '  $ 12306-cli config get passenger\n' +
    '  $ 12306-cli config path\n\n' +
    'Keys (shorthand or full TRAIN_* name):\n' +
    '  username    TRAIN_USERNAME    12306 username (required)\n' +
    '  password    TRAIN_PASSWORD    12306 password (required)\n' +
    '  id_last4    TRAIN_ID_LAST4    ID card last 4 digits (required)\n' +
    '  passenger   TRAIN_PASSENGER   Default passenger name(s)\n' +
    '  from        TRAIN_FROM        Default departure city\n' +
    '  to          TRAIN_TO          Default arrival city\n' +
    '  seat_type   TRAIN_SEAT_TYPE   Default seat type\n' +
    '  seat_pos    TRAIN_SEAT_POS    Default seat position(s) (A/B/C/D/F, G-trains only)'
  )
  .action((action, key, value, opts) => {
    const profileName = opts.profile || 'personal';

    switch (action) {
      case 'set': {
        if (!key || value === undefined) {
          console.error('Usage: 12306-cli config set <key> <value>');
          process.exit(1);
        }
        const result = configSet(key, value, profileName);
        output(result);
        break;
      }
      case 'get': {
        if (!key) {
          console.error('Usage: 12306-cli config get <key>');
          process.exit(1);
        }
        const result = configGet(key, profileName);
        output(result);
        break;
      }
      case 'list': {
        const result = configList(profileName);
        output(result);
        break;
      }
      case 'path': {
        const confPath = resolveConfPath(profileName);
        output({ ok: true, path: confPath });
        break;
      }
      default:
        console.error(`Unknown action: ${action}. Use: list, get, set, path`);
        process.exit(1);
    }
  });

// ─── Skill Install ─────────────────────────────────────

program
  .command('skill install')
  .description('Install the AI agent skill (pi or openclaw)')
  .option('-a, --agent <name>', 'Agent to install for: pi (default) or openclaw', 'pi')
  .option('--target <dir>', 'Custom target directory (overrides --agent)')
  .addHelpText('after',
    '\nInstall the 12306-cli skill for AI agent use.\n' +
    'Copies SKILL.md and references to the agent skills directory.\n\n' +
    'Pi:        ~/.pi/agent/skills/12306-cli/\n' +
    'OpenClaw:  ~/.openclaw/workspace/skills/12306-cli/\n\n' +
    'Examples:\n' +
    '  $ 12306-cli skill install              # pi (default)\n' +
    '  $ 12306-cli skill install -a openclaw  # openclaw\n' +
    '  $ 12306-cli skill install --target /custom/path'
  )
  .action((install, opts) => {
    const scriptDir = __dirname;
    const srcDir = path.join(scriptDir, '..', '.pi', 'skills', '12306-cli');
    
    // Resolve target directory
    let targetDir;
    if (opts.target) {
      targetDir = opts.target;
    } else if (opts.agent === 'openclaw') {
      targetDir = path.join(process.env.HOME, '.openclaw', 'workspace', 'skills', '12306-cli');
    } else {
      targetDir = path.join(process.env.HOME, '.pi', 'agent', 'skills', '12306-cli');
    }

    if (!fs.existsSync(srcDir)) {
      console.error('Skill source not found at', srcDir);
      output({ ok: false, error: 'Skill source not found. Are you running from the 12306-cli project directory?' });
      return;
    }

    // Copy recursively
    function copyDir(src, dest) {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) {
          copyDir(s, d);
        } else {
          fs.copyFileSync(s, d);
          console.error(`  → ${path.relative(targetDir, d)}`);
        }
      }
    }

    try {
      copyDir(srcDir, targetDir);
      console.error(`✅ Skill installed to ${targetDir}`);
      output({ ok: true, installedTo: targetDir });
    } catch (e) {
      output({ ok: false, error: e.message });
    }
  });

program.parse();
