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
  await page.goto('https://kyfw.12306.cn/otn/resources/login.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // Get ALL visible text and interactive elements on the login page
  const pageStructure = await page.evaluate(() => {
    const sections = [];
    
    // Get all major sections/panels
    document.querySelectorAll('.login-box, .login-account, .login-code, .login-bd, .login-hd, #modal, [class*=login-panel]').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        sections.push({
          tag: el.tagName,
          id: el.id,
          className: el.className.toString().substring(0, 60),
          visibleText: el.innerText.trim().substring(0, 200),
          display: getComputedStyle(el).display,
          children: el.children.length
        });
      }
    });

    // Get ALL inputs on page (visible or not)
    const inputs = Array.from(document.querySelectorAll('input')).map(el => ({
      id: el.id,
      type: el.type,
      placeholder: el.placeholder,
      value: el.value,
      visible: el.offsetWidth > 0,
      className: el.className.toString().substring(0, 40)
    }));

    // Get ALL links/buttons
    const actions = Array.from(document.querySelectorAll('a, button')).filter(el => {
      return el.offsetWidth > 0 && el.textContent.trim();
    }).map(el => ({
      id: el.id,
      text: el.textContent.trim().substring(0, 30),
      className: el.className.toString().substring(0, 60),
      href: el.href || ''
    }));

    return { sections, inputs, actions };
  });

  console.log('=== Visible Login Sections ===');
  pageStructure.sections.forEach(s => console.log(JSON.stringify(s)));
  
  console.log('\n=== All Inputs ===');
  pageStructure.inputs.forEach(i => console.log(JSON.stringify(i)));
  
  console.log('\n=== All Visible Actions ===');
  pageStructure.actions.forEach(a => console.log(JSON.stringify(a)));

  // Also check: is there a phone-number-only login tab or option?
  const phoneOptions = await page.evaluate(() => {
    const text = document.body.innerText;
    const has = (keyword) => text.includes(keyword);
    return {
      hasPhone: has('手机号') || has('手机'),
      hasSmsLogin: has('短信登录') || has('短信验证码登录') || has('手机登录'),
      hasPhoneInput: !!document.querySelector('[placeholder*=手机], [placeholder*=phone]'),
      // Check if there's a separate phone login form
      phoneLoginForm: document.querySelector('[class*=phone-login], [id*=phone-login]')
    };
  });
  console.log('\n=== Phone Login Options ===');
  console.log(JSON.stringify(phoneOptions));

  // Check the full visible page text to spot any phone-related login
  const pageText = await page.evaluate(() => document.body.innerText.substring(0, 1500));
  console.log('\n=== Full Page Text ===');
  console.log(pageText);

  await browser.close();
})().catch(e => console.error(e.message));
