import puppeteer from 'puppeteer-core';
import chromium from 'chrome-aws-lambda';

/**
 * Scrapes Google reviews from a business Maps URL.
 * @param {string} businessUrl - Full Google Maps URL for the business.
 * @param {object} options - Optional config (scroll count, delay, etc.)
 * @returns {Promise<Array>} - Array of review objects.
 */
export async function scrapeGoogleReviews(businessUrl, options = {}) {
  const {
    scrollCount = 5,
    scrollDelay = 2000,
  } = options;

  console.log('[scrapeGoogleReviews] Starting scrape...');
  console.log(`[scrapeGoogleReviews] URL: ${businessUrl}`);
  console.log(`[scrapeGoogleReviews] Options:`, { scrollCount, scrollDelay });

  let browser;

  try {
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', ...chromium.args],
      executablePath: process.env.CHROMIUM_PATH || await chromium.executablePath,
      headless: chromium.headless,
      defaultViewport: chromium.defaultViewport,
    });
    const version = await browser.version();
    console.log('Launched browser version:', version);

    console.log('[scrapeGoogleReviews] Browser launched.');

    const page = await browser.newPage();
    console.log('[scrapeGoogleReviews] New page opened.');

    await page.goto(businessUrl, { waitUntil: 'networkidle2' });
    console.log('[scrapeGoogleReviews] Navigated to URL.');

    // Click the "Reviews" tab
    const reviewTabSelector = 'button[aria-label^="Reviews for"]';
    await page.waitForSelector(reviewTabSelector, { timeout: 10000 });
    console.log('[scrapeGoogleReviews] Clicking reviews tab...');
    await page.click(reviewTabSelector);
    await page.waitForTimeout(3000);

    // Scroll reviews
    const scrollContainerSelector = 'div.m6QErb.DxyBCb.kA9KIf.dS8AEf.XiKgde';
    await page.waitForSelector(scrollContainerSelector, { timeout: 10000 });
    const scrollContainer = await page.$(scrollContainerSelector);

    for (let i = 0; i < scrollCount; i++) {
      console.log(`[scrapeGoogleReviews] Scroll iteration ${i + 1}/${scrollCount}`);
      await page.evaluate(div => {
        if (div) div.scrollTop = div.scrollHeight;
      }, scrollContainer);
      await page.waitForTimeout(scrollDelay);
    }

    console.log('[scrapeGoogleReviews] Finished scrolling. Extracting reviews...');

    let browserClosed = false;
    browser.on('disconnected', () => {
      console.error('[Puppeteer] Browser disconnected!');
      browserClosed = true;
    });

    const timeout = ms => new Promise(resolve => setTimeout(() => resolve(null), ms));
    const watchBrowser = new Promise(resolve => {
      const check = () => browserClosed ? resolve(null) : setTimeout(check, 100);
      check();
    });

    const reviews = await Promise.race([
      page.evaluate(() => {
        const reviewEls = document.querySelectorAll('.jftiEf');
        const results = [];

        reviewEls.forEach(el => {
          const author = el.querySelector('.d4r55')?.innerText || '';
          const rating = el.querySelector('.kvMYJc')?.getAttribute('aria-label') || '';
          const text = el.querySelector('.wiI7pd')?.innerText || '';
          const time = el.querySelector('.rsqaWe')?.innerText || '';
          results.push({ author, rating, text, time });
        });

        return results;
      }),
      timeout(15000),     // timeout fallback
      watchBrowser       // early escape if browser dies
    ]);

    if (!reviews) {
      console.warn('[Scraper] Review scraping failed or timed out.');
    }


    console.log(`[scrapeGoogleReviews] Extracted ${reviews.length} reviews.`);
    return reviews;

  } catch (err) {
    console.error('[scrapeGoogleReviews] Error occurred:', err);
    throw err;

  } finally {
    if (browser) {
      await browser.close();
      console.log('[scrapeGoogleReviews] Browser closed.');
    }
  }
}
