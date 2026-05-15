/**
 * Trace the REAL booking flow by watching the page's own behavior.
 * Strategy: render trains via page's own JS, then capture what happens
 * when we click the actual "预订" button.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main() {
  const cookiesPath = path.join(__dirname, '..', '.session-cookies.json');
  const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));

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

  // Capture ALL network activity
  const allRequests = [];
  const allResponses = [];

  page.on('request', req => {
    if (req.url().includes('kyfw.12306.cn/otn') && !req.url().match(/\.(js|css|png|jpg|gif|ico)/)) {
      allRequests.push({
        method: req.method(),
        url: req.url().replace('https://kyfw.12306.cn', ''),
        postData: req.postData()?.substring(0, 500) || ''
      });
    }
  });

  page.on('response', async res => {
    const url = res.url();
    if (url.includes('kyfw.12306.cn/otn') && !url.match(/\.(js|css|png|jpg|gif|ico)/)) {
      try {
        const body = await res.text();
        allResponses.push({
          status: res.status(),
          url: url.replace('https://kyfw.12306.cn', ''),
          body: body.substring(0, 500)
        });
      } catch(e) {}
    }
  });

  console.log('1️⃣  Loading ticket search page...');
  await page.goto(
    'https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=%E5%8C%97%E4%BA%AC&ts=%E4%B8%8A%E6%B5%B7&date=2026-05-14&flag=N,N,Y',
    { waitUntil: 'networkidle' }
  );
  await page.waitForTimeout(3000);

  // First, let's see if trains are already rendered in the DOM
  let trainCount = await page.evaluate(() => document.querySelectorAll('tr[id^="ticket_"]').length);
  console.log(`   Trains in DOM already: ${trainCount}`);

  // If no trains rendered, we need to trigger the page's own query
  if (trainCount === 0) {
    console.log('   No trains in DOM. Triggering page query...');
    
    // Set the form values properly
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

    // Clear logs and click query
    allRequests.length = 0;
    allResponses.length = 0;

    await page.click('#query_ticket');
    console.log('   Waiting for page to render trains...');
    await page.waitForTimeout(8000);

    trainCount = await page.evaluate(() => document.querySelectorAll('tr[id^="ticket_"]').length);
    console.log(`   Trains in DOM now: ${trainCount}`);
  }

  // Find the first bookable train's "预订" button
  const bookButtons = await page.evaluate(() => {
    const rows = document.querySelectorAll('tr[id^="ticket_"]');
    const buttons = [];
    rows.forEach(row => {
      // Find all anchor tags in the row
      const links = row.querySelectorAll('a');
      links.forEach(link => {
        const text = link.textContent.trim();
        if (text === '预订' || text === '添加乘客') {
          // Get the onclick attribute or parent's onclick
          const onclick = link.getAttribute('onclick') || '';
          const href = link.getAttribute('href') || '';
          const id = link.id || '';
          const className = link.className || '';
          
          // Get the train code from the row
          const trainCode = row.querySelector('.number, .train a, [class*=number]')?.textContent?.trim() || row.id;
          
          buttons.push({
            id, text, onclick, href, className, trainCode,
            parentId: link.parentElement?.id || ''
          });
        }
      });
    });
    return buttons;
  });

  console.log(`\n2️⃣  Found ${bookButtons.length} book buttons:`);
  bookButtons.slice(0, 5).forEach(b => {
    console.log(`   ${b.trainCode}: id=${b.id || 'none'}, text="${b.text}", onclick="${b.onclick.substring(0, 80)}", class="${b.className}"`);
  });

  // Pick the first bookable button
  const bookBtn = bookButtons.find(b => b.text === '预订') || bookButtons[0];
  if (!bookBtn) {
    console.log('❌ No book button found');
    await browser.close();
    return;
  }

  console.log(`\n3️⃣  Clicking "预订" for ${bookBtn.trainCode}...`);

  // Clear logs before click
  allRequests.length = 0;
  allResponses.length = 0;

  // Click the button
  if (bookBtn.id) {
    await page.click(`#${bookBtn.id}`);
  } else {
    // Find by text in the correct row
    await page.evaluate((trainId) => {
      const row = document.getElementById(trainId);
      if (row) {
        const link = row.querySelector('a');
        if (link) link.click();
      }
    }, bookBtn.trainCode.includes('_') ? bookBtn.trainCode : `ticket_${bookBtn.trainCode}`);
  }

  console.log('   Waiting for response...');
  await page.waitForTimeout(5000);

  // Print ALL network activity
  console.log('\n=== REQUESTS after clicking 预订 ===');
  allRequests.forEach(r => {
    console.log(`${r.method} ${r.url}`);
    if (r.postData) console.log(`  POST data: ${r.postData}`);
    console.log();
  });

  console.log('\n=== RESPONSES after clicking 预订 ===');
  allResponses.forEach(r => {
    console.log(`${r.status} ${r.url}`);
    console.log(`  Body: ${r.body.substring(0, 300)}`);
    console.log();
  });

  // Check current page state
  const currentState = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    bodyText: document.body.innerText.substring(0, 300)
  }));
  console.log('\n=== Current page ===');
  console.log('URL:', currentState.url);
  console.log('Title:', currentState.title);
  console.log('Text:', currentState.bodyText);

  // Keep browser open
  console.log('\n✅ Trace complete. Browser open for inspection.');
  await new Promise(() => {});
}

main().catch(e => console.error('Fatal:', e));
