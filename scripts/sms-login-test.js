/**
 * 12306 SMS Login + Ticket Search Test
 * 
 * Login flow:
 * 1. Visit login page → get session cookies
 * 2. POST /passport/web/checkLoginVerify → get verification type
 * 3. If SMS required (login_check_code=3):
 *    a. POST /passport/web/getMessageCode → send SMS to user's phone
 *    b. User provides SMS code interactively
 *    c. POST /passport/web/login → authenticate
 * 4. POST /passport/web/auth/uamtk → get auth token
 * 5. POST /otn/login/uamauthclient → plant auth cookie
 */

const { chromium } = require('playwright');
const readline = require('readline');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Anti-detection setup
const ANTI_DETECT = () => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
};

async function createBrowser() {
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: false, // Need headed mode for SMS flow interaction
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });
  await context.addInitScript(ANTI_DETECT);
  return { browser, context };
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

async function smsLogin(context) {
  const page = await context.newPage();

  // Step 1: Visit login page
  console.log('📋 Visiting login page...');
  await page.goto('https://kyfw.12306.cn/otn/resources/login.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Step 2: Fill credentials
  const username = process.env.TRAIN_USERNAME;
  const password = process.env.TRAIN_PASSWORD;

  if (!username || !password) {
    throw new Error('TRAIN_USERNAME and TRAIN_PASSWORD environment variables required');
  }

  console.log('📋 Filling credentials...');
  await page.fill('#J-userName', username);
  await page.fill('#J-password', password);

  // Step 3: Click login
  console.log('📋 Clicking login...');
  const checkResult = await page.evaluate(async () => {
    const resp = await fetch('/passport/web/checkLoginVerify', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=${encodeURIComponent(document.getElementById('J-userName').value)}`
    });
    return resp.json();
  });
  console.log('📋 checkLoginVerify:', JSON.stringify(checkResult));

  // Click login button to trigger the modal
  await page.click('#J-login');
  await page.waitForTimeout(3000);

  const loginCheckCode = checkResult.login_check_code || checkResult.data?.login_check_code;

  if (loginCheckCode === '0') {
    console.log('✅ No verification needed, attempting direct login...');
    // Try direct login via API
    const loginResult = await page.evaluate(async (user, pass) => {
      const resp = await fetch('https://kyfw.12306.cn/passport/web/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&appid=otn`
      });
      return resp.json();
    }, username, '@' + await page.evaluate(() => encrypt_ecb(password, SM4_key)));
    console.log('Login result:', JSON.stringify(loginResult));
  }

  if (loginCheckCode === '3' || loginCheckCode === '1') {
    // Switch to SMS tab
    console.log('📋 Switching to SMS verification tab...');
    await page.click('#verification li:nth-child(2)');
    await page.waitForTimeout(1000);

    // Ask for last 4 digits of ID card
    const idLast4 = await ask('🔑 Enter last 4 digits of your ID card: ');

    // Fill ID card
    await page.fill('#id_card', idLast4.trim());
    await page.waitForTimeout(500);

    // Click get verification code
    console.log('📱 Sending SMS verification code...');
    const smsResult = await page.evaluate(async (user, card) => {
      const resp = await fetch('https://kyfw.12306.cn/passport/web/getMessageCode', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `appid=otn&username=${encodeURIComponent(user)}&castNum=${encodeURIComponent(card)}`
      });
      return resp.json();
    }, username, idLast4.trim());
    console.log('📱 SMS result:', JSON.stringify(smsResult));

    if (smsResult.result_code !== '0' && smsResult.result_code !== 0) {
      console.error('❌ SMS sending failed:', smsResult.result_message);
      return false;
    }

    // Wait for SMS code from user
    const smsCode = await ask('📱 Enter the 6-digit SMS code you received: ');

    // Fill SMS code
    await page.fill('#code', smsCode.trim());

    // Click confirm
    console.log('📋 Submitting SMS verification...');
    
    // The sureClick button triggers login with SMS code
    const loginResult = await page.evaluate(async (user, encPass, code) => {
      const resp = await fetch('https://kyfw.12306.cn/passport/web/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          sessionId: '',
          sig: '',
          if_check_slide_passcode_token: '',
          scene: '',
          checkMode: '0',
          randCode: code,
          username: user,
          password: encPass,
          appid: 'otn'
        }).toString()
      });
      return resp.json();
    }, username, '@' + await page.evaluate(pwd => encrypt_ecb(pwd, SM4_key), password), smsCode.trim());

    console.log('📋 Login result:', JSON.stringify(loginResult));

    if (loginResult.result_code !== 0 && loginResult.result_code !== '0') {
      console.error('❌ Login failed:', loginResult.result_message);
      return false;
    }
  }

  // Step 4: Get auth token (uamtk)
  console.log('📋 Getting auth token...');
  const uamtkResult = await page.evaluate(async () => {
    const resp = await fetch('https://kyfw.12306.cn/passport/web/auth/uamtk', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'appid=otn'
    });
    return resp.json();
  });
  console.log('📋 uamtk result:', JSON.stringify(uamtkResult));

  if (uamtkResult.result_code !== 0 && uamtkResult.result_code !== '0') {
    console.error('❌ uamtk failed:', uamtkResult.result_message);
    return false;
  }

  const apptk = uamtkResult.newapptk || uamtkResult.apptk;

  // Step 5: Plant auth cookie
  console.log('📋 Planting auth cookie...');
  const authResult = await page.evaluate(async (tk) => {
    const resp = await fetch('/otn/login/uamauthclient', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `tk=${encodeURIComponent(tk)}`
    });
    return resp.json();
  }, apptk);
  console.log('📋 Auth result:', JSON.stringify(authResult));

  if (authResult.result_code === 0 || authResult.result_code === '0') {
    console.log('✅ Login successful!');
    return true;
  } else {
    console.error('❌ Auth failed:', authResult.result_message);
    return false;
  }
}

async function searchTrains(context, from, to, date) {
  const page = await context.newPage();
  
  await page.goto(
    `https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=&ts=&date=${date}&flag=N,N,Y`,
    { waitUntil: 'networkidle' }
  );
  await page.waitForTimeout(2000);

  const queryUrl = await page.evaluate(() => '/otn/' + CLeftTicketUrl);

  // We need station codes - get them from the page's station_name.js
  const fromCode = await page.evaluate((name) => {
    const matches = station_names.match(new RegExp(`@[^|]*\\|${name}\\|([A-Z]+)`));
    return matches ? matches[1] : null;
  }, from);

  const toCode = await page.evaluate((name) => {
    const matches = station_names.match(new RegExp(`@[^|]*\\|${name}\\|([A-Z]+)`));
    return matches ? matches[1] : null;
  }, to);

  if (!fromCode || !toCode) {
    console.error(`❌ Station not found: ${from}→${fromCode}, ${to}→${toCode}`);
    return null;
  }

  console.log(`🔍 Searching ${from}(${fromCode}) → ${to}(${toCode}) on ${date}...`);

  const result = await page.evaluate(async (url, fc, tc, d) => {
    const resp = await fetch(`${url}?leftTicketDTO.train_date=${d}&leftTicketDTO.from_station=${fc}&leftTicketDTO.to_station=${tc}&purpose_codes=ADULT`, {
      credentials: 'include'
    });
    return resp.json();
  }, queryUrl, fromCode, toCode, date);

  if (result.data && result.data.result) {
    const map = result.data.map;
    const trains = result.data.result.map(t => {
      const p = t.split('|');
      return {
        code: p[3],
        from: map[p[6]] || p[6],
        to: map[p[7]] || p[7],
        depart: p[8],
        arrive: p[9],
        duration: p[10],
        buttonText: p[1],
        canBook: p[11] === 'Y',
        noSeat: p[26],
        secondClass: p[30],
        firstClass: p[31],
        businessClass: p[32],
        secretStr: decodeURIComponent(p[0]),
        trainNo: p[2],
        ypInfo: p[12],
      };
    });

    console.log(`\n🚄 Found ${trains.length} trains:\n`);
    trains.forEach(t => {
      const seats = [];
      if (t.businessClass && t.businessClass !== '无') seats.push(`商务:${t.businessClass}`);
      if (t.firstClass && t.firstClass !== '无') seats.push(`一等:${t.firstClass}`);
      if (t.secondClass && t.secondClass !== '无') seats.push(`二等:${t.secondClass}`);
      
      console.log(`  ${t.code.padEnd(6)} ${t.from}→${t.to} ${t.depart}-${t.arrive} (${t.duration}) [${t.buttonText}] ${seats.join(' ')}`);
    });

    return trains;
  }

  console.log('❌ No results:', JSON.stringify(result).substring(0, 300));
  return null;
}

// Main
(async () => {
  const { browser, context } = await createBrowser();

  try {
    // Login
    const loggedIn = await smsLogin(context);
    
    if (loggedIn) {
      // Search trains
      await searchTrains(context, '北京', '上海', '2026-05-14');
    } else {
      console.log('⚠️  Login failed, cannot search authenticated content');
    }

    console.log('\n✅ Done. Browser kept open for inspection.');
    await ask('Press Enter to close browser...');
  } finally {
    await browser.close();
  }
})().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
