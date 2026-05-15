const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  let ticketData = null;
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('leftTicket/query')) {
      try {
        ticketData = await res.json();
        console.log('GOT DATA from:', url);
      } catch (e) {}
    }
  });

  // Navigate to the results page
  await page.goto(
    'https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=%E5%8C%97%E4%BA%AC&ts=%E4%B8%8A%E6%B5%B7&date=2026-05-14&flag=N,N,Y',
    { waitUntil: 'domcontentloaded' }
  );
  await page.waitForTimeout(3000);

  // Check form state
  const formState = await page.evaluate(() => {
    const fi = document.querySelector('#fromStationText');
    const ti = document.querySelector('#toStationText');
    const di = document.querySelector('#train_date');
    const qb = document.querySelector('#query_ticket');
    return {
      from: fi ? fi.value : 'NOT FOUND',
      to: ti ? ti.value : 'NOT FOUND',
      date: di ? di.value : 'NOT FOUND',
      queryBtn: qb ? qb.textContent.trim() : 'NOT FOUND'
    };
  });
  console.log('Form:', JSON.stringify(formState));

  // Click query button
  const qb = await page.$('#query_ticket');
  if (qb) {
    console.log('Clicking query...');
    await qb.click();
    await page.waitForTimeout(5000);
  }

  // Cookies
  const cookies = await context.cookies();
  console.log('\nCookies:', cookies.map(c => c.name + '=' + c.value.substring(0, 20) + '...').join('\n'));

  if (ticketData && ticketData.data && ticketData.data.result) {
    console.log('\n=== TICKET DATA ===');
    console.log('Trains:', ticketData.data.result.length);
    ticketData.data.result.slice(0, 3).forEach((t, i) => {
      console.log('\nTrain', i + 1, ':', t.substring(0, 300));
    });
    if (ticketData.data.map) {
      console.log('\nStation map:', JSON.stringify(ticketData.data.map));
    }
  } else {
    console.log('\nNo ticket data. Checking XHR...');
    // Check if any leftTicket endpoint was called
    const pageContent = await page.evaluate(() => document.body.innerText.substring(0, 500));
    console.log('Page:', pageContent);
  }

  await browser.close();
})().catch(e => console.error(e.message));
