const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
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

  const page = await context.newPage();

  // Capture all API calls
  const apiCalls = [];
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('passport') || url.includes('login') || url.includes('sms') || 
        url.includes('message') || url.includes('verify') || url.includes('sendMobile') ||
        url.includes('checkUp') || url.includes('uamtk') || url.includes('slide')) {
      try {
        const body = await res.text();
        apiCalls.push({
          url: url.replace('https://kyfw.12306.cn', '').replace('https://www.12306.cn', ''),
          status: res.status(),
          body: body.substring(0, 500)
        });
      } catch(e) {}
    }
  });

  page.on('console', msg => {
    const txt = msg.text();
    if (txt.includes('login') || txt.includes('sms') || txt.includes('verify') || txt.includes('error'))
      console.log('CONSOLE:', msg.type(), txt.substring(0, 200));
  });

  await page.goto('https://kyfw.12306.cn/otn/resources/login.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // Examine the SMS verification modal structure
  const smsModalInfo = await page.evaluate(() => {
    // The verification modal
    const modal = document.querySelector('#modal');
    const verification = document.querySelector('#verification');
    const shortMessage = document.querySelector('#short_message');
    const slide = document.querySelector('#slide');
    
    // SMS verification elements
    const smsBtn = document.querySelector('#login_control_submit');
    const smsError = document.querySelector('#login_control_error');
    const smsCancel = document.querySelector('#login_control_cancel');
    
    // SMS down path (获取验证码 path)
    const downSection = document.querySelector('#down');
    const upSection = document.querySelector('#upStream');
    
    // Check for phone-related elements
    const phoneInput = document.querySelector('#login_control_phone, [id*=phone], [id*=mobile]');
    
    // Check the "短信验证" tab
    const smsTab = document.querySelector('#verification li:nth-child(2)');

    return {
      modalExists: !!modal,
      modalDisplay: modal ? getComputedStyle(modal).display : 'N/A',
      verificationExists: !!verification,
      shortMessageExists: !!shortMessage,
      shortMessageHTML: shortMessage ? shortMessage.innerHTML.substring(0, 500) : 'N/A',
      slideExists: !!slide,
      smsBtn: smsBtn ? { id: smsBtn.id, text: smsBtn.textContent.trim() } : 'N/A',
      smsError: smsError ? { id: smsError.id, text: smsError.textContent.trim() } : 'N/A',
      smsCancel: smsCancel ? { id: smsCancel.id, text: smsCancel.textContent.trim() } : 'N/A',
      downSection: downSection ? downSection.innerHTML.substring(0, 300) : 'N/A',
      upSection: upSection ? upSection.innerHTML.substring(0, 300) : 'N/A',
      smsTab: smsTab ? { text: smsTab.textContent.trim(), className: smsTab.className } : 'N/A',
      phoneInput: phoneInput ? { id: phoneInput.id } : 'N/A',
    };
  });
  console.log('=== SMS Modal Info ===');
  console.log(JSON.stringify(smsModalInfo, null, 2));

  // Now let's try to type username and password and click login
  // to see what API calls are made and what the verification flow looks like
  await page.fill('#J-userName', process.env.TRAIN_USERNAME || 'testuser');
  await page.fill('#J-password', process.env.TRAIN_PASSWORD || 'testpassword');
  
  // Intercept the next batch of API calls
  const preLoginCalls = apiCalls.length;
  
  // Click login button
  await page.click('#J-login');
  await page.waitForTimeout(3000);

  console.log('\n=== API Calls after login click ===');
  apiCalls.slice(preLoginCalls).forEach(c => {
    console.log(c.status, c.url);
    try {
      const json = JSON.parse(c.body);
      console.log('  ', JSON.stringify(json).substring(0, 200));
    } catch(e) {
      console.log('  ', c.body.substring(0, 150));
    }
    console.log();
  });

  // Check current page state
  const afterLoginState = await page.evaluate(() => {
    // Check if verification modal appeared
    const modal = document.querySelector('#modal');
    const modalStyle = modal ? getComputedStyle(modal).display : 'N/A';
    
    // Check for slide captcha
    const slideEl = document.querySelector('#J-slide-passcode');
    const ncEl = slideEl ? slideEl.children.length : 0;
    
    // Check for SMS-related visible elements
    const smsVisible = [];
    const smsEls = document.querySelectorAll('[id*=login_control], #short_message, #down, #upStream');
    smsEls.forEach(el => {
      const style = getComputedStyle(el.closest('[class*=panel-tooltip]') || el);
      if (style.display !== 'none' && style.visibility !== 'hidden') {
        smsVisible.push({ id: el.id, text: el.textContent.trim().substring(0, 60) });
      }
    });
    
    // Check error messages
    const errorEl = document.querySelector('#J-login-error');
    
    return {
      modalDisplay: modalStyle,
      slideChildren: ncEl,
      smsVisible: smsVisible,
      loginError: errorEl ? errorEl.textContent.trim() : 'N/A',
      currentUrl: location.href
    };
  });
  console.log('\n=== After Login State ===');
  console.log(JSON.stringify(afterLoginState, null, 2));

  await browser.close();
})().catch(e => console.error(e.message));
