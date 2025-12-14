/**
 * Checkout journey runner - Playwright automation for ecommerce checkout flow
 */

import { Browser, Page, chromium } from 'playwright';
import { StageResult, CheckoutConfig, CheckoutStage } from './types';
import { detectFeaturesOnPage } from './detections';
import { 
  getArtifactPath, 
  getArtifactUrl, 
  extractHighSignalSnippets,
  normalizeDomain,
  sleep 
} from './utils';

let globalBrowser: Browser | null = null;

/**
 * Initialize or reuse browser instance
 */
async function initBrowser(): Promise<Browser> {
  if (globalBrowser && globalBrowser.isConnected()) {
    return globalBrowser;
  }
  
  globalBrowser = await chromium.launch({ headless: true });
  return globalBrowser;
}

/**
 * Safe page navigation with fallback strategies
 */
async function safeGoto(page: Page, url: string, timeouts = { primary: 25000, fallback: 20000 }): Promise<boolean> {
  try {
    // Strategy 1: Network idle (most thorough)
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeouts.primary });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(1500);
    return true;
  } catch (error) {
    console.log(`Network idle failed for ${url}, trying domcontentloaded...`);
  }
  
  try {
    // Strategy 2: DOM content loaded (faster)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeouts.fallback });
    await sleep(2000);
    return true;
  } catch (error) {
    console.log(`DOM content loaded failed for ${url}, trying load...`);
  }
  
  try {
    // Strategy 3: Basic load (minimal)
    await page.goto(url, { waitUntil: 'load', timeout: timeouts.fallback });
    await sleep(1000);
    return true;
  } catch (error) {
    console.log(`All navigation strategies failed for ${url}`);
    return false;
  }
}

/**
 * Find a product page on the site
 */
async function findProductPage(page: Page, domain: string): Promise<string> {
  const baseUrl = normalizeDomain(domain);
  
  try {
    // Strategy 1: Look for Shopify /products/ pattern
    const links = await page.locator('a[href*="/products/"]').first().getAttribute('href');
    if (links) {
      const productUrl = new URL(links, baseUrl).href;
      console.log(`Found Shopify product URL: ${productUrl}`);
      return productUrl;
    }
  } catch {
    console.log('No Shopify product links found');
  }
  
  try {
    // Strategy 2: Look for common product links
    const selector = 'a[href*="/product"], a[href*="?product"], a[href*="item="]';
    const links = await page.locator(selector).first().getAttribute('href');
    if (links) {
      const productUrl = new URL(links, baseUrl).href;
      console.log(`Found generic product URL: ${productUrl}`);
      return productUrl;
    }
  } catch {
    console.log('No generic product links found');
  }
  
  // Fallback: Try to click first product-like link
  try {
    const linkElements = await page.locator('a').all();
    for (const link of linkElements.slice(0, 20)) {
      const href = await link.getAttribute('href');
      const text = await link.textContent();
      
      if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
        const lowerHref = href.toLowerCase();
        const lowerText = (text || '').toLowerCase();
        
        if (lowerHref.includes('product') || lowerText.includes('product') || 
            lowerHref.includes('shop') || lowerText.includes('buy')) {
          const productUrl = new URL(href, baseUrl).href;
          console.log(`Found product link: ${productUrl}`);
          return productUrl;
        }
      }
    }
  } catch (error) {
    console.log('Error crawling links:', error);
  }
  
  throw new Error('Could not find product page on domain');
}

/**
 * Select a product variant if available
 */
async function selectVariantIfNeeded(page: Page): Promise<void> {
  try {
    // Look for variant selectors (size, color, etc)
    const selectElements = await page.locator('select').count();
    if (selectElements > 0) {
      const select = page.locator('select').first();
      const options = await select.locator('option').count();
      
      if (options > 1) {
        // Select second option (skip default/placeholder)
        await select.selectOption({ index: 1 });
        await sleep(500);
        console.log('Selected product variant');
      }
    }
    
    // Also check for radio/button variant selectors
    const variantButtons = await page.locator('[data-variant], [class*="variant"]').count();
    if (variantButtons > 1) {
      const firstButton = page.locator('[data-variant], [class*="variant"]').first();
      await firstButton.click();
      await sleep(500);
      console.log('Clicked variant selector');
    }
  } catch (error) {
    console.log('Variant selection failed (may not be needed):', error);
  }
}

/**
 * Add product to cart
 */
async function addToCart(page: Page): Promise<void> {
  try {
    // Strategy 1: Look for "Add to cart" button
    const addButton = page.locator('button:has-text("Add to cart"), button:has-text("ADD TO CART"), button:has-text("Add To Cart")').first();
    const buttonCount = await addButton.count();
    
    if (buttonCount > 0) {
      await addButton.click();
      await sleep(1500); // Wait for add action + drawer/page update
      console.log('Clicked "Add to cart" button');
      return;
    }
  } catch {
    console.log('Add to cart button not found via text');
  }
  
  try {
    // Strategy 2: Look for button with cart-related classes
    const cartButton = page.locator('button[class*="cart"], button[data-action*="cart"], button[data-action*="add"]').first();
    if (await cartButton.isVisible()) {
      await cartButton.click();
      await sleep(1500);
      console.log('Clicked cart button via selector');
      return;
    }
  } catch {
    console.log('Cart button selector failed');
  }
  
  throw new Error('Could not find add to cart button');
}

/**
 * Go to cart (handle cart drawer vs cart page)
 */
async function goToCart(page: Page): Promise<void> {
  try {
    // Check if cart drawer appeared
    const drawer = page.locator('[class*="drawer"], [class*="modal"], [class*="popup"]').first();
    const isDrawerOpen = await drawer.isVisible().catch(() => false);
    
    if (isDrawerOpen) {
      console.log('Cart opened in drawer, proceeding...');
      return; // Already at cart
    }
  } catch {
    // Continue
  }
  
  try {
    // Try clicking cart icon/link
    const cartLink = page.locator('a[href*="/cart"], button[class*="cart"], a[class*="cart"]').first();
    if (await cartLink.isVisible()) {
      await cartLink.click();
      await sleep(2000);
      console.log('Navigated to cart page');
      return;
    }
  } catch {
    console.log('Cart link not found');
  }
  
  // If we're already on cart page, just wait
  await sleep(1000);
}

/**
 * Click checkout button
 */
async function startCheckout(page: Page): Promise<void> {
  try {
    // Look for checkout button
    const checkoutButton = page.locator(
      'button:has-text("Checkout"), button:has-text("CHECKOUT"), a:has-text("Checkout"), a:has-text("CHECKOUT"), button[class*="checkout"]'
    ).first();
    
    if (await checkoutButton.isVisible()) {
      await checkoutButton.click();
      await sleep(3000); // Checkout page load
      console.log('Clicked checkout button');
      return;
    }
  } catch {
    console.log('Checkout button not found');
  }
  
  throw new Error('Could not start checkout');
}

/**
 * Fill shipping/contact information
 */
async function fillShippingInfo(page: Page, config: CheckoutConfig): Promise<void> {
  console.log('Filling shipping information...');
  
  try {
    // Email
    const emailInput = page.locator('input[type="email"], input[name*="email"]').first();
    if (await emailInput.isVisible()) {
      await emailInput.fill(config.email);
      await sleep(300);
    }
    
    // First name
    const firstNameInput = page.locator('input[name*="first"], input[name*="fname"]').first();
    if (await firstNameInput.isVisible()) {
      await firstNameInput.fill(config.firstName);
      await sleep(300);
    }
    
    // Last name
    const lastNameInput = page.locator('input[name*="last"], input[name*="lname"]').first();
    if (await lastNameInput.isVisible()) {
      await lastNameInput.fill(config.lastName);
      await sleep(300);
    }
    
    // Address
    const addressInput = page.locator('input[name*="address"], input[name*="street"]').first();
    if (await addressInput.isVisible()) {
      await addressInput.fill(config.address);
      await sleep(300);
    }
    
    // City
    const cityInput = page.locator('input[name*="city"]').first();
    if (await cityInput.isVisible()) {
      await cityInput.fill(config.city);
      await sleep(300);
    }
    
    // State
    const stateInput = page.locator('input[name*="state"], input[name*="province"], select[name*="state"]').first();
    if (await stateInput.isVisible()) {
      const isSelect = await stateInput.evaluate(el => el.tagName === 'SELECT');
      if (isSelect) {
        await stateInput.selectOption(config.state);
      } else {
        await stateInput.fill(config.state);
      }
      await sleep(300);
    }
    
    // ZIP
    const zipInput = page.locator('input[name*="zip"], input[name*="postal"]').first();
    if (await zipInput.isVisible()) {
      await zipInput.fill(config.zip);
      await sleep(300);
    }
    
    // Country (usually a select)
    const countryInput = page.locator('select[name*="country"], input[name*="country"]').first();
    if (await countryInput.isVisible()) {
      const isSelect = await countryInput.evaluate(el => el.tagName === 'SELECT');
      if (isSelect) {
        await countryInput.selectOption(config.country);
      } else {
        await countryInput.fill(config.country);
      }
      await sleep(300);
    }
    
    // Phone
    const phoneInput = page.locator('input[type="tel"], input[name*="phone"]').first();
    if (await phoneInput.isVisible()) {
      await phoneInput.fill(config.phone);
      await sleep(300);
    }
    
    // Press Tab or look for Continue button
    await page.keyboard.press('Tab');
    await sleep(1000);
    
    // Try to click Continue button
    const continueButton = page.locator(
      'button:has-text("Continue"), button:has-text("CONTINUE"), button:has-text("Next"), button:has-text("Proceed")'
    ).first();
    
    if (await continueButton.isVisible()) {
      await continueButton.click();
      await sleep(2000);
      console.log('Advanced to next checkout step');
    }
  } catch (error) {
    console.log('Error filling shipping info:', error);
  }
}

/**
 * Try to reach payment page without placing order
 */
async function tryReachPayment(page: Page): Promise<void> {
  try {
    // Look for shipping method selection and advance
    const shippingOptions = await page.locator('input[type="radio"][name*="shipping"], label[class*="shipping"]').count();
    
    if (shippingOptions > 0) {
      // Select first available shipping option
      const firstOption = page.locator('input[type="radio"][name*="shipping"]').first();
      await firstOption.click();
      await sleep(500);
      
      console.log('Selected shipping option');
      
      // Click continue/next button
      const continueButton = page.locator(
        'button:has-text("Continue"), button:has-text("CONTINUE"), button:has-text("Next"), button:has-text("Proceed to Payment")'
      ).first();
      
      if (await continueButton.isVisible()) {
        await continueButton.click();
        await sleep(2000);
        console.log('Advanced to payment');
      }
    }
  } catch (error) {
    console.log('Error advancing to payment:', error);
  }
}

/**
 * Capture a single stage screenshot and data
 */
async function captureStage(
  page: Page,
  jobId: string,
  domain: string,
  stageKey: CheckoutStage
): Promise<StageResult> {
  console.log(`Capturing stage: ${stageKey}`);
  
  const screenshotPath = getArtifactPath(jobId, domain, stageKey);
  const screenshotUrl = getArtifactUrl(jobId, domain, stageKey);
  
  // Take screenshot
  await page.screenshot({ path: screenshotPath, quality: 70 });
  
  // Extract text content
  const domText = await page.innerText('body').catch(() => '');
  
  // Detect features
  const detections = await detectFeaturesOnPage(page, domText, stageKey);
  
  // Extract high-signal snippets
  const snippets = extractHighSignalSnippets(domText);
  
  return {
    key: stageKey,
    url: page.url(),
    screenshotUrl,
    notes: [],
    detections,
    extractedSnippets: snippets,
  };
}

/**
 * Main checkout journey execution
 */
export async function runCheckoutJourney(
  domain: string,
  jobId: string,
  config: CheckoutConfig
): Promise<StageResult[]> {
  const stages: StageResult[] = [];
  const browser = await initBrowser();
  const page = await browser.newPage();
  
  try {
    const baseUrl = normalizeDomain(domain);
    
    // Stage 1: Homepage
    console.log(`\n📄 Capturing Homepage...`);
    const homepageLoaded = await safeGoto(page, baseUrl);
    if (homepageLoaded) {
      const homeStage = await captureStage(page, jobId, domain, 'homepage');
      stages.push(homeStage);
    } else {
      throw new Error('Failed to load homepage');
    }
    
    // Stage 2: Product page
    console.log(`\n📦 Finding and capturing Product page...`);
    const productUrl = await findProductPage(page, domain);
    await safeGoto(page, productUrl);
    
    // Try to select variant
    await selectVariantIfNeeded(page);
    
    const productStage = await captureStage(page, jobId, domain, 'product');
    stages.push(productStage);
    
    // Stage 3: Add to cart
    console.log(`\n🛒 Adding to cart...`);
    await addToCart(page);
    
    // Stage 4: Cart page
    console.log(`\n🛒 Capturing Cart...`);
    await goToCart(page);
    const cartStage = await captureStage(page, jobId, domain, 'cart');
    stages.push(cartStage);
    
    // Stage 5: Checkout - Contact info
    console.log(`\n✉️ Starting checkout and entering contact info...`);
    await startCheckout(page);
    
    await fillShippingInfo(page, config);
    
    // Give page time to update
    await sleep(2000);
    const contactStage = await captureStage(page, jobId, domain, 'checkout_contact');
    stages.push(contactStage);
    
    // Stage 6: Checkout - Shipping (MOST IMPORTANT - EDD appears here)
    console.log(`\n📍 Capturing Checkout Shipping page (EDD detection)...`);
    await sleep(1500);
    const shippingStage = await captureStage(page, jobId, domain, 'checkout_shipping');
    stages.push(shippingStage);
    
    // Stage 7: Checkout - Payment (STOP HERE - DO NOT PLACE ORDER)
    console.log(`\n💳 Reaching Payment page...`);
    await tryReachPayment(page);
    await sleep(1500);
    const paymentStage = await captureStage(page, jobId, domain, 'checkout_payment');
    stages.push(paymentStage);
    
    console.log(`\n✅ Checkout journey completed successfully!`);
    return stages;
  } catch (error) {
    console.error(`❌ Error during checkout journey:`, error);
    // Return whatever stages we captured before the error
    return stages;
  } finally {
    await page.close();
  }
}

/**
 * Close browser on shutdown
 */
export async function closeBrowser(): Promise<void> {
  if (globalBrowser) {
    try {
      await globalBrowser.close();
      globalBrowser = null;
    } catch (error) {
      console.error('Error closing browser:', error);
    }
  }
}

