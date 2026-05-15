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

  const queryUrl = await page.evaluate(() => '/otn/' + CLeftTicketUrl);
  const result = await page.evaluate(async (url) => {
    const resp = await fetch(url + '?leftTicketDTO.train_date=2026-05-14&leftTicketDTO.from_station=BJP&leftTicketDTO.to_station=SHH&purpose_codes=ADULT', { credentials: 'include' });
    return resp.json();
  }, queryUrl);

  // Parse one train in detail to understand the seat data format
  const firstTrain = result.data.result[0];
  const parts = firstTrain.split('|');
  console.log('=== Raw train data parts ===');
  parts.forEach((p, i) => {
    if (p) console.log(`  [${i}]: ${decodeURIComponent(p).substring(0, 80)}`);
  });

  // Parse 3 trains with seat info
  console.log('\n=== Seat availability ===');
  result.data.result.slice(0, 5).forEach(t => {
    const p = t.split('|');
    const code = p[3];
    const from = result.data.map[p[6]] || p[6];
    const to = result.data.map[p[7]] || p[7];
    const dep = p[8];
    const arr = p[9];
    const dur = p[10];
    
    // Seat availability positions (may vary)
    // Common positions: 商务座/特等座, 一等座, 二等座, 高级软卧, 软卧, 动卧, 硬卧, 软座, 硬座, 无座
    const seats = {
      '商务座': p[32] || '',
      '特等座': p[33] || '',
      '一等座': p[31] || '',
      '二等座': p[30] || '',
      '高级软卧': p[21] || '',
      '软卧': p[23] || '',
      '动卧': p[33] || '',
      '硬卧': p[28] || '',
      '软座': p[24] || '',
      '硬座': p[29] || '',
      '无座': p[26] || '',
    };
    
    const availableSeats = Object.entries(seats).filter(([k, v]) => v && v !== '--' && v !== '' && v !== '*').map(([k, v]) => `${k}:${v}`);
    
    console.log(`\n${code} ${from}→${to} ${dep}-${arr} (${dur})`);
    console.log('  Seats:', availableSeats.join(', ') || 'need to check positions');
    console.log('  All non-empty parts:', p.map((v, i) => v ? `[${i}]=${v}` : '').filter(Boolean).join(', '));
  });

  await browser.close();
})().catch(e => console.error(e.message));
