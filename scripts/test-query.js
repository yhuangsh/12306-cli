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
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  await page.goto(
    'https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=%E5%8C%97%E4%BA%AC&ts=%E4%B8%8A%E6%B5%B7&date=2026-05-14&flag=N,N,Y',
    { waitUntil: 'networkidle' }
  );
  await page.waitForTimeout(2000);

  // Get the query URL pattern
  const queryUrl = await page.evaluate(() => '/otn/' + CLeftTicketUrl);

  // Query tickets using page context (has cookies)
  const result = await page.evaluate(async (url) => {
    try {
      const resp = await fetch(url + '?leftTicketDTO.train_date=2026-05-14&leftTicketDTO.from_station=BJP&leftTicketDTO.to_station=SHH&purpose_codes=ADULT', {
        credentials: 'include'
      });
      return await resp.json();
    } catch (e) {
      return { error: e.message };
    }
  }, queryUrl);

  if (result.data && result.data.result) {
    console.log('=== Train Search: 北京→上海 2026-05-14 ===');
    console.log('Total trains:', result.data.result.length);
    console.log('\nStation map:', JSON.stringify(result.data.map));

    // Parse train data
    // Format: secretStr|按钮信息|train_no|station_train_code|from_station|to_station|from_station_name|to_station_name|...
    const trains = result.data.result.map(t => {
      const parts = t.split('|');
      return {
        secretStr: parts[0],
        buttonText: parts[1],     // 预订/候补/...
        trainNo: parts[2],        // internal train number
        code: parts[3],           // display code (G547, etc.)
        fromStation: parts[4],    // from station code
        toStation: parts[5],      // to station code
        fromStationName: result.data.map[parts[6]] || parts[6],
        toStationName: result.data.map[parts[7]] || parts[7],
        departTime: parts[8],
        arriveTime: parts[9],
        duration: parts[10],
        canBook: parts[11],       // Y/N
        // Seat prices/availability follow (varies by train type)
        // ypInfo: parts[12],     // seat info encoded
        // From parts[20+] there's more seat data
        raw: t.substring(0, 200)
      };
    });

    console.log('\n=== Trains ===');
    trains.forEach(t => {
      console.log(`${t.code} ${t.fromStationName || t.fromStation} → ${t.toStationName || t.toStation} ` +
        `${t.departTime}-${t.arriveTime} (${t.duration}) [${t.buttonText}]`);
    });
  } else {
    console.log('Unexpected response:', JSON.stringify(result).substring(0, 500));
  }

  await browser.close();
})().catch(e => console.error(e.message));
