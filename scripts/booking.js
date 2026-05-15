/**
 * 12306 Booking Tool — Multi-command CLI
 *
 * Commands:
 *   search   — List trains with times, prices, availability
 *   book     — Place an order (login → search → book → seat selection)
 *   orders   — Check unpaid orders with seat details
 *   cancel   — Cancel an unpaid order
 *
 * Sensitive info: .env (TRAIN_USERNAME, TRAIN_PASSWORD, TRAIN_ID_LAST4)
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

async function cmdSearch(args, config) {
  const from = args.from || config.vars.TRAIN_FROM || await ask('🚄 出发城市');
  const to = args.to || config.vars.TRAIN_TO || await ask('🚄 到达城市');
  const date = args.date || await ask('📅 日期 (YYYY-MM-DD)');
  if (!from || !to || !date) return output({ ok: false, error: 'Missing: from, to, date' });

  const { browser, context } = await createBrowser(null, args.headless !== 'false');
  try {
    // Search does NOT need login — skip ensureSession entirely
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
        const tds = row.querySelectorAll('td');
        const raw = Array.from(tds).map(td => td.textContent?.trim()?.replace(/\s+/g, ' ') || '');

        // Parse the first cell: "G35复静查看票价北京南上海虹桥19:2423:5104:27当日到达"
        const header = raw[0] || '';
        const timeMatch = header.match(/(\d{2}:\d{2})(\d{2}:\d{2})(\d{2}:\d{2})/);
        const stationMatch = header.match(/(?:查看票价|票价)(.+?)(\d{2}:\d{2})/);

        return {
          code,
          departure: timeMatch ? timeMatch[1] : '',
          arrival: timeMatch ? timeMatch[2] : '',
          duration: timeMatch ? timeMatch[3] : '',
          fromStation: stationMatch ? stationMatch[1].trim() : '',
          bookable: btn?.textContent.trim() === '预订',
          availability: raw.slice(1, 10)
        };
      }).filter(t => t.code);
    });

    return output({ ok: true, date, from, to, trains });
  } finally {
    await browser.close();
  }
}

// ── Book ──

async function cmdBook(args, config) {
  const from = args.from || config.vars.TRAIN_FROM || await ask('🚄 出发城市');
  const to = args.to || config.vars.TRAIN_TO || await ask('🚄 到达城市');
  const date = args.date || await ask('📅 日期 (YYYY-MM-DD)');
  if (!from || !to || !date) return output({ ok: false, error: 'Missing: from, to, date' });

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

    // Passenger
    await page.waitForTimeout(2000);
    const passengers = await page.evaluate(() => {
      const items = document.querySelectorAll('#normal_passenger_id li, .passenger-ul li');
      return Array.from(items).map(li => {
        const name = li.querySelector('label, .name')?.textContent?.trim() || li.textContent.trim();
        return name.substring(0, 20);
      }).filter(n => n.length > 0 && n.length < 15);
    });

    let passengerIdx = 0;
    if (args.passenger || config.vars.TRAIN_PASSENGER) {
      const pName = args.passenger || config.vars.TRAIN_PASSENGER;
      passengerIdx = passengers.findIndex(p => p.includes(pName));
      if (passengerIdx === -1) passengerIdx = await askChoice('Select passenger', passengers);
    } else if (passengers.length > 1) {
      passengerIdx = await askChoice('Select passenger', passengers);
    }

    await page.evaluate((idx) => {
      const items = document.querySelectorAll('#normal_passenger_id li, .passenger-ul li');
      if (items[idx]) {
        const cb = items[idx].querySelector('input[type=checkbox], input[type=radio]');
        if (cb) cb.click();
      }
    }, passengerIdx);
    await page.waitForTimeout(1500);

    // Seat type
    const seatOptions = await page.evaluate(() => {
      const sel = document.querySelector('#seatType_1') || document.querySelector('#seatType');
      if (!sel) return [];
      return Array.from(sel.options).filter(o => o.value).map(o => ({ value: o.value, text: o.textContent.trim() }));
    });

    let seatTypeIdx = 0;
    if ((args.seatType || config.vars.TRAIN_SEAT_TYPE) && seatOptions.length > 0) {
      const st = args.seatType || config.vars.TRAIN_SEAT_TYPE;
      seatTypeIdx = seatOptions.findIndex(s => s.text.includes(st));
      if (seatTypeIdx === -1) seatTypeIdx = await askChoice('Select seat type', seatOptions.map(s => s.text));
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

    // Submit order → seat dialog
    const submitBtn = await page.evaluate(() => {
      const btn = document.querySelector('#submitOrder_id, a[id*=submitOrder]');
      return btn ? btn.id : null;
    });
    if (submitBtn) await page.click(`#${submitBtn}`);
    else await page.click('text=提交订单');
    await page.waitForTimeout(5000);

    // Seat position
    const seatDialog = await page.evaluate(() => {
      const dialog = document.querySelector('#id-seat-sel');
      if (!dialog || dialog.offsetWidth === 0) return { available: false };
      const seats = [];
      dialog.querySelectorAll('a[id]').forEach(a => {
        if (a.id.match(/^[0-9]+[A-F]$/) && a.offsetWidth > 0) {
          seats.push({ id: a.id, letter: a.id.replace(/^[0-9]+/, '') });
        }
      });
      const letters = [...new Set(seats.map(s => s.letter))];
      return { available: true, letters };
    });

    if (seatDialog.available && seatDialog.letters.length > 0) {
      const descriptions = { A: '靠窗', B: '中间', C: '过道', D: '过道', F: '靠窗' };
      let seatPos = args.seatPos ? args.seatPos.toUpperCase() : config.vars.TRAIN_SEAT_POS ? config.vars.TRAIN_SEAT_POS.toUpperCase() : null;
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
    }

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

    return output({
      ok: success,
      train: selected.code,
      passenger: passengers[passengerIdx] || 'unknown',
      seatType: seatOptions[seatTypeIdx]?.text || 'default',
      seatPos: args.seatPos ? args.seatPos.toUpperCase() : 'auto',
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
      console.error('  --from <city>       Departure city');
      console.error('  --to <city>         Arrival city');
      console.error('  --date <YYYY-MM-DD> Travel date');
      console.error('  --train <code>      Train code (e.g. G35)');
      console.error('  --passenger <name>  Passenger name (substring match)');
      console.error('  --seat-type <type>  Seat type: 二等座, 一等座, 商务座 (substring match)');
      console.error('  --seat-pos <letter> Seat position: A=window-left, B=middle, C=aisle, D=aisle, F=window-right');
      console.error('  --yes               Confirm order (agent has user approval)');
      console.error('  --auto              Automated booking (cron/recurring, no confirmation)');
      console.error('');
      console.error('Config options:');
      console.error('  --profile <name>    Use named profile (default: "default" symlink)');
      console.error('  --conf <path>       Custom config file (bypasses profile system)');
      console.error('');
      console.error('Session options:');
      console.error('  --sms-code <code>   SMS verification code (for login)');
      console.error('  --headless false    Show browser (default: true)');
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
      console.error('  TRAIN_PASSENGER="..."  # Default passenger name');
      console.error('  TRAIN_SEAT_TYPE="..."  # Default seat type');
      console.error('  TRAIN_SEAT_POS="..."   # Default seat position (A/B/C/D/F)');
      console.error('');
      console.error('Lookup order (highest priority first):');
      console.error('  CLI arg > env var > profile .conf > interactive prompt');
      console.error('');
      console.error('Environment variables (same names as config file):');
      console.error('  TRAIN_PROFILE          Profile name (instead of --profile)');
      console.error('  TRAIN_USERNAME          etc.');
      return output({ ok: false, error: `Unknown command: ${command}` });
  }
}

main().catch(e => output({ ok: false, error: e.message }));
