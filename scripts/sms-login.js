/**
 * 12306 SMS Login + Ticket Search
 * 
 * Flow:
 * 1. Visit login page → get session cookies
 * 2. Fill username + password, click login
 * 3. POST /passport/web/checkLoginVerify → get verification type
 * 4. If SMS required → switch to SMS tab, enter ID card last 4 digits
 * 5. POST /passport/web/getMessageCode → send SMS
 * 6. User provides SMS code
 * 7. POST /passport/web/login → authenticate (username + SM4(password) + SMS code)
 * 8. POST /passport/web/auth/uamtk → get auth token
 * 9. POST /otn/login/uamauthclient → plant auth cookie
 * 10. Ready to search/booking
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Load .env
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  const content = fs.readFileSync(envPath, 'utf-8');
  const vars = {};
  for (const line of content.split('\n')) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

async function main() {
  const env = loadEnv();
  if (!env.TRAIN_USERNAME || !env.TRAIN_PASSWORD) {
    console.error('❌ Set TRAIN_USERNAME and TRAIN_PASSWORD in .env');
    process.exit(1);
  }

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

  try {
    const page = await context.newPage();

    // ── Step 1: Visit login page ──
    console.log('1️⃣  Loading login page...');
    await page.goto('https://kyfw.12306.cn/otn/resources/login.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // ── Step 2: Fill credentials ──
    console.log('2️⃣  Filling credentials...');
    await page.fill('#J-userName', env.TRAIN_USERNAME);
    await page.fill('#J-password', env.TRAIN_PASSWORD);

    // ── Step 3: Click login ──
    console.log('3️⃣  Clicking login...');
    await page.click('#J-login');
    await page.waitForTimeout(3000);

    // ── Step 4: Handle verification modal ──
    // The modal should have appeared. Check which tabs are visible.
    const modalState = await page.evaluate(() => {
      const tabs = document.querySelectorAll('#verification li');
      return Array.from(tabs).map(t => ({
        text: t.textContent.trim(),
        type: t.getAttribute('type'),
        active: t.classList.contains('active'),
        visible: t.offsetWidth > 0
      }));
    });
    console.log('4️⃣  Verification modal tabs:', JSON.stringify(modalState));

    // Find and click the SMS tab
    const smsTab = modalState.find(t => t.text.includes('短信') && t.visible);
    if (smsTab) {
      console.log('   Switching to SMS tab...');
      await page.click(`#verification li[type="${smsTab.type}"]`);
      await page.waitForTimeout(1000);
    } else {
      console.log('   ⚠️  No SMS tab visible. Checking slide-only mode...');
    }

    // ── Step 5: Enter ID card last 4 digits + send SMS ──
    const idLast4 = await ask('🔑 Enter last 4 digits of your ID card (证件号后4位): ');

    await page.fill('#id_card', idLast4);
    await page.waitForTimeout(500);

    // Enable the button if needed
    await page.evaluate(() => {
      const btn = document.querySelector('#verification_code');
      if (btn) btn.classList.remove('btn-disabled');
    });

    console.log('5️⃣  Sending SMS...');
    await page.click('#verification_code');
    await page.waitForTimeout(3000);

    // Check if SMS was sent
    const smsStatus = await page.evaluate(() => {
      const msg = document.querySelector('#message');
      return msg ? msg.textContent.trim() : 'No message shown';
    });
    console.log('   SMS status:', smsStatus);

    // ── Step 6: Enter SMS code ──
    const smsCode = await ask('📱 Enter the 6-digit SMS code: ');
    await page.fill('#code', smsCode);

    // ── Step 7: Submit SMS + login ──
    console.log('6️⃣  Submitting SMS verification + login...');
    
    // The sureClick handler in the page JS builds the form data and calls popup_loginForUam
    // Instead of reimplementing, let's just click the button and let the page JS handle it
    await page.click('#sureClick');
    await page.waitForTimeout(5000);

    // Check login result by looking at page state
    const loginCheck = await page.evaluate(() => {
      const errorEl = document.querySelector('#J-login-error, #message');
      const modal = document.querySelector('#modal');
      const loginError = document.querySelector('.login-error');
      return {
        modalVisible: modal ? getComputedStyle(modal).display : 'N/A',
        errorText: errorEl ? errorEl.textContent.trim() : '',
        loginError: loginError ? loginError.textContent.trim() : '',
        currentUrl: location.href
      };
    });
    console.log('   Login check:', JSON.stringify(loginCheck));

    // ── Step 8: Auth token exchange ──
    // If login succeeded, the page JS should have called uamtk automatically
    // But let's also handle it manually in case
    console.log('7️⃣  Checking authentication...');
    
    // Wait for any redirects or cookie setting
    await page.waitForTimeout(2000);

    // Verify we're logged in by checking the user info
    const authStatus = await page.evaluate(async () => {
      try {
        const resp = await fetch('/otn/login/conf', {
          method: 'POST', credentials: 'include'
        });
        const json = await resp.json();
        return { is_login: json.data?.is_login, url: location.href };
      } catch(e) {
        return { error: e.message };
      }
    });
    console.log('   Auth status:', JSON.stringify(authStatus));

    if (authStatus.is_login === 'Y') {
      console.log('✅ Login successful!');
    } else {
      console.log('⚠️  Login may not be complete. Continuing anyway...');
    }

    // ── Step 9: Save cookies for reuse ──
    const cookies = await context.cookies();
    const cookiesPath = path.join(__dirname, '..', '.session-cookies.json');
    fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
    console.log('💾 Session cookies saved to .session-cookies.json');

    // ── Step 10: Test ticket search ──
    console.log('\n8️⃣  Testing ticket search: 北京→上海 2026-05-14...');
    const searchPage = await context.newPage();
    await searchPage.goto(
      'https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=%E5%8C%97%E4%BA%AC&ts=%E4%B8%8A%E6%B5%B7&date=2026-05-14&flag=N,N,Y',
      { waitUntil: 'networkidle' }
    );
    await searchPage.waitForTimeout(2000);

    const queryUrl = await searchPage.evaluate(() => '/otn/' + CLeftTicketUrl);
    const result = await searchPage.evaluate(async (url) => {
      const resp = await fetch(url + '?leftTicketDTO.train_date=2026-05-14&leftTicketDTO.from_station=BJP&leftTicketDTO.to_station=SHH&purpose_codes=ADULT', {
        credentials: 'include'
      });
      return resp.json();
    }, queryUrl);

    if (result.data && result.data.result) {
      const map = result.data.map;
      console.log(`\n🚄 Found ${result.data.result.length} trains:\n`);
      result.data.result.slice(0, 10).forEach(t => {
        const p = t.split('|');
        const seats = [];
        if (p[32] && p[32] !== '无') seats.push(`商务:${p[32]}`);
        if (p[31] && p[31] !== '无') seats.push(`一等:${p[31]}`);
        if (p[30] && p[30] !== '无') seats.push(`二等:${p[30]}`);
        console.log(`  ${(p[3] || '').padEnd(6)} ${(map[p[6]] || '').padEnd(6)} → ${(map[p[7]] || '').padEnd(6)} ${p[8]}-${p[9]} (${p[10]}) [${p[1]}] ${seats.join(' ')}`);
      });
      if (result.data.result.length > 10) console.log(`  ... and ${result.data.result.length - 10} more`);
    } else {
      console.log('❌ Search failed:', JSON.stringify(result).substring(0, 300));
    }

    console.log('\n✅ Done!');
    await ask('Press Enter to close browser...');

  } finally {
    await browser.close();
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
