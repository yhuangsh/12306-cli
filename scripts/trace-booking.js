/**
 * Trace the booking/order placement flow using saved session cookies.
 * 
 * Steps to trace:
 * 1. Load saved cookies
 * 2. Go to ticket search results page
 * 3. Pick a train, click "预订" (book)
 * 4. Capture all API calls to understand the booking flow
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main() {
  // Load saved cookies
  const cookiesPath = path.join(__dirname, '..', '.session-cookies.json');
  if (!fs.existsSync(cookiesPath)) {
    console.error('❌ No saved session cookies. Run sms-login.js first.');
    process.exit(1);
  }
  const savedCookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));

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

  // Restore cookies
  await context.addCookies(savedCookies);

  // Capture all booking-related API calls
  const apiCalls = [];
  const onResponse = async res => {
    const url = res.url();
    if ((url.includes('submitOrder') || url.includes('order') || url.includes('confirm') ||
         url.includes('passenger') || url.includes('checkOrderInfo') || url.includes('getQueueCount') ||
         url.includes('confirmSingleForQueue') || url.includes('resultOrderForDcQueue') ||
         url.includes('leftTicket') || url.includes('initDc') || url.includes('book') ||
         url.includes('pay')) && !url.includes('.js') && !url.includes('.css') && !url.includes('.png')) {
      try {
        const body = await res.text();
        apiCalls.push({
          url: url.replace('https://kyfw.12306.cn', '').replace('https://www.12306.cn', ''),
          status: res.status(),
          method: res.request().method(),
          body: body.substring(0, 800)
        });
      } catch(e) {}
    }
  };
  context.on('response', onResponse);

  const page = await context.newPage();

  // Step 1: Go to ticket results page
  console.log('1️⃣  Loading ticket search page...');
  await page.goto(
    'https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=%E5%8C%97%E4%BA%AC&ts=%E4%B8%8A%E6%B5%B7&date=2026-05-14&flag=N,N,Y',
    { waitUntil: 'networkidle' }
  );
  await page.waitForTimeout(3000);

  // Step 2: Search for trains
  console.log('2️⃣  Searching trains...');
  const queryUrl = await page.evaluate(() => '/otn/' + CLeftTicketUrl);
  const result = await page.evaluate(async (url) => {
    const resp = await fetch(url + '?leftTicketDTO.train_date=2026-05-14&leftTicketDTO.from_station=BJP&leftTicketDTO.to_station=SHH&purpose_codes=ADULT', {
      credentials: 'include'
    });
    return resp.json();
  }, queryUrl);

  if (!result.data || !result.data.result || result.data.result.length === 0) {
    console.error('❌ No trains found');
    await browser.close();
    return;
  }

  // Pick the first bookable train
  const train = result.data.result.find(t => t.split('|')[1] === '预订');
  if (!train) {
    console.error('❌ No bookable trains');
    await browser.close();
    return;
  }
  const parts = train.split('|');
  const map = result.data.map;
  console.log(`3️⃣  Selected train: ${parts[3]} ${map[parts[6]]}→${map[parts[7]]} ${parts[8]}-${parts[9]}`);

  // Step 3: Click "预订" button for this train
  // The booking button triggers: /otn/leftTicket/submitOrderRequest
  // with secretStr and train_no
  const secretStr = parts[0];
  const trainNo = parts[2];
  const trainDate = parts[13]; // 20260514 format

  console.log('4️⃣  Submitting order request...');
  console.log(`   secretStr length: ${decodeURIComponent(secretStr).length}`);
  console.log(`   train_no: ${trainNo}`);

  // Clear previous API calls
  apiCalls.length = 0;

  // Submit order - this is what the page JS does when you click "预订"
  const submitResult = await page.evaluate(async ({ secret, fromCode, toCode, date }) => {
    try {
      const resp = await fetch('/otn/leftTicket/submitOrderRequest', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secretStr: secret,
          train_date: `${date.substring(0,4)}-${date.substring(4,6)}-${date.substring(6,8)}`,
          back_train_date: `${date.substring(0,4)}-${date.substring(4,6)}-${date.substring(6,8)}`,
          tour_flag: 'dc',
          purpose_codes: 'ADULT',
          query_from_station_name: fromCode,
          query_to_station_name: toCode,
          undefined: ''
        }).toString()
      });
      return { status: resp.status, body: await resp.text() };
    } catch(e) {
      return { error: e.message };
    }
  }, { secret: secretStr, fromCode: map[parts[6]], toCode: map[parts[7]], date: trainDate });

  console.log('   submitOrderRequest result:', JSON.stringify(submitResult).substring(0, 500));

  await page.waitForTimeout(2000);

  // Step 4: If successful, the next page is the passenger selection page
  console.log('\n5️⃣  Checking for passenger selection page...');
  
  // Try navigating to the order init page
  const orderPage = await context.newPage();
  orderPage.on('response', onResponse);
  
  await orderPage.goto('https://kyfw.12306.cn/otn/confirmPassenger/initDc', { waitUntil: 'networkidle' });
  await orderPage.waitForTimeout(3000);

  // Check what's on this page
  const orderPageState = await orderPage.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input')).filter(el => el.offsetWidth > 0);
    const passengerList = document.querySelector('#normal_passenger_id, [id*=passenger]');
    const submitBtn = document.querySelector('#submitOrder_id, [id*=submitOrder], [id*=confirm]');
    
    return {
      title: document.title,
      url: location.href,
      bodyText: document.body.innerText.substring(0, 800),
      visibleInputs: inputs.map(i => ({ id: i.id, type: i.type, placeholder: i.placeholder, value: i.value })),
      hasPassengerList: !!passengerList,
      hasSubmitBtn: !!submitBtn,
      submitBtnText: submitBtn ? submitBtn.textContent.trim() : ''
    };
  });
  console.log('   Order page state:', JSON.stringify(orderPageState, null, 2));

  // Get passenger info
  const passengers = await orderPage.evaluate(async () => {
    try {
      const resp = await fetch('/otn/confirmPassenger/getPassengerDTOs', {
        method: 'POST', credentials: 'include'
      });
      return resp.json();
    } catch(e) {
      return { error: e.message };
    }
  });
  console.log('\n6️⃣  Passenger info:');
  console.log(JSON.stringify(passengers, null, 2).substring(0, 2000));

  // Print all captured API calls
  console.log('\n=== All booking API calls captured ===');
  apiCalls.forEach(c => {
    console.log(`\n${c.method} ${c.status} ${c.url}`);
    try {
      const json = JSON.parse(c.body);
      console.log(JSON.stringify(json).substring(0, 500));
    } catch(e) {
      console.log(c.body.substring(0, 300));
    }
  });

  await browser.close();
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
