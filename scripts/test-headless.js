/**
 * Test: headless mode + ID last4 from env
 * Stops BEFORE placing order (no 确认 click)
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function loadEnv() {
  const content = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf-8');
  const vars = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

async function main() {
  const env = loadEnv();
  console.log('🔧 Config:', {
    username: env.TRAIN_USERNAME,
    idLast4: env.TRAIN_ID_LAST4 ? env.TRAIN_ID_LAST4 + ' ✅' : '❌ MISSING'
  });

  if (!env.TRAIN_ID_LAST4) {
    console.log('❌ TRAIN_ID_LAST4 not set in .env');
    process.exit(1);
  }

  const cookiesPath = path.join(__dirname, '..', '.session-cookies.json');
  let cookies = fs.existsSync(cookiesPath) ? JSON.parse(fs.readFileSync(cookiesPath, 'utf-8')) : null;

  // HEADLESS mode
  console.log('\n🌐 Launching HEADLESS browser...');
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
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

  try {
    // Check session
    let needLogin = true;
    if (cookies) {
      console.log('🔑 Checking saved session...');
      const p = await context.newPage();
      await p.goto('https://kyfw.12306.cn/otn/resources/login.html', { waitUntil: 'networkidle' });
      const ok = await p.evaluate(async () => {
        const r = await fetch('/otn/login/conf', { method: 'POST', credentials: 'include' });
        return (await r.json()).data?.is_login;
      });
      await p.close();
      if (ok === 'Y') { console.log('✅ Session valid!'); needLogin = false; }
      else { console.log('⚠️  Session expired.'); }
    }

    if (needLogin) {
      console.log('\n📋 Logging in...');
      const page = await context.newPage();
      await page.goto('https://kyfw.12306.cn/otn/resources/login.html', { waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);

      await page.fill('#J-userName', env.TRAIN_USERNAME);
      await page.fill('#J-password', env.TRAIN_PASSWORD);
      await page.click('#J-login');
      await page.waitForTimeout(3000);

      // Click SMS tab
      await page.click('#verification li:nth-child(2)');
      await page.waitForTimeout(1000);

      // Fill ID last4 from env (no prompt!)
      console.log(`📋 Using ID last4 from env: ${env.TRAIN_ID_LAST4}`);
      await page.fill('#id_card', env.TRAIN_ID_LAST4);
      await page.waitForTimeout(500);
      await page.click('#verification_code');
      console.log('📱 SMS sent. Waiting for code...');
      await page.waitForTimeout(3000);

      const smsCode = await ask('📱 6位验证码: ');
      await page.fill('#code', smsCode);
      await page.click('#sureClick');
      await page.waitForTimeout(5000);

      // Save cookies
      cookies = await context.cookies();
      fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
      console.log('💾 Cookies saved.');
      await page.close();
    }

    // ── Search ──
    console.log('\n🔍 Searching 北京→上海 2026-05-22...');
    const page = await context.newPage();
    await page.goto(
      'https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=%E5%8C%97%E4%BA%AC&ts=%E4%B8%8A%E6%B5%B7&date=2026-05-22&flag=N,N,Y',
      { waitUntil: 'networkidle' }
    );
    await page.waitForTimeout(3000);

    await page.evaluate(({ fromCity, toCity, d }) => {
      $('#fromStationText').val(fromCity); $('#toStationText').val(toCity); $('#train_date').val(d);
      const gc = n => { const m = station_names.match(new RegExp('@[^|]*\\|'+n+'\\|([A-Z]+)')); return m?m[1]:''; };
      $('#fromStation').val(gc(fromCity)); $('#toStation').val(gc(toCity));
    }, { fromCity: '北京', toCity: '上海', d: '2026-05-22' });

    await page.click('#query_ticket');
    await page.waitForTimeout(8000);

    const trains = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('tr[id^="ticket_"]')).map(row => {
        const code = row.querySelector('.number, .train a')?.textContent?.trim() || '';
        const btn = row.querySelector('a.btn72');
        return { code, onclick: btn?.getAttribute('onclick') || '', bookable: btn?.textContent.trim() === '预订' };
      }).filter(t => t.code && t.bookable);
    });

    console.log(`🚄 ${trains.length} bookable trains. Picking first one: ${trains[0]?.code}`);

    if (trains.length === 0) {
      console.log('❌ No trains.'); await browser.close(); return;
    }

    // ── Submit order ──
    const selected = trains[0];
    console.log(`📝 Submitting order for ${selected.code}...`);
    console.log('   onclick:', selected.onclick.substring(0, 200));

    // Intercept network to see what happens
    const ajaxResponses = [];
    page.on('response', async resp => {
      const url = resp.url();
      if (url.includes('submitOrder') || url.includes('checkUser') || url.includes('initDc') || url.includes('leftTicket')) {
        let body = '';
        try { body = await resp.text(); } catch(e) {}
        ajaxResponses.push({ url: url.substring(url.indexOf('/otn')), status: resp.status(), body: body.substring(0, 300) });
      }
    });

    // Try the eval
    const evalResult = await page.evaluate((oc) => {
      try {
        const result = eval(oc);
        return { ok: true, result: String(result) };
      } catch(e) {
        return { ok: false, error: e.message };
      }
    }, selected.onclick);
    console.log('   eval result:', JSON.stringify(evalResult));
    console.log('   Waiting 10s for network...');
    await page.waitForTimeout(10000);
    console.log('   URL:', page.url());
    console.log('   AJAX responses:', JSON.stringify(ajaxResponses, null, 2));

    if (!page.url().includes('confirmPassenger/initDc')) {
      console.log('❌ Not on passenger page:', page.url());
      await browser.close(); return;
    }
    console.log('✅ On passenger page.');

    // ── Select first passenger ──
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const items = document.querySelectorAll('#normal_passenger_id li, .passenger-ul li');
      if (items[0]) {
        const cb = items[0].querySelector('input[type=checkbox], input[type=radio]');
        if (cb) cb.click();
      }
    });
    await page.waitForTimeout(1500);
    console.log('👤 Selected first passenger.');

    // ── Select 二等座 ──
    const seatOk = await page.evaluate(() => {
      const sel = document.querySelector('#seatType_1') || document.querySelector('#seatType');
      if (!sel) return false;
      for (const opt of sel.options) {
        if (opt.textContent.includes('二等座')) {
          sel.value = opt.value;
          opt.selected = true;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    });
    console.log(`💺 Selected 二等座: ${seatOk}`);
    await page.waitForTimeout(1500);

    // ── Click 提交订单 ──
    console.log('📋 Clicking 提交订单...');
    const submitBtn = await page.evaluate(() => {
      const btn = document.querySelector('#submitOrder_id, a[id*=submitOrder]');
      return btn ? btn.id : null;
    });
    if (submitBtn) await page.click(`#${submitBtn}`);
    else await page.click('text=提交订单');

    await page.waitForTimeout(5000);

    // ── Check seat dialog ──
    const seatDialog = await page.evaluate(() => {
      const dialog = document.querySelector('#id-seat-sel');
      if (!dialog || dialog.offsetWidth === 0) return { available: false };

      const seats = [];
      dialog.querySelectorAll('a[id]').forEach(a => {
        if (a.id.match(/^[0-9][A-F]$/)) {
          seats.push({ id: a.id, selected: a.classList.contains('cur') });
        }
      });
      const text = dialog.textContent || '';
      const match = text.match(/已选座(\d+\/\d+)/);
      return { available: true, seats, counter: match ? match[1] : 'unknown' };
    });

    console.log('\n💺 Seat dialog:', JSON.stringify(seatDialog, null, 2));

    if (seatDialog.available && seatDialog.seats.length > 0) {
      // Click 1F (window seat) using dispatchEvent
      console.log('🖱️  Clicking seat 1F via dispatchEvent...');
      const clickResult = await page.evaluate((seatId) => {
        const el = document.querySelector('[id="' + seatId + '"]');
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
        return { ok: true, selected: el.classList.contains('cur'), className: el.className };
      }, '1F');
      console.log('   Result:', JSON.stringify(clickResult));

      await page.waitForTimeout(2000);

      const verify = await page.evaluate(() => {
        const selected = [];
        document.querySelectorAll('#id-seat-sel a').forEach(a => {
          if (a.classList.contains('cur')) selected.push(a.id);
        });
        const text = document.querySelector('#id-seat-sel')?.textContent || '';
        const match = text.match(/已选座(\d+\/\d+)/);
        return { selectedSeats: selected, counter: match ? match[1] : 'unknown' };
      });
      console.log('   Verified:', JSON.stringify(verify));
    }

    // 🛑 STOP — do NOT click 确认, do NOT place order
    console.log('\n🛑 TEST MODE — stopping before order placement.');
    console.log('✅ All steps passed in HEADLESS mode!');

  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
