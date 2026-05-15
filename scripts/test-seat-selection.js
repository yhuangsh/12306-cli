/**
 * Test seat selection flow — does NOT place order
 * 
 * Flow: search → book → passenger page → select passenger+seat → click 提交订单
 * → inspect seat selection dialog → report findings
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
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
  await ctx.addCookies(cookies);

  const page = await ctx.newPage();

  // Check session
  await page.goto('https://kyfw.12306.cn/otn/resources/login.html', { waitUntil: 'networkidle' });
  const isLogin = await page.evaluate(async () => {
    const r = await fetch('/otn/login/conf', { method: 'POST', credentials: 'include' });
    return (await r.json()).data?.is_login;
  });
  if (isLogin !== 'Y') {
    console.log('⚠️  Session expired. Log in manually in the browser, then press Enter here.');
    await ask('Press Enter after login...');
  } else {
    console.log('✅ Session valid.');
  }
  await page.close();

  // Search
  const from = await ask('\n🚄 出发城市: ') || '北京';
  const to = await ask('🚄 到达城市: ') || '上海';
  const date = await ask('📅 日期 (YYYY-MM-DD): ') || '2026-05-23';

  console.log('\n🔍 Searching...');
  const searchPage = await ctx.newPage();
  await searchPage.goto(
    `https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=${encodeURIComponent(from)}&ts=${encodeURIComponent(to)}&date=${date}&flag=N,N,Y`,
    { waitUntil: 'networkidle' }
  );
  await searchPage.waitForTimeout(3000);

  await searchPage.evaluate(({ fromCity, toCity, d }) => {
    $('#fromStationText').val(fromCity); $('#toStationText').val(toCity); $('#train_date').val(d);
    const gc = n => { const m = station_names.match(new RegExp('@[^|]*\\|'+n+'\\|([A-Z]+)')); return m?m[1]:''; };
    $('#fromStation').val(gc(fromCity)); $('#toStation').val(gc(toCity));
  }, { fromCity: from, toCity: to, d: date });

  await searchPage.click('#query_ticket');
  await searchPage.waitForTimeout(8000);

  const trains = await searchPage.evaluate(() => {
    return Array.from(document.querySelectorAll('tr[id^="ticket_"]')).map(row => {
      const code = row.querySelector('.number, .train a')?.textContent?.trim() || '';
      const btn = row.querySelector('a.btn72');
      return { code, onclick: btn?.getAttribute('onclick') || '', bookable: btn?.textContent.trim() === '预订' };
    }).filter(t => t.code && t.bookable);
  });

  console.log(`\n🚄 ${trains.length} bookable trains:`);
  trains.slice(0, 20).forEach((t, i) => console.log(`  ${i + 1}. ${t.code}`));

  if (trains.length === 0) { console.log('❌ None'); await browser.close(); return; }

  const idxStr = await ask('\nPick train #: ') || '1';
  const idx = parseInt(idxStr) - 1;
  const selected = trains[idx] || trains[0];
  console.log(`\n📝 Selected: ${selected.code}`);

  // Submit order via page onclick
  console.log('📝 Submitting order...');
  await searchPage.evaluate((oc) => eval(oc), selected.onclick);
  await searchPage.waitForTimeout(8000);

  if (!searchPage.url().includes('confirmPassenger/initDc')) {
    console.log('❌ Not on passenger page:', searchPage.url());
    await ask('Press Enter to close...'); await browser.close(); return;
  }
  console.log('✅ On passenger page.');

  // Check seat selection variables
  const seatVars = await searchPage.evaluate(() => ({
    canChooseSeats: typeof canChooseSeats !== 'undefined' ? canChooseSeats : 'undefined',
    choose_Seats: typeof choose_Seats !== 'undefined' ? choose_Seats : 'undefined',
  }));
  console.log(`\n💺 canChooseSeats=${seatVars.canChooseSeats}, choose_Seats=${seatVars.choose_Seats}`);

  // Select first passenger
  await searchPage.waitForTimeout(2000);
  console.log('\n👤 Selecting first passenger...');
  await searchPage.evaluate(() => {
    const cb = document.querySelector('#normal_passenger_id input[type=checkbox], input[type=checkbox][id*=normal_passenger]');
    if (cb) cb.click();
  });
  await searchPage.waitForTimeout(1500);

  // Select 二等座
  const seatOk = await searchPage.evaluate(() => {
    const sel = document.querySelector('#seatType');
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
  await searchPage.waitForTimeout(1500);

  // Click 提交订单
  console.log('\n📋 Clicking 提交订单...');
  const submitBtn = await searchPage.evaluate(() => {
    const btn = document.querySelector('#submitOrder_id, a[id*=submitOrder]');
    return btn ? { id: btn.id, text: btn.textContent.trim() } : null;
  });
  console.log('   Button:', JSON.stringify(submitBtn));

  if (submitBtn?.id) {
    await searchPage.click(`#${submitBtn.id}`);
  } else {
    await searchPage.click('text=提交订单');
  }

  console.log('   Waiting for seat selection dialog...');
  await searchPage.waitForTimeout(5000);

  // Inspect the seat selection dialog
  const seatDialog = await searchPage.evaluate(() => {
    // Check for the seat dialog
    const dialog = document.querySelector('#id-seat-sel, [id*=seat-sel], .seat-sel');
    const allVisible = [];

    // Also check for any dialog/modal that appeared
    const modals = document.querySelectorAll('.dhtmlx_popup, [class*=modal], [class*=dialog], [id*=dialog]');
    
    // Search broadly for seat-related elements
    const allEls = document.querySelectorAll('[id]');
    for (const el of allEls) {
      const id = el.id;
      if ((id.match(/^[0-9][A-F]$/) || id.match(/^selectLink/) || id.includes('seat') || id.includes('Seat')) 
          && el.offsetWidth > 0) {
        allVisible.push({
          id, tag: el.tagName, text: el.textContent.trim().substring(0, 30),
          cls: el.className?.toString()?.substring(0, 40) || '',
          rect: { w: el.offsetWidth, h: el.offsetHeight }
        });
      }
    }

    // Also check for qr_submit_id (confirm button in seat dialog)
    const confirmBtn = document.querySelector('#qr_submit_id');
    const confirmInfo = confirmBtn ? { visible: confirmBtn.offsetWidth > 0, text: confirmBtn.textContent.trim() } : null;

    return {
      hasSeatDialog: !!dialog && dialog.offsetWidth > 0,
      seatDialogId: dialog?.id || 'none',
      seatElements: allVisible,
      confirmButton: confirmInfo,
      // Also get any visible text about seats
      bodySnippet: document.body.innerText.match(/选座[^。\n]{0,200}/)?.[0] || 'no seat text found'
    };
  });

  console.log('\n=== Seat Dialog ===');
  console.log('Has seat dialog:', seatDialog.hasSeatDialog);
  console.log('Dialog ID:', seatDialog.seatDialogId);
  console.log('Body text match:', seatDialog.bodySnippet);
  console.log('Seat elements found:', JSON.stringify(seatDialog.seatElements, null, 2));
  console.log('Confirm button (#qr_submit_id):', JSON.stringify(seatDialog.confirmButton));

    // If we found seat elements, try clicking one with real mouse events
  if (seatDialog.seatElements.length > 0) {
    // Find a window seat (A or F)
    const target = seatDialog.seatElements.find(e => e.id.match(/^[0-9]F$/)) || 
                   seatDialog.seatElements.find(e => e.id.match(/^[0-9]A$/)) ||
                   seatDialog.seatElements[0];
    
    console.log(`\n🖱️  Trying to click seat ${target.id} with real mouse events...`);
    
    // Get coordinates via page.evaluate (more reliable than boundingBox for numeric IDs)
    const coords = await searchPage.evaluate((seatId) => {
      const el = document.querySelector('[id="' + seatId + '"]');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: rect.width, h: rect.height };
    }, target.id);
    
    if (coords) {
      console.log(`   Coordinates: x=${coords.x}, y=${coords.y}, w=${coords.w}, h=${coords.h}`);
      
      // Take a screenshot to see the page state
      await searchPage.screenshot({ path: path.join(__dirname, '..', 'debug-before-click.png') });
      console.log('   Screenshot saved: debug-before-click.png');
      
      // Try multiple approaches
      // Approach 1: Direct mouse.click (simpler API)
      console.log('   Approach 1: page.mouse.click...');
      await searchPage.mouse.click(coords.x, coords.y);
      await searchPage.waitForTimeout(2000);
      
      let afterClick = await searchPage.evaluate((seatId) => {
        const el = document.querySelector('[id="' + seatId + '"]');
        return {
          className: el?.className || '',
          selected: el?.classList.contains('cur') || false,
        };
      }, target.id);
      console.log('   After approach 1:', JSON.stringify(afterClick));
      
      if (!afterClick.selected) {
        // Approach 2: Dispatch real mouse event sequence via page context
        console.log('   Approach 2: dispatchEvent in page context...');
        afterClick = await searchPage.evaluate((seatId) => {
          const el = document.querySelector('[id="' + seatId + '"]');
          if (!el) return { error: 'element not found' };
          const rect = el.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          
          // Simulate full mouse event sequence
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
          el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: x, clientY: y }));
          el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y, button: 0 }));
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y, button: 0 }));
          
          return {
            className: el.className,
            selected: el.classList.contains('cur'),
          };
        }, target.id);
        console.log('   After approach 2:', JSON.stringify(afterClick));
      }
      
      if (!afterClick.selected) {
        // Approach 3: Just evaluate el.click() directly
        console.log('   Approach 3: el.click() via evaluate...');
        afterClick = await searchPage.evaluate((seatId) => {
          const el = document.querySelector('[id="' + seatId + '"]');
          if (el) el.click();
          return { selected: el?.classList.contains('cur') || false };
        }, target.id);
        console.log('   After approach 3:', JSON.stringify(afterClick));
      }
      
      // Verify: which seats now have 'cur' class?
      const selStatus = await searchPage.evaluate(() => {
        const text = document.querySelector('#id-seat-sel')?.textContent || '';
        const match = text.match(/已选座(\d+\/\d+)/);
        const selected = [];
        document.querySelectorAll('#id-seat-sel a').forEach(a => {
          if (a.classList.contains('cur')) selected.push(a.id);
        });
        return { counter: match ? match[1] : 'unknown', selectedSeats: selected };
      });
      console.log(`   Seat counter: ${selStatus.counter}`);
      console.log(`   Selected seats (have 'cur' class): ${JSON.stringify(selStatus.selectedSeats)}`);
      
      await searchPage.screenshot({ path: path.join(__dirname, '..', 'debug-after-click.png') });
      console.log('   Screenshot saved: debug-after-click.png');
    } else {
      console.log('   ❌ Could not get coordinates for', target.id);
    }
  } else {
    console.log('\n⚠️  No seat elements found. The dialog may not have appeared.');
    console.log('   Check the browser window to see what\'s on screen.');
  }

  console.log('\n🛑 TEST MODE — no order placed. Inspect browser window.');
  await ask('Press Enter to close...');
  await browser.close();
}

main().catch(e => console.error('Fatal:', e));
