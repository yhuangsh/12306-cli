/**
 * 12306 Booking Tool — Multi-command CLI
 *
 * Commands:
 *   search   — List trains with times, seat availability
 *   book     — Place an order (login → search → book → seat selection)
 *   orders   — Check unpaid orders with seat details
 *   cancel   — Cancel an unpaid order
 *
 * Multi-passenger: --passenger "张三,李四" --seat-pos "F,F"
 * Sensitive info: .env or profile.conf (TRAIN_USERNAME, TRAIN_PASSWORD, TRAIN_ID_LAST4)
 * Params: CLI args (--from, --to, --date, --train, --passenger, --seat-type, --seat-pos)
 * Missing params: prompted interactively
 *
 * Output: JSON to stdout
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// ── Config ──
//
// Profiles: ~/.config/12306-booking/profiles/<name>.conf
// Default:  ~/.config/12306-booking/default → symlink to profiles/<name>.conf
// Sessions: ~/.config/12306-booking/sessions/<name>.cookies.json
//
// Lookup: --profile <name> > TRAIN_PROFILE env var > "default" symlink
// Override: --conf <path> (bypasses profile system entirely)

const CONFIG_DIR = path.join(process.env.HOME || '/tmp', '.config', '12306-booking');

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
      // Fallback: try profiles/default.conf, then legacy .env
      confPath = path.join(profilesDir, 'default.conf');
      if (!fs.existsSync(confPath)) {
        const legacy = path.join(configDir, '.env');
        if (fs.existsSync(legacy)) return { name: 'default', conf: legacy, cookies: path.join(configDir, '.session-cookies.json') };
        return { name: 'default', conf: null, cookies: path.join(configDir, '.session-cookies.json') };
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
  const hint = defaultVal ? ` (${defaultVal})` : '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(`${question}${hint}: `, answer => {
    rl.close();
    resolve((answer.trim() || defaultVal || '').trim());
  }));
}

function askChoice(question, options) {
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

// ── Browser ──

async function createBrowser(cookies, headless = true) {
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  if (cookies) await context.addCookies(cookies);
  return { browser, context };
}

async function ensureSession(context, { profile, vars }, args) {
  const cookiesPath = profile.cookies;
  let cookies = fs.existsSync(cookiesPath) ? JSON.parse(fs.readFileSync(cookiesPath, 'utf-8')) : null;

  if (cookies) await context.addCookies(cookies);

  // Check
  let needLogin = true;
  if (cookies) {
    const p = await context.newPage();
    await p.goto('https://kyfw.12306.cn/otn/resources/login.html', { waitUntil: 'networkidle' });
    const ok = await p.evaluate(async () => {
      const r = await fetch('/otn/login/conf', { method: 'POST', credentials: 'include' });
      return (await r.json()).data?.is_login;
    });
    await p.close();
    if (ok === 'Y') needLogin = false;
  }

  if (needLogin) {
    const missing = [];
    if (!vars.TRAIN_USERNAME) missing.push('TRAIN_USERNAME');
    if (!vars.TRAIN_PASSWORD) missing.push('TRAIN_PASSWORD');
    if (!vars.TRAIN_ID_LAST4) missing.push('TRAIN_ID_LAST4');
    if (missing.length > 0) return { error: `Missing in .env: ${missing.join(', ')}` };

    if (!args.smsCode) {
      // Session expired — don't send SMS yet, just tell agent to re-run with --sms-code
      return { needSmsCode: true, message: 'Session expired. Re-run with --sms-code XXXXXX to login.' };
    }

    // Login with SMS code (sends SMS then immediately submits code)
    const page = await context.newPage();
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

    await page.fill('#code', args.smsCode);
    await page.click('#sureClick');
    await page.waitForTimeout(5000);

    cookies = await context.cookies();
    fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
    console.error('💾 Session saved.');
    await page.close();
  }

  return { ok: true };
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

  const { browser, context } = await createBrowser(null, args.headless !== 'false');
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
    await browser.close();
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

  const { browser, context } = await createBrowser(null, args.headless !== 'false');
  try {
    const sess = await ensureSession(context, config, args);
    if (sess.error) return output({ ok: false, error: sess.error });
    if (sess.needSmsCode) return output({ ok: false, needSmsCode: true, message: sess.message });

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
          seats.push({ id: a.id, letter: a.id.replace(/^[0-]+/, '') });
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
    await browser.close();
  }
}

// ── Orders (check unpaid) ──

async function cmdOrders(args, config) {
  const { browser, context } = await createBrowser(null, args.headless !== 'false');
  try {
    const sess = await ensureSession(context, config, args);
    if (sess.error) return output({ ok: false, error: sess.error });
    if (sess.needSmsCode) return output({ ok: false, needSmsCode: true, message: sess.message });

    const page = await context.newPage();

    // Navigate to order page via the index
    await page.goto('https://kyfw.12306.cn/otn/view/train_order.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    // Intercept the AJAX call that loads orders
    let orderData = null;
    page.on('response', async resp => {
      if (resp.url().includes('queryMyOrderNoComplete') || resp.url().includes('queryOrder')) {
        try { orderData = await resp.text(); } catch(e) {}
      }
    });

    // Click the 火车票订单 link to trigger order loading
    await page.evaluate(() => {
      const links = document.querySelectorAll('a[data-href]');
      for (const a of links) {
        if (a.getAttribute('data-href')?.includes('train_order')) { a.click(); break; }
      }
    });
    await page.waitForTimeout(5000);

    // Parse order info from page body
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    const hasUnpaid = !bodyText.includes('没有未完成');

    if (!hasUnpaid) {
      return output({ ok: true, orders: [], message: 'No unpaid orders' });
    }

    // Extract order details from the rendered page
    const orders = await page.evaluate(() => {
      // Look for order entries in the content
      const orderEls = document.querySelectorAll('.order-item, [class*=order-row], tbody tr');
      const results = [];
      for (const el of orderEls) {
        const text = el.innerText?.trim();
        if (text && text.length > 10) {
          results.push(text.replace(/\s+/g, ' ').substring(0, 200));
        }
      }
      return results;
    });

    return output({
      ok: true,
      hasUnpaid: true,
      orders,
      rawBody: bodyText.substring(0, 2000)
    });
  } finally {
    await browser.close();
  }
}

// ── Cancel ──

async function cmdCancel(args, config) {
  const { browser, context } = await createBrowser(null, args.headless !== 'false');
  try {
    const sess = await ensureSession(context, config, args);
    if (sess.error) return output({ ok: false, error: sess.error });
    if (sess.needSmsCode) return output({ ok: false, needSmsCode: true, message: sess.message });

    const page = await context.newPage();
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
    await browser.close();
  }
}

// ── Main ──

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig(args);

  const command = process.argv[2];

  switch (command) {
    case 'search': return (await cmdSearch(args, config));
    case 'book': return (await cmdBook(args, config));
    case 'orders': return (await cmdOrders(args, config));
    case 'cancel': return (await cmdCancel(args, config));
    default:
      console.error(`Usage: node booking.js <command> [options]`);
      console.error('');
      console.error('Commands:');
      console.error('  search   List trains (--from, --to, --date)');
      console.error('  book     Place order (--from, --to, --date, --train, --passenger, --seat-type, --seat-pos)');
      console.error('  orders   Check unpaid orders');
      console.error('  cancel   Cancel unpaid order');
      console.error('');
      console.error('Booking options:');
      console.error('  --from <city>          Departure city');
      console.error('  --to <city>            Arrival city');
      console.error('  --date <YYYY-MM-DD>    Travel date');
      console.error('  --train <code>         Train code (e.g. G35)');
      console.error('  --passenger <names>    Passenger name(s), comma-separated for multi-passenger');
      console.error('                         e.g. --passenger "张三,李四"');
      console.error('  --seat-type <type>     Seat type: 二等座, 一等座, 商务座 (substring match)');
      console.error('  --seat-pos <letters>   Seat position(s), comma-separated for multi-passenger');
      console.error('                         A=window-left, B=middle, C=aisle, D=aisle, F=window-right');
      console.error('                         e.g. --seat-pos "F,F" (both passengers window)');
      console.error('  --yes                  Confirm order (agent has user approval)');
      console.error('  --auto                 Automated booking (cron/recurring, no confirmation)');
      console.error('');
      console.error('Search filters:');
      console.error('  --train-filter <prefix>  Filter by train code prefix, comma-separated');
      console.error('                           e.g. --train-filter G (high-speed only)');
      console.error('                           e.g. --train-filter G,D (high-speed + EMU)');
      console.error('');
      console.error('Config options:');
      console.error('  --profile <name>       Use named profile (default: "default" symlink)');
      console.error('  --conf <path>          Custom config file (bypasses profile system)');
      console.error('');
      console.error('Session options:');
      console.error('  --sms-code <code>      SMS verification code (for login)');
      console.error('  --headless false       Show browser (default: true)');
      console.error('');
      console.error('Config profiles (~/.config/12306-booking/):');
      console.error('  profiles/<name>.conf   Config file per profile');
      console.error('  default                Symlink to active profile');
      console.error('  sessions/<name>.cookies.json  Saved login session');
      console.error('');
      console.error('Config file format (profiles/<name>.conf):');
      console.error('  TRAIN_USERNAME="..."   # 12306 username (required)');
      console.error('  TRAIN_PASSWORD="..."   # 12306 password (required)');
      console.error('  TRAIN_ID_LAST4="..."   # ID card last 4 digits (required)');
      console.error('  TRAIN_FROM="..."       # Default departure city');
      console.error('  TRAIN_TO="..."         # Default arrival city');
      console.error('  TRAIN_PASSENGER="..."  # Default passenger name(s)');
      console.error('  TRAIN_SEAT_TYPE="..."  # Default seat type');
      console.error('  TRAIN_SEAT_POS="..."   # Default seat position(s) (A/B/C/D/F)');
      console.error('');
      console.error('Lookup order (highest priority first):');
      console.error('  CLI arg > env var > profile .conf > interactive prompt');
      console.error('');
      console.error('Multi-passenger booking:');
      console.error('  node booking.js book --from 北京 --to 上海 --date 2026-05-22 \\');
      console.error('    --train G35 --passenger "张三,李四" \\');
      console.error('    --seat-type 二等座 --seat-pos "F,F" --yes');
      console.error('');
      console.error('Environment variables (same names as config file):');
      console.error('  TRAIN_PROFILE          Profile name (instead of --profile)');
      console.error('  TRAIN_USERNAME          etc.');
      return output({ ok: false, error: `Unknown command: ${command}` });
  }
}

main().catch(e => output({ ok: false, error: e.message }));
