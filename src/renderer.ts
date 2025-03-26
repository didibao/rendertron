import * as puppeteer from 'puppeteer';
import * as url from 'url';

import { Config } from './config';

type SerializedResponse = {
  status: number; content: string;
};

type ViewportDimensions = {
  width: number; height: number;
};

const MOBILE_USERAGENT =
  'Mozilla/5.0 (Linux; Android 8.0.0; Pixel 2 XL Build/OPD1.170816.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.75 Mobile Safari/537.36';

/**
 * Wraps Puppeteer's interface to Headless Chrome to expose high level rendering
 * APIs that are able to handle web components and PWAs.
 */
export class Renderer {
  private browser: puppeteer.Browser;
  private config: Config;

  constructor(browser: puppeteer.Browser, config: Config) {
    this.browser = browser;
    this.config = config;
  }

  async serialize(requestUrl: string, isMobile: boolean):
    Promise<SerializedResponse> {
    /**
     * Executed on the page after the page has loaded. Strips script and
     * import tags to prevent further loading of resources.
     */
    function stripPage() {
      // Strip only script tags that contain JavaScript (either no type attribute or one that contains "javascript")
      const elements = document.querySelectorAll('script:not([type]), script[type*="javascript"], link[rel=import]');
      for (const e of Array.from(elements)) {
        e.remove();
      }
    }

    /**
     * Injects a <base> tag which allows other resources to load. This
     * has no effect on serialised output, but allows it to verify render
     * quality.
     */
    function injectBaseHref(origin: string) {
      const base = document.createElement('base');
      base.setAttribute('href', origin);

      const bases = document.head.querySelectorAll('base');
      if (bases.length) {
        // Patch existing <base> if it is relative.
        const existingBase = bases[0].getAttribute('href') || '';
        if (existingBase.startsWith('/')) {
          bases[0].setAttribute('href', origin + existingBase);
        }
      } else {
        // Only inject <base> if it doesn't already exist.
        document.head.insertAdjacentElement('afterbegin', base);
      }
    }

    const page = await this.browser.newPage();

    // Page may reload when setting isMobile
    // https://github.com/GoogleChrome/puppeteer/blob/v1.10.0/docs/api.md#pagesetviewportviewport
    await page.setViewport({ width: this.config.width, height: this.config.height, isMobile });

    if (isMobile) {
      page.setUserAgent(MOBILE_USERAGENT);
    }

    page.evaluateOnNewDocument('customElements.forcePolyfill = true');
    page.evaluateOnNewDocument('ShadyDOM = {force: true}');
    page.evaluateOnNewDocument('ShadyCSS = {shimcssproperties: true}');

    let response: puppeteer.Response | null = null;
    // Capture main frame response. This is used in the case that rendering
    // times out, which results in puppeteer throwing an error. This allows us
    // to return a partial response for what was able to be rendered in that
    // time frame.
    page.addListener('response', (r: puppeteer.Response) => {
      if (!response) {
        response = r;
      }
    });

    try {
      // Navigate to page. Wait until there are no oustanding network requests.
      response = await page.goto(
        requestUrl, { timeout: this.config.timeout, waitUntil: 'networkidle0' });
    } catch (e) {
      console.error(e);
    }

    if (!response) {
      console.error('response does not exist');
      // This should only occur when the page is about:blank. See
      // https://github.com/GoogleChrome/puppeteer/blob/v1.5.0/docs/api.md#pagegotourl-options.
      await page.close();
      return { status: 400, content: '' };
    }

    // Disable access to compute metadata. See
    // https://cloud.google.com/compute/docs/storing-retrieving-metadata.
    if (response.headers()['metadata-flavor'] === 'Google') {
      await page.close();
      return { status: 403, content: '' };
    }

    // Set status to the initial server's response code. Check for a <meta
    // name="render:status_code" content="4xx" /> tag which overrides the status
    // code.
    let statusCode = response.status();
    const newStatusCode =
      await page
        .$eval(
          'meta[name="render:status_code"]',
          (element) => parseInt(element.getAttribute('content') || ''))
        .catch(() => undefined);
    // On a repeat visit to the same origin, browser cache is enabled, so we may
    // encounter a 304 Not Modified. Instead we'll treat this as a 200 OK.
    if (statusCode === 304) {
      statusCode = 200;
    }
    // Original status codes which aren't 200 always return with that status
    // code, regardless of meta tags.
    if (statusCode === 200 && newStatusCode) {
      statusCode = newStatusCode;
    }

    // Remove script & import tags.
    await page.evaluate(stripPage);
    // Inject <base> tag with the origin of the request (ie. no path).
    const parsedUrl = url.parse(requestUrl);
    await page.evaluate(
      injectBaseHref, `${parsedUrl.protocol}//${parsedUrl.host}`);

    // Serialize page.
    const result = await page.evaluate('document.firstElementChild.outerHTML');

    await page.close();
    return { status: statusCode, content: result };
  }

  async screenshot(
    url: string,
    isMobile: boolean,
    dimensions: ViewportDimensions,
    options?: object): Promise<Buffer> {
    const page = await this.browser.newPage();

    // Page may reload when setting isMobile
    // https://github.com/GoogleChrome/puppeteer/blob/v1.10.0/docs/api.md#pagesetviewportviewport
    await page.setViewport(
      { width: dimensions.width, height: dimensions.height, isMobile });

    if (isMobile) {
      page.setUserAgent(MOBILE_USERAGENT);
    }

    let response: puppeteer.Response | null = null;

    try {
      // Navigate to page. Wait until there are no oustanding network requests.
      response =
        await page.goto(url, { timeout: 10000, waitUntil: 'networkidle0' });
    } catch (e) {
      console.error(e);
    }

    if (!response) {
      throw new ScreenshotError('NoResponse');
    }

    // Disable access to compute metadata. See
    // https://cloud.google.com/compute/docs/storing-retrieving-metadata.
    if (response!.headers()['metadata-flavor'] === 'Google') {
      throw new ScreenshotError('Forbidden');
    }

    // Must be jpeg & binary format.
    const screenshotOptions =
      Object.assign({}, options, { type: 'jpeg', encoding: 'binary' });
    // Screenshot returns a buffer based on specified encoding above.
    // https://github.com/GoogleChrome/puppeteer/blob/v1.8.0/docs/api.md#pagescreenshotoptions
    const buffer = await page.screenshot(screenshotOptions) as Buffer;
    return buffer;
  }

  async report(
    address: string): Promise<string | null> {
    const page = await this.browser.newPage();

    console.log(`start 1`);

    // Step 1: Navigate to login page
    // await page.goto('https://rpp.corelogic.com.au', { waitUntil: 'networkidle2' });
    await page.goto('https://www.corelogic.com.au', { waitUntil: 'networkidle2' });

    // 1. Wait for the button to appear
    await page.waitForSelector('button.btn-login');

    console.log(`start 2`);

    // 2. Click the button
    await page.click('button.btn-login');

    console.log(`start 3`);

    // 3. (Optional) Wait for the collapse or login form to appear if needed
    // For example, if a "collapse" or modal with id="#login" is supposed to open:
    await page.waitForSelector('#login.show'); // or any element inside #login that indicates it's open

    console.log('Login button clicked and login form is now visible');

    await page.waitForSelector('a[data-menu-name="RP Data"]');

    // Remove the `target` so it won’t open a new tab
    // await page.evaluate(() => {
    //   document && document.querySelector('a[data-menu-name="RP Data"]').removeAttribute('target');
    // });

    await Promise.all([
      // Now click the link
      await page.click('a[data-menu-name="RP Data"]'),
      await page.waitForNavigation({ waitUntil: 'networkidle2' }),
    ]);

    console.log('start 2');

    // Step 2: Fill in login form and submit
    // (Replace selectors with the actual selectors for the login form)
    await page.type('#username', process.env.WEB_USERNAME || '');
    await page.type('#password', process.env.WEB_PASSWORD || '');
    await Promise.all([
      page.click('#signOnButton'),
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
    ]);

    // Step 3: Input the property address
    // await page.click('#crux-multi-locality-search'),
    await page.type('#crux-multi-locality-search', address);

    // Wait for the list option to appear
    await page.waitForSelector('#crux-multi-locality-search-option-0');

    await Promise.all([
      // Click the first option
      await page.click('#crux-multi-locality-search-option-0'),
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
    ]);

    // Step 4: Tap the generate button
    // Wait for the Reports dropdown button to appear
    await page.waitForSelector('div.dropdown.reports-dropdown');

    // Click the button to open the dropdown menu
    await page.click('div.dropdown.reports-dropdown');

    await page.waitForSelector('div.report-trigger.digital-profile-report');
    await page.click('div.report-trigger.digital-profile-report');

    // Wait for the switch element to appear
    await page.waitForSelector('input.MuiSwitch-input');

    // Check if the switch is checked
    // const isChecked = await page.$eval('input.MuiSwitch-input', el => el.checked);

    // if (isChecked) {
    // Click the switch to turn it off
    await page.click('input.MuiSwitch-input');
    // }

    // Optionally verify the switch is now unchecked
    // const updatedChecked = await page.$eval('input.MuiSwitch-input', el => el.checked);
    // console.log('phone number is now checked:', updatedChecked); // should log false

    // Wait for the Generate Report button to appear
    await page.waitForSelector('button[name="generate-report-pdf"]');

    await page.click('button[name="generate-report-pdf"]'),

      // Step 5: Retrieve the report URL from the page.
      // Wait for the iframe element to appear
      await page.waitForSelector('iframe[data-testid="portal"]');

    // Extract the src attribute from the iframe
    const reportUrl = await page.$eval('iframe[data-testid="portal"]', el => el.getAttribute('src'));
    console.log('reportUrl:', reportUrl);

    await page.close();

    return reportUrl;
  }
}

type ErrorType = 'Forbidden' | 'NoResponse';

export class ScreenshotError extends Error {
  type: ErrorType;

  constructor(type: ErrorType) {
    super(type);

    this.name = this.constructor.name;

    this.type = type;
  }
}
