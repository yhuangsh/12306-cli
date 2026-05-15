/**
 * Trace REAL booking flow v2 — properly trigger the onclick handler
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main() {
  const cookies = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.session-cookies.json'), 'utf-8'));

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  await context.addCookies(cookies);

  const page = await context.newPage();

  // Capture network
  const apiLog = [];
  page.on('request', req => {
    if (req.url().includes('kyfw.12306.cn/otn') && !req.url().match(/\.(js|css|png|jpg|gif|ico|html)/)) {
      apiLog.push({ method: req.method(), url: req.url().replace('https://kyfw.12306.cn', ''), postData: req.postData()?.substring(0, 500) || '' });
    }
  });
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('kyfw.12306.cn/otn') && !url.match(/\.(js|css|png|jpg|gif|ico|html)/)) {
      try {
        const body = await res.text();
        apiLog.push({ type: 'response', status: res.status(), url: url.replace('https://kyfw.12306.cn', ''), body: body.substring(0, 500) });
      } catch(e) {}
    }
  });

  console.log('1️⃣  Loading ticket search page...');
  await page.goto(
    'https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=%E5%8C%97%E4%BA%AC&ts=%E4%B8%8A%E6%B5%B7&date=2026-05-14&flag=N,N,Y',
    { waitUntil: 'networkidle' }
  );
  await page.waitForTimeout(3000);

  // Set form and trigger page's own query to render trains
  await page.evaluate(() => {
    $('#fromStationText').val('北京');
    $('#toStationText').val('上海');
    $('#train_date').val('2026-05-14');
    const getStationCode = (name) => {
      const m = station_names.match(new RegExp(`@[^|]*\\|${name}\\|([A-Z]+)`));
      return m ? m[1] : '';
    };
    $('#fromStation').val(getStationCode('北京'));
    $('#toStation').val(getStationCode('上海'));
  });

  await page.click('#query_ticket');
  console.log('   Waiting for trains to render...');
  await page.waitForTimeout(8000);

  const trainCount = await page.evaluate(() => document.querySelectorAll('tr[id^="ticket_"]').length);
  console.log(`   ${trainCount} trains rendered.`);

  // Get the onclick handler for the first train's 预订 button
  const firstBtnInfo = await page.evaluate(() => {
    const firstRow = document.querySelector('tr[id^="ticket_"]');
    if (!firstRow) return null;
    const btn = firstRow.querySelector('a.btn72');
    if (!btn) return null;
    return {
      onclick: btn.getAttribute('onclick'),
      text: btn.textContent.trim(),
      rowId: firstRow.id
    };
  });
  console.log(`\n2️⃣  First train button: "${firstBtnInfo.text}"`);
  console.log(`   onclick: ${firstBtnInfo.onclick?.substring(0, 150)}...`);

  // Clear API log, then trigger the onclick directly
  apiLog.length = 0;
  console.log('\n3️⃣  Triggering onclick via page.evaluate...');

  await page.evaluate(() => {
    const firstRow = document.querySelector('tr[id^="ticket_"]');
    const btn = firstRow?.querySelector('a.btn72');
    if (btn) {
      // Dispatch a real click event
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      btn.dispatchEvent(event);
    }
  });

  console.log('   Waiting for page reaction...');
  await page.waitForTimeout(10000);

  // Print all API calls
  console.log('\n=== Network activity after click ===');
  apiLog.forEach(entry => {
    if (entry.type === 'response') {
      console.log(`  ← ${entry.status} ${entry.url}`);
      console.log(`    Body: ${entry.body.substring(0, 300)}`);
    } else {
      console.log(`  → ${entry.method} ${entry.url}`);
      if (entry.postData) console.log(`    Data: ${entry.postData.substring(0, 300)}`);
    }
    console.log();
  });

  // Check page state
  const pageState = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    bodyText: document.body.innerText.substring(0, 500)
  }));
  console.log('\n=== Page state ===');
  console.log('URL:', pageState.url);

  // If a dialog appeared, handle it
  const hasDialog = await page.evaluate(() => {
    const dialog = document.querySelector('#confirmG1234, [id*=dialog], .dhtmlx_popup');
    return dialog ? { id: dialog.id, visible: dialog.offsetWidth > 0 } : null;
  });
  console.log('Dialog:', JSON.stringify(hasDialog));

  // If no network activity, the onclick might need to be called differently
  if (apiLog.length === 0) {
    console.log('\n⚠️  No network activity! Trying direct function call...');
    
    await page.evaluate(() => {
      const firstRow = document.querySelector('tr[id^="ticket_"]');
      const btn = firstRow?.querySelector('a.btn72');
      if (btn) {
        // Execute the onclick string directly
        eval(btn.getAttribute('onclick'));
      }
    });
    
    console.log('   Waiting...');
    await page.waitForTimeout(10000);
    
    console.log('\n=== Network after eval(onclick) ===');
    apiLog.forEach(entry => {
      if (entry.type === 'response') {
        console.log(`  ← ${entry.status} ${entry.url}`);
        console.log(`    Body: ${entry.body.substring(0, 300)}`);
      } else {
        console.log(`  → ${entry.method} ${entry.url}`);
        if (entry.postData) console.log(`    Data: ${entry.postData.substring(0, 300)}`);
      }
      console.log();
    });
  }

  // Check final state
  const finalUrl = await page.evaluate(() => location.href);
  console.log('\nFinal URL:', finalUrl);

  console.log('\n✅ Done. Browser open.');
  await new Promise(() => {});
}

main().catch(e => console.error('Fatal:', e));
