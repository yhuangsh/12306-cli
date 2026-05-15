/**
 * Quick inspect: get to passenger page and dump all seat-related UI
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ask = (q) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); return new Promise(r => rl.question(q, a => { rl.close(); r(a.trim()); })); };

async function main() {
  const cookies = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.session-cookies.json'), 'utf-8'));
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1440, height: 900 }
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
  await ctx.addCookies(cookies);

  const page = await ctx.newPage();

  // Login check
  await page.goto('https://kyfw.12306.cn/otn/resources/login.html', { waitUntil: 'networkidle' });
  const isLogin = await page.evaluate(async () => {
    const r = await fetch('/otn/login/conf', { method: 'POST', credentials: 'include' });
    return (await r.json()).data?.is_login;
  });

  if (isLogin !== 'Y') {
    console.log('⚠️  Session expired. Please log in manually in the browser window.');
    console.log('   Then come back here and press Enter.');
    await ask('Press Enter after you logged in...');
  } else {
    console.log('✅ Session valid.');
  }

  // Search
  console.log('\n🔍 Searching 北京→上海 2026-05-22...');
  await page.goto('https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=%E5%8C%97%E4%BA%AC&ts=%E4%B8%8A%E6%B5%B7&date=2026-05-22&flag=N,N,Y', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  await page.evaluate(() => {
    $('#fromStationText').val('北京'); $('#toStationText').val('上海'); $('#train_date').val('2026-05-22');
    const gc = n => { const m = station_names.match(new RegExp('@[^|]*\\|'+n+'\\|([A-Z]+)')); return m?m[1]:''; };
    $('#fromStation').val(gc('北京')); $('#toStation').val(gc('上海'));
  });
  await page.click('#query_ticket');
  await page.waitForTimeout(8000);

  // Book first available train
  const onclick = await page.evaluate(() => {
    for (const row of document.querySelectorAll('tr[id^="ticket_"]')) {
      const btn = row.querySelector('a.btn72');
      if (btn && btn.textContent.trim() === '预订') return btn.getAttribute('onclick');
    }
    return null;
  });

  if (!onclick) { console.log('❌ No bookable trains'); await browser.close(); return; }

  console.log('📝 Submitting order...');
  await page.evaluate((oc) => eval(oc), onclick);
  await page.waitForTimeout(8000);

  if (!page.url().includes('confirmPassenger')) {
    console.log('❌ Not on passenger page:', page.url());
    await ask('Press Enter to close...'); await browser.close(); return;
  }

  console.log('✅ On passenger page.');

  // Select first passenger
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    const cb = document.querySelector('#normal_passenger_id input[type=checkbox], input[type=checkbox][id*=passenger]');
    if (cb) cb.click();
  });
  await page.waitForTimeout(2000);

  // Now dump EVERYTHING related to seats
  const seatDump = await page.evaluate(() => {
    // Seat type dropdown
    const seatSelect = document.querySelector('#seatType');
    const seatOptions = seatSelect ? Array.from(seatSelect.options).map(o => ({ value: o.value, text: o.textContent.trim() })) : [];

    // Look for seat position selector (A B C D F)
    const allElements = document.querySelectorAll('*');
    const seatRelated = [];
    for (const el of allElements) {
      const text = el.textContent?.trim() || '';
      const id = el.id || '';
      const cls = el.className?.toString() || '';
      
      // Check for seat position elements
      if (/^[A-F]$/.test(text) && el.children.length === 0) {
        seatRelated.push({ tag: el.tagName, id, cls: cls.substring(0, 40), text, parent: el.parentElement?.id || el.parentElement?.className?.toString()?.substring(0, 40) || '' });
      }
      
      // Check for seat/choose elements
      if (id.includes('seat') || id.includes('choose') || cls.includes('seat') || cls.includes('choose')) {
        if (el.children.length <= 3) {
          seatRelated.push({ tag: el.tagName, id, cls: cls.substring(0, 60), text: text.substring(0, 50), html: el.innerHTML?.substring(0, 200) || '' });
        }
      }
    }

    // Check for a seat map / seat diagram
    const seatMap = document.querySelector('[class*=seat-map], [class*=seatMap], [id*=seat-map]');
    
    // Look for any hidden seat fields
    const hiddenSeat = document.querySelector('input[id*=seat][type=hidden], input[name*=seat]');

    return {
      seatOptions,
      seatRelated: seatRelated.slice(0, 30),
      hasSeatMap: !!seatMap,
      seatMapHTML: seatMap?.innerHTML?.substring(0, 300) || 'none',
      hiddenSeat: hiddenSeat ? { id: hiddenSeat.id, name: hiddenSeat.name, value: hiddenSeat.value } : null
    };
  });

  console.log('\n=== Seat Type Options ===');
  console.log(JSON.stringify(seatDump.seatOptions, null, 2));

  console.log('\n=== Seat Position Elements ===');
  seatDump.seatRelated.forEach(el => console.log(JSON.stringify(el)));

  console.log('\n=== Seat Map ===');
  console.log('Has seat map:', seatDump.hasSeatMap);
  console.log('HTML:', seatDump.seatMapHTML);

  console.log('\n=== Hidden Seat Fields ===');
  console.log(JSON.stringify(seatDump.hiddenSeat));

  // Also try selecting 二等座 to see if seat positions appear
  console.log('\nTrying to select 二等座 to trigger seat position UI...');
  await page.evaluate(() => {
    const sel = document.querySelector('#seatType');
    if (sel) {
      // Find 二等座 option
      for (const opt of sel.options) {
        if (opt.textContent.includes('二等座')) { sel.value = opt.value; opt.selected = true; break; }
      }
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await page.waitForTimeout(3000);

  const afterSelect = await page.evaluate(() => {
    // Check again for seat position elements
    const all = document.querySelectorAll('*');
    const found = [];
    for (const el of all) {
      const text = el.textContent?.trim() || '';
      if (/^[A-F]$/.test(text) && el.children.length === 0) {
        found.push({ tag: el.tagName, id: el.id || '', cls: el.className?.toString()?.substring(0, 40) || '', text, visible: el.offsetWidth > 0, parent: el.parentElement?.className?.toString()?.substring(0, 40) || '' });
      }
    }
    
    // Also check for new dialogs/panels
    const panels = document.querySelectorAll('[class*=seat], [id*=seat], [class*=choose]');
    const panelInfo = Array.from(panels).map(p => ({
      id: p.id, cls: p.className?.toString()?.substring(0, 40) || '', 
      visible: p.offsetWidth > 0 && p.offsetHeight > 0,
      html: p.innerHTML?.substring(0, 300) || ''
    })).filter(p => p.visible && p.html.length > 10);

    return { seatLetters: found, panels: panelInfo };
  });

  console.log('\n=== After selecting 二等座 ===');
  console.log('Seat letters:', JSON.stringify(afterSelect.seatLetters, null, 2));
  console.log('Panels:', JSON.stringify(afterSelect.panels.map(p => ({ id: p.id, cls: p.cls, html: p.html.substring(0, 150) })), null, 2));

  console.log('\n✅ Done. Browser open for you to inspect.');
  await ask('Press Enter to close...');
  await browser.close();
}

main().catch(e => console.error(e));
