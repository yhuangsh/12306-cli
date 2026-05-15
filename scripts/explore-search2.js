const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });
  
  // Remove webdriver detection
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    delete navigator.__proto__.webdriver;
  });

  const page = await context.newPage();

  let ticketData = null;
  const allResponses = [];
  page.on('response', async res => {
    const url = res.url();
    try {
      if (url.includes('leftTicket/query') || url.includes('leftTicket/result')) {
        const json = await res.json();
        ticketData = json;
        console.log('GOT TICKET DATA:', url);
      }
      if (url.includes('query') || url.includes('leftTicket') || url.includes('log')) {
        const ct = res.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const text = await res.text();
          allResponses.push({ url: url.replace('https://kyfw.12306.cn', ''), status: res.status(), body: text.substring(0, 200) });
        }
      }
    } catch(e) {}
  });

  const consoleMsgs = [];
  page.on('console', msg => consoleMsgs.push(msg.type() + ': ' + msg.text()));

  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));

  await page.goto(
    'https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=%E5%8C%97%E4%BA%AC&ts=%E4%B8%8A%E6%B5%B7&date=2026-05-14&flag=N,N,Y',
    { waitUntil: 'networkidle' }
  );

  // Wait for lazy scripts to load
  await page.waitForTimeout(3000);

  // Check if query button has click handler
  const btnInfo = await page.evaluate(() => {
    const btn = document.querySelector('#query_ticket');
    if (!btn) return 'NO BUTTON';
    // Check onclick
    return {
      text: btn.textContent.trim(),
      onclick: btn.getAttribute('onclick'),
      href: btn.getAttribute('href'),
      listeners: typeof getEventListeners === 'function' ? getEventListeners(btn) : 'N/A (not in devtools)',
      parentHTML: btn.parentElement.outerHTML.substring(0, 300)
    };
  });
  console.log('Query button:', JSON.stringify(btnInfo, null, 2));

  // Try to call the query function directly if it exists
  const queryResult = await page.evaluate(() => {
    // Try common function names
    const fns = ['query', 'queryTicket', 'search', 'doQuery', 'click_query'];
    for (const fn of fns) {
      if (typeof window[fn] === 'function') {
        return 'Found function: ' + fn;
      }
    }
    // Check jQuery handlers
    if (typeof $ === 'function' || typeof jQuery === 'function') {
      const jq = $ || jQuery;
      const events = jq._data ? jq._data(document.querySelector('#query_ticket'), 'events') : null;
      if (events) return 'jQuery events: ' + Object.keys(events).join(', ');
    }
    return 'No query function found';
  });
  console.log('Query function check:', queryResult);

  // Try clicking with force
  await page.click('#query_ticket', { force: true });
  await page.waitForTimeout(3000);

  console.log('\n=== All JSON responses ===');
  allResponses.forEach(r => console.log(r.status, r.url, '→', r.body));

  console.log('\n=== Console messages ===');
  consoleMsgs.slice(-10).forEach(m => console.log(m));

  if (pageErrors.length > 0) {
    console.log('\n=== Page errors ===');
    pageErrors.forEach(e => console.log(e));
  }

  if (ticketData && ticketData.data && ticketData.data.result) {
    console.log('\n=== SUCCESS: Trains found:', ticketData.data.result.length);
  }

  await browser.close();
})().catch(e => console.error(e.message));
