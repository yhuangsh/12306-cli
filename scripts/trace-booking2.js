/**
 * Trace booking flow v2: Use the page's own JS to submit the order
 * instead of calling APIs directly.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main() {
  const cookiesPath = path.join(__dirname, '..', '.session-cookies.json');
  const savedCookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));

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
  await context.addCookies(savedCookies);

  // Capture all API calls
  const apiCalls = [];
  context.on('response', async res => {
    const url = res.url();
    if (url.includes('kyfw.12306.cn/otn') && !url.includes('.js') && !url.includes('.css') &&
        !url.includes('.png') && !url.includes('.jpg') && !url.includes('.gif') && !url.includes('.ico') &&
        !url.includes('toolbar') && !url.includes('route') && !url.includes('dynamicJs')) {
      try {
        const body = await res.text();
        if (body.length < 5000) {
          apiCalls.push({
            url: url.replace('https://kyfw.12306.cn', ''),
            status: res.status(),
            method: res.request().method(),
            body: body.substring(0, 1000)
          });
        } else {
          apiCalls.push({
            url: url.replace('https://kyfw.12306.cn', ''),
            status: res.status(),
            method: res.request().method(),
            body: `[HTML page, ${body.length} chars]`
          });
        }
      } catch(e) {}
    }
  });

  const page = await context.newPage();

  // Go directly to ticket results page
  console.log('1️⃣  Loading ticket results page...');
  await page.goto(
    'https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=%E5%8C%97%E4%BA%AC&ts=%E4%B8%8A%E6%B5%B7&date=2026-05-14&flag=N,N,Y',
    { waitUntil: 'networkidle' }
  );
  await page.waitForTimeout(3000);

  // First, get the token
  const token = await page.evaluate(() => globalRepeatSubmitToken);
  console.log('   Repeat submit token:', token);

  // Use page fetch for ticket query
  const queryUrl = await page.evaluate(() => '/otn/' + CLeftTicketUrl);
  const result = await page.evaluate(async (url) => {
    const resp = await fetch(url + '?leftTicketDTO.train_date=2026-05-14&leftTicketDTO.from_station=BJP&leftTicketDTO.to_station=SHH&purpose_codes=ADULT', {
      credentials: 'include'
    });
    return resp.json();
  }, queryUrl);

  if (!result.data?.result?.length) {
    console.error('❌ No trains');
    await browser.close();
    return;
  }

  const map = result.data.map;
  const train = result.data.result.find(t => t.split('|')[1] === '预订');
  if (!train) { console.error('❌ No bookable train'); await browser.close(); return; }
  const p = train.split('|');
  console.log(`2️⃣  Selected: ${p[3]} ${map[p[6]]}→${map[p[7]]} ${p[8]}-${p[9]}`);

  // Let the page JS handle the booking click
  // The page has click handlers on the "预订" buttons
  apiCalls.length = 0;

  console.log('3️⃣  Clicking 预订 via page JS...');

  // The page's todo_submitOrder function needs secretStr and start_time
  // Or we can use the page's built-in click handler
  const clickResult = await page.evaluate((secretStr) => {
    // Find the book button for this train and click it
    // The train row has id like "ticket_240000G54700"
    const trainId = 'ticket_' + document.querySelector('[id^="ticket_"]')?.id?.replace('ticket_', '');
    
    // Alternative: directly call the page's internal function
    // todo_submitOrder(secretStr, startTime) is what the page uses
    if (typeof todo_submitOrder === 'function') {
      return { found: 'todo_submitOrder' };
    }
    if (typeof submitOrderRequest === 'function') {
      return { found: 'submitOrderRequest' };
    }
    
    // Check what functions exist
    const fns = Object.keys(window).filter(k => typeof window[k] === 'function' && k.toLowerCase().includes('order'));
    return { functions: fns, trainId };
  }, p[0]);
  console.log('   Click result:', JSON.stringify(clickResult));

  // Try clicking the actual 预订 link in the train row
  // Each train row has a "预订" link that triggers the order
  const bookBtnClicked = await page.evaluate(() => {
    // Find all book buttons
    const btns = document.querySelectorAll('a[id^="yd_"], [id*="book"], .btn72s, [class*="btn72"]');
    if (btns.length > 0) {
      btns[0].click();
      return { clicked: true, count: btns.length, firstBtnId: btns[0].id, firstBtnText: btns[0].textContent.trim() };
    }
    
    // Try finding by text
    const allLinks = document.querySelectorAll('a');
    for (const a of allLinks) {
      if (a.textContent.trim() === '预订' && a.offsetWidth > 0) {
        a.click();
        return { clicked: true, byText: true };
      }
    }
    return { clicked: false };
  });
  console.log('   Book button:', JSON.stringify(bookBtnClicked));

  await page.waitForTimeout(5000);

  // Check if we navigated to passenger page
  console.log('\n4️⃣  Current URL:', page.url());

  // Check page content
  const pageState = await page.evaluate(() => {
    return {
      title: document.title,
      bodyText: document.body.innerText.substring(0, 500),
      hasPassengerForm: !!document.querySelector('#normal_passenger_id, [id*=passenger]'),
    };
  });
  console.log('   Page state:', JSON.stringify(pageState, null, 2));

  // Print API calls
  console.log('\n=== API calls after clicking 预订 ===');
  apiCalls.forEach(c => {
    console.log(`\n${c.method} ${c.status} ${c.url}`);
    console.log(c.body.substring(0, 400));
  });

  // Get passenger data regardless
  const passengers = await page.evaluate(async () => {
    try {
      const resp = await fetch('/otn/confirmPassenger/getPassengerDTOs', {
        method: 'POST', credentials: 'include'
      });
      return resp.json();
    } catch(e) {
      return { error: e.message };
    }
  });
  
  if (passengers.data?.normal_passengers) {
    console.log('\n5️⃣  Passengers on account:');
    passengers.data.normal_passengers.forEach(p => {
      console.log(`   ${p.passenger_name} (${p.passenger_type_name}, ${p.passenger_id_type_name}: ${p.passenger_id_no})`);
    });
  }

  // Get the order init page tokens
  const orderTokens = await page.evaluate(async () => {
    try {
      // Check if we're on the confirm passenger page
      if (!location.href.includes('confirmPassenger')) {
        // Navigate there
        const resp = await fetch('/otn/confirmPassenger/initDc', { credentials: 'include' });
        return { navigated: true, status: resp.status };
      }
      return {
        globalRepeatSubmitToken: typeof globalRepeatSubmitToken !== 'undefined' ? globalRepeatSubmitToken : null,
        ticketInfoForPassengerForm: typeof ticketInfoForPassengerForm !== 'undefined' ? ticketInfoForPassengerForm : null,
        orderRequestDTO: typeof orderRequestDTO !== 'undefined' ? orderRequestDTO : null,
      };
    } catch(e) {
      return { error: e.message };
    }
  });
  console.log('\n6️⃣  Order tokens:', JSON.stringify(orderTokens, null, 2));

  console.log('\n✅ Tracing complete. Browser open for inspection.');
  await new Promise(() => {}); // Keep browser open - user must Ctrl+C
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
