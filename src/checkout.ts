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
  sleep as baseSleep 
} from './utils';
import { detectShopify, ShopifyInfo, isShopifyProductPage, isShopifyCartPage } from './shopify-detector';

/**
 * SPEED CONFIGURATION
 * Set FAST_MODE=true for ~2x faster audits (may be less reliable on slow sites)
 */
const FAST_MODE = process.env.FAST_MODE === 'true' || true; // Default to fast mode

// Speed multiplier: 1.0 = normal, 0.5 = 2x faster, 0.3 = 3x faster
const SPEED_MULTIPLIER = FAST_MODE ? 0.4 : 1.0;

// Optimized sleep function that respects speed mode
function sleep(ms: number): Promise<void> {
  const adjustedMs = Math.max(100, Math.round(ms * SPEED_MULTIPLIER));
  return baseSleep(adjustedMs);
}

// Fast timeout values
const TIMEOUTS = {
  navigation: FAST_MODE ? 15000 : 30000,
  fallbackNav: FAST_MODE ? 10000 : 20000,
  element: FAST_MODE ? 1000 : 2000,
  elementShort: FAST_MODE ? 500 : 1500,
  elementVeryShort: FAST_MODE ? 300 : 1000,
};

/**
 * CONCURRENCY CONFIGURATION
 * Controls how many browser instances can run simultaneously
 */
const MAX_CONCURRENT_BROWSERS = parseInt(process.env.MAX_CONCURRENT || '3', 10);
let activeBrowserCount = 0;
const browserQueue: Array<() => void> = [];

/**
 * Semaphore for controlling concurrent browser instances
 */
async function acquireBrowserSlot(): Promise<void> {
  if (activeBrowserCount < MAX_CONCURRENT_BROWSERS) {
    activeBrowserCount++;
    console.log(`🔓 Acquired browser slot (${activeBrowserCount}/${MAX_CONCURRENT_BROWSERS} active)`);
    return;
  }
  
  // Wait in queue
  console.log(`⏳ Waiting for browser slot (${activeBrowserCount}/${MAX_CONCURRENT_BROWSERS} active, ${browserQueue.length + 1} queued)`);
  return new Promise((resolve) => {
    browserQueue.push(() => {
      activeBrowserCount++;
      console.log(`🔓 Acquired browser slot from queue (${activeBrowserCount}/${MAX_CONCURRENT_BROWSERS} active)`);
      resolve();
    });
  });
}

function releaseBrowserSlot(): void {
  activeBrowserCount--;
  console.log(`🔒 Released browser slot (${activeBrowserCount}/${MAX_CONCURRENT_BROWSERS} active)`);
  
  // Wake up next in queue
  const next = browserQueue.shift();
  if (next) {
    next();
  }
}

// Legacy global browser (for backwards compatibility with single audits)
let globalBrowser: Browser | null = null;

/**
 * Detect country/region from domain and provide appropriate checkout config
 */
export function getCheckoutConfigForDomain(domain: string, baseConfig: CheckoutConfig): CheckoutConfig {
  const lowerDomain = domain.toLowerCase();
  
  // Detect country by TLD
  const ukTlds = ['.uk', '.co.uk', '.org.uk', '.gov.uk'];
  const usTlds = ['.com', '.us', '.org', '.net']; // US defaults
  const deTlds = ['.de', '.at', '.ch'];
  const frTlds = ['.fr'];
  
  let config = { ...baseConfig };
  
  if (ukTlds.some(tld => lowerDomain.endsWith(tld))) {
    // UK Address
    config = {
      ...config,
      firstName: 'David',
      lastName: 'Thompson',
      email: 'david.thompson@example.co.uk',
      address: '15 Oakwood Road',
      city: 'Manchester',
      state: 'Greater Manchester',
      zip: 'M16 8RA',
      country: 'GB',
      phone: '+44 161 496 0000',
      cardName: 'David Thompson',
    };
  } else if (deTlds.some(tld => lowerDomain.endsWith(tld))) {
    // Germany/Austria/Switzerland Address
    config = {
      ...config,
      firstName: 'Hans',
      lastName: 'Mueller',
      email: 'hans.mueller@example.de',
      address: 'Königstraße 123',
      city: 'Stuttgart',
      state: 'Baden-Württemberg',
      zip: '70173',
      country: 'DE',
      phone: '+49 711 1234567',
      cardName: 'Hans Mueller',
    };
  } else if (frTlds.some(tld => lowerDomain.endsWith(tld))) {
    // France Address
    config = {
      ...config,
      firstName: 'Marie',
      lastName: 'Dupont',
      email: 'marie.dupont@example.fr',
      address: '123 Rue de la Paix',
      city: 'Paris',
      state: 'Île-de-France',
      zip: '75001',
      country: 'FR',
      phone: '+33 1 4289 0000',
      cardName: 'Marie Dupont',
    };
  } else {
    // Default to US
    config = {
      ...config,
      firstName: 'Michael',
      lastName: 'Johnson',
      email: 'michael.johnson@example.com',
      address: '456 Elm Avenue',
      city: 'Austin',
      state: 'TX',
      zip: '78701',
      country: 'US',
      phone: '+1 512 555 0198',
      cardName: 'Michael Johnson',
    };
  }
  
  return config;
}

/**
 * Initialize or reuse browser instance (legacy - for single audits)
 */
async function initBrowser(): Promise<Browser> {
  if (globalBrowser && globalBrowser.isConnected()) {
    return globalBrowser;
  }
  
  globalBrowser = await chromium.launch({ headless: true });
  return globalBrowser;
}

/**
 * Create a NEW browser instance for concurrent audits
 * Each audit gets its own browser to enable true parallelism
 */
async function createBrowserForAudit(): Promise<Browser> {
  // Configure browser with US locale to avoid geo-redirects
  const browser = await chromium.launch({ 
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ]
  });
  return browser;
}

/**
 * Auto-accept common cookie banners - Multiple strategies
 */
async function acceptCookies(page: Page): Promise<void> {
  try {
    console.log('Attempting to accept cookies...');
    await sleep(300); // Let banner render

    // Strategy 1: Text-based button matching (most reliable) - try exact matches first
    const exactPatterns = [
      'Accept All Cookies',
      'ACCEPT ALL COOKIES',
      'Accept all cookies',
      'Accept All',
      'ACCEPT ALL',
      'Accept',
      'ACCEPT',
      'Agree',
      'AGREE'
    ];
    
    for (const pattern of exactPatterns) {
      try {
        // Try button with exact text match
        const button = page.locator(`button:has-text("${pattern}"), a:has-text("${pattern}"), div[role="button"]:has-text("${pattern}")`).first();
        const isVisible = await button.isVisible({ timeout: 1500 });
        
        if (isVisible) {
          await button.click({ force: true });
          await sleep(1000);
          console.log(`  ✓ Cookie banner accepted: "${pattern}"`);
          return;
        }
      } catch (e) {
        // Continue to next pattern
      }
    }
    
    // Strategy 1b: Try case-insensitive partial matches
    const textPatterns = ['Accept All', 'Accept', 'Agree'];
    
    for (const pattern of textPatterns) {
      try {
        const buttons = await page.$$eval('button, a, div[role="button"]', (els, pat) => {
          return els
            .filter(el => {
              const text = el.textContent?.trim().toLowerCase() || '';
              return text.includes(pat.toLowerCase());
            })
            .slice(0, 3)
            .map(el => ({
              tag: el.tagName,
              text: el.textContent,
              visible: (el as HTMLElement).offsetParent !== null
            }));
        }, pattern);

        if (buttons.length > 0) {
          // Prefer buttons with "all" or "accept all" in text
          const preferredButton = buttons.find(b => b.text?.toLowerCase().includes('all')) || buttons[0];
          
          if (preferredButton.visible) {
            const button = page.locator(`button:has-text("${preferredButton.text}")`).first();
            await button.click({ force: true });
            await sleep(1000);
            console.log(`  ✓ Cookie banner accepted: "${preferredButton.text}"`);
            return;
          }
        }
      } catch (e) {
        // Continue to next pattern
      }
    }

    // Strategy 2: CSS class patterns
    const classSelectors = [
      'button.accept',
      'button[class*="accept"]',
      'button[class*="cookie"]',
      '[class*="consent"] button:first-child',
      '[role="dialog"] button:first-child'
    ];

    for (const selector of classSelectors) {
      try {
        const button = page.locator(selector).first();
        const isVisible = await button.isVisible({ timeout: 1000 });
        if (isVisible) {
          await button.click({ force: true });
          await sleep(1000);
          console.log(`✓ Cookie banner accepted with selector: "${selector}"`);
          return;
        }
      } catch {
        // Continue to next selector
      }
    }

    // Strategy 3: Try iframes (some banners are in iframes)
    try {
      const frames = page.frames();
      for (const frame of frames) {
        const button = frame.locator('button:has-text("Accept")').first();
        if (await button.isVisible({ timeout: 1000 })) {
          await button.click({ force: true });
          await sleep(1000);
          console.log('✓ Cookie banner accepted in iframe');
          return;
        }
      }
    } catch {
      // Frame approach didn't work
    }

    console.log('⚠ No cookie banner found or already accepted');
  } catch (error) {
    console.log('⚠ Cookie acceptance failed, continuing without accepting...');
  }
}

/**
 * Safe page navigation with fallback strategies
 */
async function safeGoto(page: Page, url: string, timeouts = { primary: TIMEOUTS.navigation, fallback: TIMEOUTS.fallbackNav }): Promise<boolean> {
  try {
    // Strategy 1: Network idle (most thorough)
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeouts.primary });
    
    // Accept cookies before scrolling
    await acceptCookies(page);
    
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
 * Find a product page on the site (skip gift cards, prefer best sellers)
 */
async function findProductPage(page: Page, domain: string): Promise<string> {
  const baseUrl = normalizeDomain(domain);
  
  try {
    console.log('🔍 Looking for a real product (skipping gift cards)...');

    // Strategy 1: Look for "Best Sellers" section and get first product link
    try {
      const bestSellerSection = await page.locator('text=/Best Seller|Best Selling|Top Seller/i').first();
      if (await bestSellerSection.isVisible({ timeout: 2000 })) {
        console.log('  Found "Best Sellers" section');
        
        // Find product link near best seller text
        const productLink = await page.locator('a[href*="/products/"]').first().getAttribute('href');
        if (productLink && !productLink.toLowerCase().includes('gift')) {
          const productUrl = new URL(productLink, baseUrl).href;
          console.log(`  ✓ Selected best seller product: ${productUrl}`);
          return productUrl;
        }
      }
    } catch (e) {
      console.log('  No "Best Sellers" section found');
    }

    // Strategy 2: Look for product links, filtering out gift cards
    try {
      const allProductLinks = await page.locator('a[href*="/products/"]').all();
      
      for (const link of allProductLinks) {
        const href = await link.getAttribute('href');
        const text = await link.textContent();
        
        if (!href) continue;
        
        const lowerHref = href.toLowerCase();
        const lowerText = (text || '').toLowerCase();
        
        // Skip gift cards, bundles (sometimes), and non-products
        if (lowerHref.includes('gift') || lowerText.includes('gift card') || 
            lowerText.includes('digital gift')) {
          console.log(`  Skipping gift card: ${text?.trim()}`);
          continue;
        }
        
        // Found a real product
        const productUrl = new URL(href, baseUrl).href;
        console.log(`  ✓ Selected product: ${text?.trim()} - ${productUrl}`);
        return productUrl;
      }
    } catch (error) {
      console.log('  Error checking Shopify products');
    }
    
    // Strategy 3: Look for common product selectors
    try {
      const selector = 'a[href*="/product"], a[href*="?product"], a[href*="item="]';
      const linkElements = await page.locator(selector).all();
      
      for (const link of linkElements) {
        const href = await link.getAttribute('href');
        const text = await link.textContent();
        
        if (!href) continue;
        
        const lowerText = (text || '').toLowerCase();
        if (lowerText.includes('gift')) continue;
        
        const productUrl = new URL(href, baseUrl).href;
        console.log(`  ✓ Selected product: ${productUrl}`);
        return productUrl;
      }
    } catch (error) {
      console.log('  Error checking generic products');
    }
  } catch (error) {
    console.log('Error finding product:', error);
  }
  
  throw new Error('Could not find a real product (gift cards were filtered out)');
}

/**
 * Handle country/location selection popups
 */
async function handleCountrySelection(page: Page): Promise<void> {
  try {
    console.log('  Checking for country/location selection...');
    await sleep(1000);
    
    // Look for country selection dialogs
    const countrySelectors = [
      'button:has-text("US"), button:has-text("United States"), button:has-text("USA")',
      '[aria-label*="United States"]',
      '[data-country="US"], [data-country="USA"]',
      'button[class*="country"]:has-text("US")',
      // Also try clicking the selected country if already selected
      '[class*="country"][class*="selected"], [class*="country"][class*="active"]'
    ];
    
    for (const selector of countrySelectors) {
      try {
        const button = page.locator(selector).first();
        if (await button.isVisible({ timeout: 1500 })) {
          await button.click({ force: true });
          await sleep(800);
          console.log(`  ✓ Selected country/location`);
          return;
        }
      } catch {
        // Try next selector
      }
    }
    
    // Try to find and click X/close on country selection dialog
    const countryDialog = page.locator('[class*="country"], [class*="location"], [aria-label*="country"], [aria-label*="location"]').first();
    if (await countryDialog.isVisible({ timeout: 1000 })) {
      const closeBtn = countryDialog.locator('button:has-text("×"), button:has-text("X"), [aria-label="Close"]').first();
      if (await closeBtn.isVisible({ timeout: 500 })) {
        await closeBtn.click({ force: true });
        await sleep(800);
        console.log('  ✓ Closed country selection dialog');
        return;
      }
    }
    
  } catch (error) {
    console.log(`  ⚠ Country selection handling: ${error}`);
  }
}

/**
 * Close any open modals, popups, dialogs, or newsletter signups
 */
async function closeModals(page: Page): Promise<void> {
  try {
    console.log('  Checking for open modals/popups...');
    
    // Handle country selection first
    await handleCountrySelection(page);
    
    // Wait a bit for popups to appear (they often load after page)
    await sleep(1000);
    
    // Try multiple times - popups can appear with delays
    const maxAttempts = FAST_MODE ? 1 : 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Strategy 1: Press Escape key (works for most modals)
      try {
        await page.keyboard.press('Escape');
        await sleep(500);
      } catch {
        // Continue
      }

      // Strategy 2: Look for X/close button (most common) - try multiple selectors
      const closeButtons = [
        'button[aria-label="Close"]',
        'button[aria-label="close"]',
        'button:has-text("×")',
        'button:has-text("✕")',
        'button:has-text("X")',
        '[class*="close"]',
        '[class*="modal"] [class*="close"]',
        '[class*="popup"] [class*="close"]',
        '[class*="dialog"] [class*="close"]',
        '[class*="newsletter"] [class*="close"]',
        '[class*="signup"] [class*="close"]',
        '[class*="email"] [class*="close"]',
        '[role="dialog"] button:first-child',
        '.modal-close',
        '.popup-close',
        '.dialog-close',
        'button[data-dismiss="modal"]',
        '[data-close]',
        '[data-dismiss]'
      ];

      for (const selector of closeButtons) {
        try {
          const closeBtn = page.locator(selector).first();
          const isVisible = await closeBtn.isVisible({ timeout: 500 });
          
          if (isVisible) {
            await closeBtn.click({ force: true, timeout: 1000 });
            await sleep(800);
            console.log(`  ✓ Closed modal with selector: ${selector}`);
            // Continue to check for more modals
            break;
          }
        } catch {
          // Try next selector
        }
      }

      // Strategy 3: Try clicking by text content (for buttons with just "X")
      try {
        const allButtons = await page.$$('button, [role="button"], a');
        for (const btn of allButtons) {
          const text = await btn.textContent();
          const ariaLabel = await btn.getAttribute('aria-label');
          const className = await btn.getAttribute('class') || '';
          
          if ((text && (text.trim() === '×' || text.trim() === '✕' || text.trim() === 'X')) ||
              (ariaLabel && ariaLabel.toLowerCase().includes('close')) ||
              (className.toLowerCase().includes('close'))) {
            
            const isVisible = await btn.isVisible();
            if (isVisible) {
              await btn.click({ force: true });
              await sleep(800);
              console.log('  ✓ Closed modal by text/aria-label');
              break;
            }
          }
        }
      } catch {
        // Continue
      }

      // Strategy 4: Click overlay/backdrop to close
      try {
        const overlay = page.locator('[class*="overlay"], [class*="backdrop"], [class*="scrim"], [class*="modal-backdrop"]').first();
        if (await overlay.isVisible({ timeout: 500 })) {
          await overlay.click({ force: true, position: { x: 10, y: 10 } });
          await sleep(800);
          console.log('  ✓ Closed by clicking overlay');
        }
      } catch {
        // Overlay click didn't work
      }

      // Wait before next attempt
      if (attempt < maxAttempts - 1) {
        await sleep(500);
      }
    }

    console.log('  ✓ Modal check complete');
  } catch (error) {
    console.log(`  ⚠ Modal detection error: ${error}`);
  }
}

/**
 * Select a product variant if available (size, color, etc)
 */
async function selectVariantIfNeeded(page: Page, shopifyInfo?: ShopifyInfo | null): Promise<void> {
  try {
    console.log('  Checking for product variants (size, color)...');
    
    // Wait for variant selectors to load
    await sleep(1000);
    
    // If Shopify, try Shopify-specific variant selectors first
    if (shopifyInfo?.isShopify && shopifyInfo.selectors) {
      const shopifySelectors = shopifyInfo.selectors.variantSelector;
      for (const selector of shopifySelectors) {
        try {
          const variantElement = page.locator(selector).first();
          if (await variantElement.isVisible({ timeout: 1000 })) {
            // Check if it's a select dropdown
            const tagName = await variantElement.evaluate(el => el.tagName);
            if (tagName === 'SELECT') {
              const options = await variantElement.locator('option').count();
              if (options > 1) {
                await variantElement.selectOption({ index: 1 });
                await sleep(800);
                console.log(`  ✓ Selected Shopify variant (dropdown)`);
                return;
              }
            } else {
              // It's a button or input
              const isDisabled = await variantElement.isDisabled().catch(() => false);
              if (!isDisabled) {
                await variantElement.click();
                await sleep(800);
                console.log(`  ✓ Selected Shopify variant (button)`);
                return;
              }
            }
          }
        } catch {
          // Try next selector
        }
      }
    }
    
    const urlBefore = page.url();
    
    // PRIORITY 1: Shopify variant radio inputs (most reliable for Shopify)
    try {
      const variantRadios = page.locator('input[type="radio"][name*="ize"], input[type="radio"][name*="Size"], input[type="radio"][data-option*="size"]');
      const radioCount = await variantRadios.count();
      
      if (radioCount > 0) {
        console.log(`  Found ${radioCount} Shopify size radio inputs`);
        for (let i = 0; i < Math.min(radioCount, 5); i++) {
          const radio = variantRadios.nth(i);
          const isDisabled = await radio.isDisabled().catch(() => false);
          const isVisible = await radio.isVisible().catch(() => true); // Radios often hidden
          
          if (!isDisabled) {
            // Click the label (for hidden radios) or the radio itself
            const radioId = await radio.getAttribute('id').catch(() => null);
            if (radioId) {
              const label = page.locator(`label[for="${radioId}"]`).first();
              if (await label.isVisible({ timeout: 500 }).catch(() => false)) {
                await label.click({ force: true });
                await sleep(1000);
                const urlAfter = page.url();
                if (urlAfter !== urlBefore && urlAfter.includes('variant=')) {
                  console.log(`  ✓ Selected Shopify size via label (option ${i + 1})`);
                  return;
                }
              }
            }
            // Direct click on radio
            await radio.click({ force: true });
            await sleep(1000);
            const urlAfter = page.url();
            if (urlAfter !== urlBefore && urlAfter.includes('variant=')) {
              console.log(`  ✓ Selected Shopify size via radio (option ${i + 1})`);
              return;
            }
          }
        }
      }
    } catch (e) {
      console.log(`  Shopify radio selection error: ${e}`);
    }
    
    // PRIORITY 2: Shopify variant buttons with data attributes
    try {
      const shopifyVariantSelectors = [
        'button[data-value]', // Common Shopify pattern
        'button[data-variant-id]',
        '[data-option-index] button',
        'fieldset button',
        '.variant-input button',
        '.product-form__input button'
      ];
      
      for (const selector of shopifyVariantSelectors) {
        const buttons = page.locator(selector);
        const count = await buttons.count();
        
        if (count > 0) {
          console.log(`  Found ${count} variant buttons via ${selector}`);
          for (let i = 0; i < Math.min(count, 5); i++) {
            const btn = buttons.nth(i);
            const isDisabled = await btn.isDisabled().catch(() => false);
            const isVisible = await btn.isVisible().catch(() => false);
            const ariaChecked = await btn.getAttribute('aria-checked').catch(() => null);
            
            // Skip already selected buttons
            if (ariaChecked === 'true') continue;
            
            if (isVisible && !isDisabled) {
              await btn.click({ force: true });
              await sleep(1000);
              const urlAfter = page.url();
              if (urlAfter.includes('variant=') && !urlAfter.endsWith('variant=')) {
                console.log(`  ✓ Selected Shopify variant via ${selector} (option ${i + 1})`);
                return;
              }
            }
          }
        }
      }
    } catch (e) {
      console.log(`  Shopify button selection error: ${e}`);
    }
    
    // PRIORITY 3: Generic size button selectors
    const sizeSelectors = [
      'button[class*="size"]',
      '[data-attribute="size"] button',
      '[data-option="size"] button',
      'button[aria-label*="size"]',
      '[class*="size-selector"] button',
      '[class*="size-option"]',
      'button:has-text("S"), button:has-text("M"), button:has-text("L"), button:has-text("XL")'
    ];
    
    for (const selector of sizeSelectors) {
      try {
        const sizeButtons = page.locator(selector);
        const count = await sizeButtons.count();
        
        if (count > 0) {
          // Try to find an available size (not disabled)
          for (let i = 0; i < Math.min(count, 5); i++) {
            const btn = sizeButtons.nth(i);
            const isDisabled = await btn.isDisabled().catch(() => false);
            const isVisible = await btn.isVisible().catch(() => false);
            
            if (isVisible && !isDisabled) {
              await btn.click({ force: true });
              await sleep(1000);
              const urlAfter = page.url();
              console.log(`  ✓ Selected size variant (option ${i + 1})`);
              // If URL now has variant, we succeeded
              if (urlAfter.includes('variant=') && !urlAfter.endsWith('variant=')) {
                return;
              }
              // Continue even without URL change - might still work
              return;
            }
          }
        }
      } catch {
        // Try next selector
      }
    }
    
    // Strategy 2: Look for variant selectors (size, color, etc) - dropdowns
    const selectElements = await page.locator('select').count();
    if (selectElements > 0) {
      for (let i = 0; i < selectElements; i++) {
        const select = page.locator('select').nth(i);
        const options = await select.locator('option').count();
        
        if (options > 1) {
          // Check if this is a size selector (common patterns)
          const selectName = await select.getAttribute('name').catch(() => '');
          const selectId = await select.getAttribute('id').catch(() => '');
          const selectClass = await select.getAttribute('class').catch(() => '');
          const isSizeSelector = 
            selectName?.toLowerCase().includes('size') ||
            selectId?.toLowerCase().includes('size') ||
            selectClass?.toLowerCase().includes('size') ||
            selectName?.toLowerCase().includes('variant') ||
            selectId?.toLowerCase().includes('variant');
          
          // Prioritize size selectors
          if (isSizeSelector || i === 0) {
            try {
              // Try to select first available option (skip placeholder)
              // Look for options that aren't disabled and have a value
              const availableOptions = await select.evaluate((sel: HTMLSelectElement) => {
                return Array.from(sel.options)
                  .map((opt, idx) => ({ idx, value: opt.value, text: opt.text, disabled: opt.disabled }))
                  .filter(opt => opt.value && !opt.disabled && opt.text.toLowerCase() !== 'select' && !opt.text.toLowerCase().includes('choose'))
                  .slice(0, 3); // Get first 3 available
              });
              
              if (availableOptions.length > 0) {
                await select.selectOption({ index: availableOptions[0].idx });
                await sleep(1000);
                console.log(`  ✓ Selected size/variant: "${availableOptions[0].text}"`);
                return;
              } else {
                // Fallback to second option
                await select.selectOption({ index: 1 });
                await sleep(1000);
                console.log(`  ✓ Selected variant from dropdown ${i + 1}`);
                return;
              }
            } catch {
              // Try next select
            }
          }
        }
      }
      
      // If no size selector found, try any select with options
      for (let i = 0; i < selectElements; i++) {
        const select = page.locator('select').nth(i);
        const options = await select.locator('option').count();
        
        if (options > 1) {
          try {
            await select.selectOption({ index: 1 });
            await sleep(1000);
            console.log(`  ✓ Selected variant from dropdown ${i + 1}`);
            return;
          } catch {
            // Try next select
          }
        }
      }
    }
    
    // Strategy 3: Look for color/variant buttons
    const variantSelectors = [
      '[data-variant]',
      '[class*="variant"] button',
      '[class*="color"] button',
      '[data-attribute="color"] button'
    ];
    
    for (const selector of variantSelectors) {
      try {
        const variantButtons = page.locator(selector);
        const count = await variantButtons.count();
        
        if (count > 0) {
          const firstButton = variantButtons.first();
          const isDisabled = await firstButton.isDisabled().catch(() => false);
          const isVisible = await firstButton.isVisible().catch(() => false);
          
          if (isVisible && !isDisabled) {
            await firstButton.click();
            await sleep(800);
            console.log(`  ✓ Selected variant`);
            return;
          }
        }
      } catch {
        // Try next selector
      }
    }
    
    console.log('  ⚠ No variants found or already selected');
  } catch (error) {
    console.log(`  ⚠ Variant selection failed: ${error}`);
  }
}

/**
 * Shopify-specific add to cart (uses form submission)
 */
async function addToCartShopify(page: Page, shopifyInfo: ShopifyInfo): Promise<boolean> {
  try {
    console.log('  🛍️ Using Shopify-specific add to cart...');
    
    // First, check if a variant is selected (URL should have variant ID)
    const currentUrl = page.url();
    const hasValidVariant = currentUrl.includes('variant=') && !currentUrl.endsWith('variant=');
    
    if (!hasValidVariant) {
      console.log('  ⚠ No variant selected - attempting to select one...');
      
      // Try to select a variant using the dropdown in the form
      const variantSelect = page.locator('select[name*="id"], select[name="id"]').first();
      if (await variantSelect.isVisible({ timeout: 1000 })) {
        const options = await variantSelect.locator('option').count();
        if (options > 1) {
          await variantSelect.selectOption({ index: 1 });
          await sleep(1000);
          console.log('  ✓ Selected Shopify variant from dropdown');
        }
      }
      
      // Also try clicking size buttons directly
      const sizeButtons = page.locator('button[data-value], fieldset button, .product-form__input button').all();
      const buttons = await sizeButtons;
      for (const btn of buttons.slice(0, 3)) {
        const isDisabled = await btn.isDisabled().catch(() => false);
        const isVisible = await btn.isVisible().catch(() => false);
        if (isVisible && !isDisabled) {
          await btn.click({ force: true });
          await sleep(800);
          console.log('  ✓ Clicked size button in Shopify form');
          break;
        }
      }
    }
    
    // Shopify typically uses form submissions
    const productForm = page.locator(shopifyInfo.selectors.productForm[0] || 'form[action*="/cart/add"]').first();
    
    if (await productForm.isVisible({ timeout: 2000 })) {
      // Submit the form - find the add button
      const submitButton = productForm.locator(
        'button[type="submit"], button[name="add"], [data-add-to-cart], button:has-text("Add to"), button:has-text("ADD TO")'
      ).first();
      
      if (await submitButton.isVisible({ timeout: 1000 })) {
        const buttonText = await submitButton.textContent().catch(() => 'unknown');
        const isEnabled = await submitButton.isEnabled();
        
        if (!isEnabled) {
          console.log(`  ⚠ Add button "${buttonText}" is DISABLED - variant may not be selected`);
          // Try one more variant selection attempt
          const radioInputs = page.locator('input[type="radio"]').all();
          const radios = await radioInputs;
          for (const radio of radios.slice(0, 3)) {
            try {
              await radio.click({ force: true });
              await sleep(500);
            } catch {}
          }
          await sleep(1000);
        }
        
        // Check again if enabled
        const isNowEnabled = await submitButton.isEnabled();
        if (isNowEnabled) {
          await submitButton.click({ force: true });
          await sleep(3000); // Wait for cart drawer/modal
          
          // Verify cart drawer appeared or cart count changed
          const drawerVisible = await page.locator('[class*="cart-drawer"], [class*="drawer"][class*="open"], [data-cart-drawer]').isVisible({ timeout: 2000 }).catch(() => false);
          
          if (drawerVisible) {
            console.log('  ✓ Added to cart via Shopify form - drawer opened!');
            return true;
          } else {
            console.log('  ✓ Clicked add to cart (no drawer visible, may still have worked)');
            return true;
          }
        } else {
          console.log(`  ✗ Add button still disabled after variant attempts`);
        }
      }
    }
    
    // Try Shopify-specific button selectors
    for (const selector of shopifyInfo.selectors.addToCart) {
      try {
        const button = page.locator(selector).first();
        if (await button.isVisible({ timeout: 1000 })) {
          const isEnabled = await button.isEnabled();
          if (isEnabled) {
            await button.click({ force: true });
            await sleep(3000);
            console.log(`  ✓ Added to cart via Shopify selector: ${selector}`);
            return true;
          }
        }
      } catch {
        // Try next selector
      }
    }
    
    return false;
  } catch (error) {
    console.log(`  ⚠ Shopify add to cart failed: ${error}`);
    return false;
  }
}

/**
 * Add product to cart with better detection
 */
async function addToCart(page: Page, shopifyInfo?: ShopifyInfo | null): Promise<void> {
  try {
    console.log('🛒 Attempting to add product to cart...');
    
    // Wait for product page to fully load
    await sleep(2000);
    
    // Close any open modals first
    await closeModals(page);
    await sleep(500);
    
    // Make sure modals are closed (cookies, country selection)
    await closeModals(page);
    await sleep(500);
    
    // Select variant first (size, color, etc) - required for many sites like Gymshark
    await selectVariantIfNeeded(page, shopifyInfo);
    await sleep(2000); // Wait longer for variant selection to enable add to cart button
    
    // If Shopify, try Shopify-specific methods first
    if (shopifyInfo?.isShopify && shopifyInfo.selectors) {
      const success = await addToCartShopify(page, shopifyInfo);
      if (success) return;
    }

    // Strategy 1: Look for "Add to cart" button with various text patterns
    const buttonTexts = [
      'Add to bag',
      'ADD TO BAG',
      'Add To Bag',
      'Add to cart',
      'ADD TO CART',
      'Add To Cart',
      'Add item to cart',
      'Add item',
      'Add to Cart',
      'Buy now',
      'BUY NOW'
    ];

    for (const buttonText of buttonTexts) {
      try {
        const button = page.locator(`button:has-text("${buttonText}")`).first();
        const isVisible = await button.isVisible({ timeout: 2000 });
        
        if (isVisible) {
          const isEnabled = await button.isEnabled();
          
          if (isEnabled) {
            await button.click({ force: true });
            await sleep(3000); // Wait longer for drawer/modal to appear
            console.log(`  ✓ Clicked "Add to cart" button: "${buttonText}"`);
            return;
          } else {
            console.log(`  ⚠ Button "${buttonText}" found but disabled (may need variant selection)`);
          }
        }
      } catch {
        // Continue to next button text
      }
    }

    // Strategy 2: Look for button with cart-related classes and attributes
    try {
      const cartButtons = [
        'button[class*="add-to-cart"]',
        'button[class*="addToCart"]',
        'button[class*="add-to-bag"]',
        'button[data-action*="cart"]',
        'button[data-action*="add"]',
        'button[aria-label*="cart"]',
        'button[aria-label*="bag"]',
        '[data-testid*="add-to-cart"]',
        '[data-testid*="add-to-bag"]',
        'form button[type="submit"]', // Some sites use form submit
        'button[type="submit"]' // Generic submit button on product page
      ];

      for (const selector of cartButtons) {
        try {
          const button = page.locator(selector).first();
          const isVisible = await button.isVisible({ timeout: 2000 });
          
          if (isVisible) {
            const isEnabled = await button.isEnabled();
            
            if (isEnabled) {
              await button.click({ force: true });
              await sleep(3000);
              console.log(`  ✓ Clicked add-to-cart button via selector: ${selector}`);
              return;
            } else {
              console.log(`  ⚠ Button found but disabled: ${selector}`);
            }
          }
        } catch {
          // Try next selector
        }
      }
    } catch {
      console.log('  Class-based selectors failed');
    }

    // Strategy 3: Look for any button on product page that's likely "add to cart"
    try {
      // Wait a bit more for buttons to be enabled after variant selection
      await sleep(1000);
      
      const buttons = await page.locator('button').all();
      console.log(`  Found ${buttons.length} buttons on page, checking for add to cart...`);
      
      for (const btn of buttons) {
        try {
          const text = await btn.textContent();
          const lowerText = (text || '').toLowerCase().trim();
          
          // More patterns to match
          if ((lowerText.includes('add') && (lowerText.includes('cart') || lowerText.includes('bag'))) ||
              lowerText === 'add item' ||
              lowerText === 'add to cart' ||
              lowerText === 'add to bag' ||
              (lowerText.includes('buy') && lowerText.includes('now'))) {
            
            const isVisible = await btn.isVisible();
            const isEnabled = await btn.isEnabled();
            
            if (isVisible && isEnabled) {
              await btn.click({ force: true });
              await sleep(3000);
              console.log(`  ✓ Clicked button: "${text}"`);
              return;
            } else if (isVisible) {
              console.log(`  ⚠ Found button "${text}" but it's disabled`);
            }
          }
        } catch {
          // Skip this button
        }
      }
    } catch (error) {
      console.log(`  Button enumeration failed: ${error}`);
    }
    
    // Strategy 4: Try clicking the largest/primary button on the page (often the add to cart)
    try {
      const primaryButtons = page.locator('button[class*="primary"], button[class*="main"], button[class*="large"]');
      const count = await primaryButtons.count();
      
      if (count > 0) {
        for (let i = 0; i < count; i++) {
          const btn = primaryButtons.nth(i);
          const isVisible = await btn.isVisible();
          const isEnabled = await btn.isEnabled();
          
          if (isVisible && isEnabled) {
            const text = await btn.textContent();
            console.log(`  Trying primary button: "${text}"`);
            await btn.click({ force: true });
            await sleep(3000);
            console.log(`  ✓ Clicked primary button`);
            return;
          }
        }
      }
    } catch {
      console.log('  Primary button strategy failed');
    }
    
    throw new Error('Could not find add to cart button');
  } catch (error) {
    console.log(`  ✗ Error adding to cart: ${error}`);
    throw error;
  }
}

/**
 * Go to the cart drawer (open side panel after add-to-cart)
 */
async function goToCartDrawer(page: Page, shopifyInfo?: ShopifyInfo | null): Promise<void> {
  try {
    console.log('Looking for cart drawer/side panel...');
    
    // Comprehensive drawer selectors - prioritized for common patterns
    const drawerSelectors = [
      // Most common Shopify drawer patterns
      '[class*="cart-drawer"]',
      '[class*="drawer"][class*="cart"]',
      '[class*="cart"][class*="slide"]',
      '[class*="side-cart"]',
      '[class*="mini-cart"]',
      '[data-cart-drawer]',
      '#CartDrawer',
      'aside[class*="cart"]',
      // Active/open states
      '[class*="drawer"][class*="open"]',
      '[class*="drawer"][class*="active"]',
      '[class*="drawer"][class*="visible"]',
      '[class*="cart"][class*="open"]',
      // Dialog/panel patterns
      '[role="dialog"][class*="cart"]',
      'div[class*="cart"][class*="panel"]',
      '[class*="bag"][class*="drawer"]',
      // Right-side panels
      '[class*="right"][class*="drawer"]',
      '[class*="drawer--right"]'
    ];
    
    // First, check if drawer is already open (from add-to-cart action)
    for (const selector of drawerSelectors) {
      try {
        const drawer = page.locator(selector).first();
        if (await drawer.isVisible({ timeout: 500 })) {
          // Verify drawer has content (not just empty container)
          const hasContent = await drawer.locator('img, [class*="item"], [class*="product"], [class*="title"]').first().isVisible({ timeout: 500 }).catch(() => false);
          if (hasContent) {
            console.log(`  ✓ Cart drawer with content found: ${selector}`);
            await sleep(1000);
            return;
          }
        }
      } catch {
        // Continue checking
      }
    }
    
    // Wait a bit longer and check again (drawer animation)
    await sleep(1500);
    
    for (const selector of drawerSelectors) {
      try {
        const drawer = page.locator(selector).first();
        if (await drawer.isVisible({ timeout: 500 })) {
          console.log(`  ✓ Cart drawer is open: ${selector}`);
          await sleep(500);
          return;
        }
      } catch {}
    }
    
    // Drawer not visible - need to click cart icon to open it
    console.log('  Drawer not open, clicking cart icon...');
    
    const cartIconSelectors = [
      'button[aria-label*="cart" i]',
      'button[aria-label*="bag" i]',
      'a[aria-label*="cart" i]',
      'header a[href="/cart"]',
      'header button[class*="cart"]',
      '[class*="header"] [class*="cart-icon"]',
      '[class*="header"] [class*="bag-icon"]',
      '[data-cart-toggle]',
      '[data-cart-icon]',
      'button[class*="cart"]',
      '[class*="cart-count"]'
    ];
    
    for (const iconSelector of cartIconSelectors) {
      try {
        const cartIcon = page.locator(iconSelector).first();
        if (await cartIcon.isVisible({ timeout: 800 })) {
          console.log(`  Clicking: ${iconSelector}`);
          await cartIcon.click();
          await sleep(2000); // Wait for drawer animation
          
          // Verify drawer opened
          for (const drawerSel of drawerSelectors.slice(0, 5)) {
            try {
              const drawer = page.locator(drawerSel).first();
              if (await drawer.isVisible({ timeout: 1000 })) {
                console.log(`  ✓ Opened cart drawer by clicking ${iconSelector}`);
                await sleep(500);
                return;
              }
            } catch {}
          }
        }
      } catch {
        // Try next icon
      }
    }
    
    // Shopify-specific fallback
    if (shopifyInfo?.isShopify) {
      for (const selector of shopifyInfo.selectors.cartIcon) {
        try {
          const cartIcon = page.locator(selector).first();
          if (await cartIcon.isVisible({ timeout: 1000 })) {
            await cartIcon.click();
            await sleep(2500);
            console.log(`  ✓ Opened Shopify cart drawer via ${selector}`);
            return;
          }
        } catch {}
      }
    }
    
    console.log('  ⚠ Could not detect/open cart drawer - taking screenshot anyway');
  } catch (error) {
    console.log(`  ⚠ Cart drawer error: ${error}`);
  }
}

/**
 * Navigate to the full cart page (view cart)
 * Returns true if successfully navigated to cart page, false if drawer-only cart
 */
async function goToCartPage(page: Page, shopifyInfo?: ShopifyInfo | null): Promise<boolean> {
  try {
    console.log('🛒 Navigating to full cart page...');
    
    const urlBefore = page.url();
    
    // Strategy 1: Try navigating to /cart directly first (most reliable)
    try {
      const currentUrl = new URL(page.url());
      const cartUrl = `${currentUrl.origin}/cart`;
      const response = await page.goto(cartUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(2000);
      
      const urlAfter = page.url();
      // Check if we successfully reached cart (not redirected back to homepage or product page)
      if (urlAfter.includes('/cart') && !urlAfter.includes('/products/')) {
        console.log('  ✓ Navigated to cart page (/cart)');
        await sleep(2000); // Extra wait for cart content to load
        return true;
      } else if (urlAfter === urlBefore || urlAfter.includes('/products/')) {
        console.log(`  ⚠ /cart redirected back to: ${urlAfter}`);
        // This site might use drawer-only cart
      }
    } catch (e) {
      console.log(`  /cart navigation error: ${e}`);
    }
    
    // Strategy 2: Look for "View Cart" button in drawer and click it
    const viewCartButtons = [
      'button:has-text("View Cart")',
      'button:has-text("VIEW CART")',
      'a:has-text("View Cart")',
      'a:has-text("VIEW CART")',
      'a:has-text("Go to Cart")',
      'button:has-text("Go to Cart")',
      'button:has-text("View Bag")',
      'a:has-text("View Bag")'
    ];

    for (const selector of viewCartButtons) {
      try {
        const button = page.locator(selector).first();
        if (await button.isVisible({ timeout: 2000 })) {
          const urlBeforeClick = page.url();
          await button.click();
          await sleep(4000);
          
          const urlAfterClick = page.url();
          if (urlAfterClick !== urlBeforeClick && (urlAfterClick.includes('/cart') || urlAfterClick.includes('/bag'))) {
            console.log(`  ✓ Clicked "${selector}" - navigated to: ${urlAfterClick}`);
            return true;
          } else {
            console.log(`  Clicked "${selector}" but URL unchanged (drawer-only cart)`);
          }
        }
      } catch {
        // Try next selector
      }
    }

    // Strategy 3: Try other common cart URLs
    try {
      const currentUrl = new URL(page.url());
      const commonCartUrls = [
        `${currentUrl.origin}/bag`,
        `${currentUrl.origin}/basket`,
        `${currentUrl.origin}/shopping-bag`
      ];
      
      for (const cartUrl of commonCartUrls) {
        try {
          const response = await page.goto(cartUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
          if (response && response.ok()) {
            await sleep(2000);
            const finalUrl = page.url();
            if (finalUrl.includes('/bag') || finalUrl.includes('/basket')) {
              console.log(`  ✓ Navigated to cart via: ${cartUrl}`);
              return true;
            }
          }
        } catch {
          // Try next URL
        }
      }
    } catch {
      // Continue
    }

    // If we get here, this is likely a drawer-only cart
    console.log('  ℹ This site uses drawer-only cart (no separate cart page)');
    
    // Go back to where we were (in case navigation attempts changed page)
    if (page.url() !== urlBefore) {
      try {
        await page.goto(urlBefore, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await sleep(2000);
      } catch {
        // Continue
      }
    }
    
    // Re-open the cart drawer for screenshot
    await goToCartDrawer(page, shopifyInfo);
    await sleep(2000);
    
    return false; // Indicates drawer-only cart
  } catch (error) {
    console.log(`  ✗ Error navigating to cart: ${error}`);
    return false;
  }
}

/**
 * Try to click checkout button inside the cart drawer
 * Returns true if checkout was initiated from drawer, false otherwise
 */
async function clickCheckoutFromDrawer(page: Page, shopifyInfo?: ShopifyInfo | null): Promise<boolean> {
  try {
    console.log('  Looking for checkout button in drawer...');
    
    // Get URL before attempting checkout
    const urlBefore = page.url();
    
    // Look for drawer/modal containers
    const drawerSelectors = [
      '[class*="drawer"][class*="cart"]',
      '[class*="cart-drawer"]',
      '[class*="cart"][class*="modal"]',
      '#CartDrawer',
      '[data-cart-drawer]',
      '[class*="drawer"][class*="open"]',
      '[class*="modal"][class*="open"]',
      '[class*="side-cart"]',
      '[class*="mini-cart"]',
      '[class*="flyout"]',
      '[class*="cart"][class*="flyout"]'
    ];
    
    for (const drawerSelector of drawerSelectors) {
      try {
        const drawer = page.locator(drawerSelector).first();
        if (await drawer.isVisible({ timeout: 1000 })) {
          console.log(`  Found drawer: ${drawerSelector}`);
          
          // Look for checkout button inside the drawer
          const checkoutButtonSelectors = [
            'button:has-text("Checkout")',
            'button:has-text("CHECKOUT")',
            'button:has-text("Check out")',
            'button:has-text("CHECK OUT")',
            'a:has-text("Checkout")',
            'a:has-text("CHECKOUT")',
            'button[name="checkout"]',
            'a[href*="/checkout"]',
            '[class*="checkout"]',
            'form[action*="/checkout"] button',
            'button:has-text("Proceed")',
            'button:has-text("PROCEED")'
          ];
          
          for (const btnSelector of checkoutButtonSelectors) {
            try {
              // Look for button specifically inside the drawer
              const checkoutBtn = drawer.locator(btnSelector).first();
              if (await checkoutBtn.isVisible({ timeout: 1500 })) {
                const isEnabled = await checkoutBtn.isEnabled().catch(() => true);
                if (isEnabled) {
                  console.log(`  ✓ Found checkout button in drawer: ${btnSelector}`);
                  await checkoutBtn.click({ force: true });
                  await sleep(4000); // Wait for checkout to load
                  
                  // Check if URL changed (indicating successful checkout navigation)
                  const urlAfter = page.url();
                  if (urlAfter !== urlBefore && (urlAfter.includes('/checkout') || urlAfter.includes('/checkouts'))) {
                    console.log(`  ✓ Successfully navigated to checkout from drawer!`);
                    return true;
                  } else if (urlAfter !== urlBefore) {
                    console.log(`  ✓ URL changed after drawer checkout: ${urlAfter}`);
                    return true;
                  } else {
                    console.log(`  ⚠ Clicked checkout but URL didn't change, trying again...`);
                    // Try clicking again with different approach
                    await checkoutBtn.click({ force: true, timeout: 2000 });
                    await sleep(4000);
                    const urlAfterRetry = page.url();
                    if (urlAfterRetry !== urlBefore) {
                      console.log(`  ✓ Second click worked! URL: ${urlAfterRetry}`);
                      return true;
                    }
                  }
                }
              }
            } catch {
              // Try next selector
            }
          }
        }
      } catch {
        // Try next drawer selector
      }
    }
    
    // Also try finding checkout button globally (not just in drawer)
    // Some sites have checkout visible but not in a specific drawer container
    const globalCheckoutSelectors = [
      'button:has-text("Checkout"):visible',
      'a:has-text("Checkout"):visible',
      'button[name="checkout"]:visible',
      '[class*="checkout-button"]:visible'
    ];
    
    for (const selector of globalCheckoutSelectors) {
      try {
        const btn = page.locator(selector).first();
        if (await btn.isVisible({ timeout: 1000 })) {
          console.log(`  Found global checkout button: ${selector}`);
          await btn.click({ force: true });
          await sleep(4000);
          
          const urlAfter = page.url();
          if (urlAfter !== urlBefore) {
            console.log(`  ✓ Global checkout click worked! URL: ${urlAfter}`);
            return true;
          }
        }
      } catch {
        // Continue
      }
    }
    
    console.log('  ⚠ Could not find checkout button in drawer');
    return false;
  } catch (error) {
    console.log(`  ⚠ Drawer checkout error: ${error}`);
    return false;
  }
}

/**
 * Click checkout button to start checkout
 */
async function clickCheckoutButton(page: Page, shopifyInfo?: ShopifyInfo | null): Promise<void> {
  try {
    console.log('🔘 Looking for Checkout button...');
    
    const urlBefore = page.url();
    
    // PRIORITY 1: Try checkout from drawer first (for drawer-only carts like Hera)
    const drawerSuccess = await clickCheckoutFromDrawer(page, shopifyInfo);
    if (drawerSuccess) {
      // Verify we actually reached checkout
      await sleep(2000);
      const currentUrl = page.url();
      if (currentUrl.includes('/checkout') || currentUrl.includes('/checkouts') || currentUrl !== urlBefore) {
        return;
      }
    }
    
    // PRIORITY 2: If Shopify, try Shopify-specific checkout button selectors
    if (shopifyInfo?.isShopify && shopifyInfo.selectors) {
      for (const selector of shopifyInfo.selectors.checkoutButton) {
        try {
          const button = page.locator(selector).first();
          if (await button.isVisible({ timeout: 2000 })) {
            const isEnabled = await button.isEnabled().catch(() => true);
            if (isEnabled) {
              await button.click();
              await sleep(3000);
              const urlAfter = page.url();
              if (urlAfter !== urlBefore) {
                console.log(`  ✓ Clicked Shopify checkout button via ${selector}`);
                return;
              }
            }
          }
        } catch {
          // Try next selector
        }
      }
      
      // PRIORITY 3: Try navigating to /checkout directly (Shopify standard)
      // Only do this if we're on a cart page or if drawer checkout failed
      try {
        const currentUrl = new URL(page.url());
        const checkoutUrl = `${currentUrl.origin}/checkout`;
        const response = await page.goto(checkoutUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000);
        
        // Check if we actually reached checkout (not redirected back)
        const finalUrl = page.url();
        if (finalUrl.includes('/checkout') || finalUrl.includes('/checkouts')) {
          console.log('  ✓ Navigated to Shopify checkout (/checkout)');
          return;
        } else {
          console.log(`  ⚠ /checkout redirected to: ${finalUrl}`);
        }
      } catch {
        // Continue to other strategies
      }
    }
    
    // PRIORITY 4: Generic checkout buttons
    const checkoutButtons = [
      'button:has-text("Checkout")',
      'button:has-text("CHECKOUT")',
      'button:has-text("Check out")',
      'button:has-text("CHECK OUT")',
      'a:has-text("Checkout")',
      'a:has-text("CHECKOUT")',
      'button[class*="checkout"]',
      '[data-testid*="checkout"] button',
      'button:has-text("Proceed to Checkout")',
      'button:has-text("Proceed to checkout")',
      'button:has-text("Secure Checkout")',
      'button:has-text("SECURE CHECKOUT")'
    ];

    for (const selector of checkoutButtons) {
      try {
        const button = page.locator(selector).first();
        const isVisible = await button.isVisible({ timeout: 1500 });
        const isEnabled = await button.isEnabled();
        
        if (isVisible && isEnabled) {
          await button.click({ force: true });
          await sleep(3000);
          const urlAfter = page.url();
          if (urlAfter !== urlBefore) {
            console.log(`  ✓ Clicked Checkout button: ${selector}`);
            return;
          }
        }
      } catch {
        // Try next selector
      }
    }
    
    throw new Error('Checkout button not found');
  } catch (error) {
    console.log(`  ✗ Error clicking checkout: ${error}`);
    throw error;
  }
}

/**
 * Fill shipping/contact information with country-aware address
 */
async function fillShippingInfo(page: Page, config: CheckoutConfig): Promise<void> {
  console.log('Filling shipping information...');
  
  try {
    // First, detect or set country - this determines which address to use
    let selectedCountry = config.country;
    let addressConfig = config;
    
    const countryInput = page.locator('select[name*="country"], input[name*="country"]').first();
    if (await countryInput.isVisible({ timeout: 2000 })) {
      const isSelect = await countryInput.evaluate(el => el.tagName === 'SELECT');
      
      if (isSelect) {
        // Get current selected country
        const currentValue = await countryInput.inputValue();
        if (currentValue) {
          selectedCountry = currentValue.toUpperCase();
        } else {
          // Set country first
          await countryInput.selectOption(config.country);
          await sleep(1000); // Wait for country change to update form
          selectedCountry = config.country.toUpperCase();
        }
      } else {
        await countryInput.fill(config.country);
        await sleep(1000);
        selectedCountry = config.country.toUpperCase();
      }
    }
    
    // Get appropriate address based on selected country
    if (selectedCountry === 'GB' || selectedCountry === 'UK' || selectedCountry.includes('UNITED KINGDOM')) {
      addressConfig = {
        ...config,
        firstName: 'David',
        lastName: 'Thompson',
        email: 'david.thompson@example.co.uk',
        address: '15 Oakwood Road',
        city: 'Manchester',
        state: 'Greater Manchester',
        zip: 'M16 8RA',
        country: 'GB',
        phone: '+44 161 496 0000',
      };
      console.log('  Using UK address');
    } else if (selectedCountry === 'US' || selectedCountry === 'USA' || selectedCountry.includes('UNITED STATES')) {
      addressConfig = {
        ...config,
        firstName: 'Michael',
        lastName: 'Johnson',
        email: 'michael.johnson@example.com',
        address: '456 Elm Avenue',
        city: 'Austin',
        state: 'TX',
        zip: '78701',
        country: 'US',
        phone: '+1 512 555 0198',
      };
      console.log('  Using US address');
    }
    
    // Email
    const emailInput = page.locator('input[type="email"], input[name*="email"]').first();
    if (await emailInput.isVisible()) {
      await emailInput.fill(addressConfig.email);
      await sleep(300);
    }
    
    // First name
    const firstNameInput = page.locator('input[name*="first"], input[name*="fname"]').first();
    if (await firstNameInput.isVisible()) {
      await firstNameInput.fill(addressConfig.firstName);
      await sleep(300);
    }
    
    // Last name
    const lastNameInput = page.locator('input[name*="last"], input[name*="lname"]').first();
    if (await lastNameInput.isVisible()) {
      await lastNameInput.fill(addressConfig.lastName);
      await sleep(300);
    }
    
    // Address
    const addressInput = page.locator('input[name*="address"], input[name*="street"]').first();
    if (await addressInput.isVisible()) {
      await addressInput.fill(addressConfig.address);
      await sleep(300);
    }
    
    // City
    const cityInput = page.locator('input[name*="city"]').first();
    if (await cityInput.isVisible()) {
      await cityInput.fill(addressConfig.city);
      await sleep(300);
    }
    
    // State
    const stateInput = page.locator('input[name*="state"], input[name*="province"], select[name*="state"]').first();
    if (await stateInput.isVisible()) {
      const isSelect = await stateInput.evaluate(el => el.tagName === 'SELECT');
      if (isSelect) {
        await stateInput.selectOption(addressConfig.state);
      } else {
        await stateInput.fill(addressConfig.state);
      }
      await sleep(300);
    }
    
    // ZIP/Postcode
    const zipInput = page.locator('input[name*="zip"], input[name*="postal"], input[name*="postcode"]').first();
    if (await zipInput.isVisible()) {
      await zipInput.fill(addressConfig.zip);
      await sleep(500); // Wait a bit longer for validation
    }
    
    // Phone
    const phoneInput = page.locator('input[type="tel"], input[name*="phone"]').first();
    if (await phoneInput.isVisible()) {
      await phoneInput.fill(addressConfig.phone);
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
      await sleep(4000); // Wait longer for shipping methods to load
      console.log('Advanced to next checkout step');
    }
  } catch (error) {
    console.log('Error filling shipping info:', error);
  }
}

/**
 * Fill payment information (card details)
 */
async function fillPaymentInfo(page: Page, config: CheckoutConfig): Promise<void> {
  try {
    console.log('💳 Filling payment information...');
    
    // Card number
    if (config.cardNumber) {
      const cardInput = page.locator('input[name*="card"], input[name*="number"], input[placeholder*="card"], input[placeholder*="number"]').first();
      if (await cardInput.isVisible({ timeout: 1000 })) {
        await cardInput.fill(config.cardNumber);
        await sleep(300);
      }
    }
    
    // Card holder name
    if (config.cardName) {
      const nameInput = page.locator('input[name*="cardholder"], input[name*="cardname"], input[placeholder*="name on"]').first();
      if (await nameInput.isVisible({ timeout: 1000 })) {
        await nameInput.fill(config.cardName);
        await sleep(300);
      }
    }
    
    // Expiry
    if (config.cardExpiry) {
      const expiryInput = page.locator('input[name*="expiry"], input[name*="exp"], input[placeholder*="MM/YY"]').first();
      if (await expiryInput.isVisible({ timeout: 1000 })) {
        await expiryInput.fill(config.cardExpiry);
        await sleep(300);
      }
    }
    
    // CVV
    if (config.cardCvv) {
      const cvvInput = page.locator('input[name*="cvv"], input[name*="cvc"], input[name*="security"], input[placeholder*="CVV"]').first();
      if (await cvvInput.isVisible({ timeout: 1000 })) {
        await cvvInput.fill(config.cardCvv);
        await sleep(300);
      }
    }
    
    console.log('  ✓ Payment info filled (not submitting)');
  } catch (error) {
    console.log(`  ⚠ Error filling payment info: ${error}`);
  }
}

/**
 * Try to reach payment page without placing order
 */
async function tryReachPayment(page: Page): Promise<void> {
  try {
    console.log('📍 Attempting to advance from shipping to payment...');

    // Strategy 1: Select radio button for shipping method
    try {
      const shippingRadios = await page.locator('input[type="radio"][name*="ship"], input[name*="shipping"]').count();
      
      if (shippingRadios > 0) {
        console.log(`  Found ${shippingRadios} shipping option(s)`);
        const firstOption = page.locator('input[type="radio"][name*="ship"], input[name*="shipping"]').first();
        
        // Check if it's already selected
        const isChecked = await firstOption.isChecked();
        if (!isChecked) {
          await firstOption.click();
          await sleep(800);
          console.log('  ✓ Selected shipping option');
        } else {
          console.log('  ✓ Shipping already selected');
        }
      }
    } catch (error) {
      console.log('  Could not select shipping via radio buttons');
    }

    // Strategy 2: Look for "Continue", "Next", or "Proceed" button
    const buttonTexts = [
      'Continue to Payment',
      'Continue',
      'CONTINUE',
      'Proceed to Payment',
      'Proceed',
      'Next',
      'Next: Payment',
      'Review Order'
    ];

    for (const buttonText of buttonTexts) {
      try {
        const button = page.locator(`button:has-text("${buttonText}")`).first();
        const isVisible = await button.isVisible({ timeout: 1000 });
        
        if (isVisible) {
          await button.click();
          await sleep(2500);
          console.log(`  ✓ Clicked "${buttonText}" button`);
          return;
        }
      } catch {
        // Try next button text
      }
    }

    // Strategy 3: Look for any "Next" type button with broader selectors
    const nextButton = page.locator('button[class*="continue"], button[class*="next"], button[data-action*="continue"]').first();
    if (await nextButton.isVisible({ timeout: 1000 })) {
      await nextButton.click();
      await sleep(2500);
      console.log('  ✓ Clicked next/continue button');
      return;
    }

    console.log('  ⚠ Could not find button to advance to payment (may already be there)');
  } catch (error) {
    console.log(`  ⚠ Error advancing to payment: ${error}`);
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
  console.log(`📸 Capturing stage: ${stageKey}`);
  
  // Log current URL to help debug navigation issues
  const currentUrl = page.url();
  console.log(`  Current URL: ${currentUrl}`);
  
  const screenshotPath = getArtifactPath(jobId, domain, stageKey);
  const screenshotUrl = getArtifactUrl(jobId, domain, stageKey);
  
  try {
    // Use standard viewport size for consistent screenshots
    // Playwright's fullPage: true will handle scrolling automatically
    const viewportWidth = 1440;
    const viewportHeight = 900; // Standard height, fullPage will capture more if needed

    await page.setViewportSize({
      width: viewportWidth,
      height: viewportHeight
    });
    
    console.log(`  Viewport set to: ${viewportWidth}x${viewportHeight} (fullPage will capture entire scrollable area)`);

    // Wait for page to fully load, especially for checkout stages
    if (stageKey === 'checkout_shipping' || stageKey === 'checkout_payment') {
      // Wait for shipping methods or payment options to load
      try {
        await page.waitForSelector('input[type="radio"][name*="ship"], input[name*="shipping"], [class*="shipping"], [class*="payment"]', { 
          timeout: 5000 
        }).catch(() => {});
      } catch {
        // Continue if not found
      }
      await sleep(2000); // Extra wait for dynamic content
    } else if (stageKey === 'view_cart' || stageKey === 'cart') {
      // Wait for cart items to load
      await sleep(2000);
    } else {
      await sleep(500);
    }

    // Close any modals right before screenshot (for homepage and product pages)
    if (stageKey === 'homepage' || stageKey === 'product') {
      await closeModals(page);
      await sleep(300);
    }

    // ALWAYS scroll to very top before capturing (multiple methods for reliability)
    await page.evaluate(() => {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    });
    await sleep(300);
    
    // Double-check scroll position
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(200);

    // Take full-page screenshot
    await page.screenshot({ 
      path: screenshotPath, 
      quality: 70,
      fullPage: true  // Capture entire scrollable page
    });

    console.log(`  ✓ Screenshot saved (full-page)`);
  } catch (error) {
    console.error(`  ✗ Screenshot capture failed: ${error}`);
    throw error;
  }
  
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
 * Uses concurrent browser instances with semaphore-controlled parallelism
 */
export async function runCheckoutJourney(
  domain: string,
  jobId: string,
  config: CheckoutConfig
): Promise<StageResult[]> {
  const stages: StageResult[] = [];
  
  // Acquire a browser slot (waits if at max concurrency)
  await acquireBrowserSlot();
  
  // Create dedicated browser for this audit (enables true parallelism)
  const browser = await createBrowserForAudit();
  console.log(`🌐 Browser launched for ${domain} (job: ${jobId})`);
  
  // Create page with US locale to avoid geo-redirects
  const page = await browser.newPage({
    locale: 'en-US',
    timezoneId: 'America/New_York',
    geolocation: { latitude: 40.7128, longitude: -74.0060 }, // NYC
    permissions: ['geolocation'],
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    }
  });
  
  // Detect Shopify at the start
  let shopifyInfo: ShopifyInfo | null = null;
  
  try {
    const baseUrl = normalizeDomain(domain);
    
    // Stage 0: Summary (captured at the end, but initialized first)
    let summaryStage: StageResult | null = null;
    
    // Stage 1: Homepage
    console.log(`\n📄 Capturing Homepage...`);
    const homepageLoaded = await safeGoto(page, baseUrl);
    if (homepageLoaded) {
      // Detect Shopify after homepage loads
      try {
        shopifyInfo = await detectShopify(page);
        if (shopifyInfo.isShopify) {
          console.log(`\n🛍️  Shopify Store Detected! Theme: ${shopifyInfo.theme || 'Unknown'} (confidence: ${shopifyInfo.confidence}%)`);
        }
      } catch (error) {
        console.log(`⚠ Shopify detection failed: ${error}`);
      }
      // Wait for any delayed popups to appear
      await sleep(2000);
      
      // Close any newsletter/popup modals on homepage (multiple attempts)
      await closeModals(page);
      await sleep(1000);
      
      // Try closing again right before screenshot (popups can reappear)
      await closeModals(page);
      await sleep(500);
      
      try {
        const homeStage = await captureStage(page, jobId, domain, 'homepage');
        stages.push(homeStage);
      } catch (error) {
        console.error(`  ✗ Failed to capture homepage: ${error}`);
      }
    } else {
      throw new Error('Failed to load homepage');
    }
    
    // Stage 2: Product page
    try {
      console.log(`\n📦 Finding and capturing Product page...`);
      const productUrl = await findProductPage(page, domain);
      const navigated = await safeGoto(page, productUrl);
      
      if (!navigated) {
        throw new Error(`Failed to navigate to product page: ${productUrl}`);
      }
      
      // Verify we're actually on the product page
      const currentUrl = page.url();
      if (!currentUrl.includes('/products/') && !currentUrl.includes('/product/')) {
        console.log(`  ⚠ Warning: Expected product page but URL is: ${currentUrl}`);
        // Try navigating again
        await page.goto(productUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await sleep(2000);
      }
      
      // Accept cookies on product page
      await acceptCookies(page);
      await sleep(500);
      
      // Wait for any delayed popups to appear
      await sleep(2000);
      
      // Close any modals that might have appeared (multiple attempts)
      // This will also handle country selection
      await closeModals(page);
      await sleep(1000);
      await closeModals(page);
      await sleep(500);
      
      // Detect Shopify on product page if not already detected
      if (!shopifyInfo) {
        try {
          shopifyInfo = await detectShopify(page);
          if (shopifyInfo.isShopify) {
            console.log(`🛍️  Shopify detected on product page! Theme: ${shopifyInfo.theme || 'Unknown'}`);
          }
        } catch (error) {
          console.log(`⚠ Shopify detection failed: ${error}`);
        }
      }
      
      // Try to select variant (size, color, etc) - REQUIRED before add to cart
      await selectVariantIfNeeded(page, shopifyInfo);
      await sleep(1000); // Wait for variant selection to update button state
      
      const productStage = await captureStage(page, jobId, domain, 'product');
      stages.push(productStage);
    } catch (error) {
      console.error(`  ✗ Failed to capture product page: ${error}`);
    }
    
    // Stage 3: Add to cart
    try {
      console.log(`\n🛒 Adding to cart...`);
      const currentUrlBefore = page.url();
      console.log(`  URL before add to cart: ${currentUrlBefore}`);
      
      await addToCart(page, shopifyInfo);
      
      // Verify we're still on a valid page (not redirected to homepage)
      await sleep(1000);
      const currentUrlAfter = page.url();
      console.log(`  URL after add to cart: ${currentUrlAfter}`);
      
      if (currentUrlAfter === baseUrl || currentUrlAfter === `${baseUrl}/`) {
        console.log(`  ⚠ Warning: Page redirected to homepage after add to cart`);
      }
      
      // DON'T close modals here - cart drawer should stay open for screenshot!
      // The cart drawer opens after add-to-cart and we want to capture it
      await sleep(1500); // Just wait for drawer to fully animate open
    } catch (error) {
      console.error(`  ✗ Failed to add to cart: ${error}`);
      const currentUrl = page.url();
      console.log(`  Current URL after error: ${currentUrl}`);
    }
    
    // Stage 4: Cart drawer (should already be open from add-to-cart)
    try {
      console.log(`\n🛒 Capturing Cart (Drawer)...`);
      await goToCartDrawer(page, shopifyInfo);
      const cartStage = await captureStage(page, jobId, domain, 'cart');
      stages.push(cartStage);
    } catch (error) {
      console.error(`  ✗ Failed to capture cart drawer: ${error}`);
    }
    
    // Stage 5: View Cart page
    let isDrawerOnlyCart = false;
    try {
      console.log(`\n🛒 Navigating to full Cart page...`);
      const navigatedToCart = await goToCartPage(page, shopifyInfo);
      isDrawerOnlyCart = !navigatedToCart;
      
      // Verify where we are
      const currentUrl = page.url();
      console.log(`  Current URL after cart navigation: ${currentUrl}`);
      
      if (isDrawerOnlyCart) {
        console.log(`  ℹ Drawer-only cart detected - will checkout from drawer`);
      }
      
      const viewCartStage = await captureStage(page, jobId, domain, 'view_cart');
      stages.push(viewCartStage);
    } catch (error) {
      console.error(`  ✗ Failed to capture view cart: ${error}`);
      const currentUrl = page.url();
      console.log(`  Current URL after error: ${currentUrl}`);
    }
    
    // Stage 6: Checkout (after clicking Checkout button)
    try {
      console.log(`\n🔘 Clicking Checkout button...`);
      
      // If drawer-only cart, re-open drawer before trying checkout
      if (isDrawerOnlyCart) {
        console.log(`  Re-opening cart drawer for checkout...`);
        await goToCartDrawer(page, shopifyInfo);
        await sleep(1500);
      }
      
      const urlBeforeCheckout = page.url();
      await clickCheckoutButton(page, shopifyInfo);
      
      // Wait for checkout page to load
      await sleep(3000);
      
      const urlAfterCheckout = page.url();
      console.log(`  URL after checkout click: ${urlAfterCheckout}`);
      
      // Verify we actually reached checkout
      if (urlAfterCheckout.includes('/checkout') || urlAfterCheckout.includes('/checkouts')) {
        console.log(`  ✓ Successfully reached checkout!`);
      } else if (urlAfterCheckout === urlBeforeCheckout) {
        console.log(`  ⚠ URL unchanged after checkout click - may need different approach`);
      }
      
      const checkoutStage = await captureStage(page, jobId, domain, 'checkout');
      stages.push(checkoutStage);
    } catch (error) {
      console.error(`  ✗ Failed to capture checkout: ${error}`);
    }
    
    // Stage 7: Checkout - Contact info
    try {
      console.log(`\n✉️ Entering contact info...`);
      await fillShippingInfo(page, config);
      
      // Give page time to update and validate
      await sleep(3000);
      const contactStage = await captureStage(page, jobId, domain, 'checkout_contact');
      stages.push(contactStage);
    } catch (error) {
      console.error(`  ✗ Failed to capture checkout contact: ${error}`);
    }
    
    // Stage 8: Checkout - Shipping (MOST IMPORTANT - EDD appears here)
    try {
      console.log(`\n📍 Capturing Checkout Shipping page (EDD detection)...`);
      // Wait for shipping methods to load
      await sleep(3000);
      const shippingStage = await captureStage(page, jobId, domain, 'checkout_shipping');
      stages.push(shippingStage);
    } catch (error) {
      console.error(`  ✗ Failed to capture checkout shipping: ${error}`);
    }
    
    // Stage 9: Checkout - Payment (STOP HERE - DO NOT PLACE ORDER)
    try {
      console.log(`\n💳 Reaching Payment page...`);
      await tryReachPayment(page);
      await sleep(3000); // Wait for payment page to fully load
      
      // Fill payment info (but don't submit)
      await fillPaymentInfo(page, config);
      await sleep(1500);
      
      const paymentStage = await captureStage(page, jobId, domain, 'checkout_payment');
      stages.push(paymentStage);
    } catch (error) {
      console.error(`  ✗ Failed to capture checkout payment: ${error}`);
    }
    
    // Create summary stage - will be inserted at beginning
    if (stages.length > 0) {
      // Use homepage screenshot for summary, or first available
      const homepageStage = stages.find(s => s.key === 'homepage');
      const summaryScreenshot = homepageStage?.screenshotUrl || stages[0]?.screenshotUrl || '';
      
      summaryStage = {
        key: 'summary',
        url: baseUrl,
        screenshotUrl: summaryScreenshot,
        notes: [
          `✅ Full checkout journey captured for ${domain}`,
          `📸 ${stages.length} stages documented`,
          `🎯 Ready for analysis and feature detection`
        ],
        detections: {
          edd: { present: false, confidence: 0, evidence: [] },
          upsells: { present: false, confidence: 0, evidence: [] },
          fstBar: { present: false, confidence: 0, evidence: [] },
          shippingAddon: { present: false, confidence: 0, evidence: [] },
          trustBadges: { present: false, confidence: 0, evidence: [] }
        },
        extractedSnippets: []
      };
      // Insert summary at the beginning
      stages.unshift(summaryStage);
    }
    
    console.log(`\n✅ Checkout journey completed successfully for ${domain}!`);
    return stages;
  } catch (error) {
    console.error(`❌ Error during checkout journey for ${domain}:`, error);
    // Return whatever stages we captured before the error
    return stages;
  } finally {
    // Clean up: close page and browser, release semaphore slot
    try {
      await page.close();
      await browser.close();
      console.log(`🔴 Browser closed for ${domain}`);
    } catch (closeError) {
      console.error(`Error closing browser for ${domain}:`, closeError);
    }
    releaseBrowserSlot();
  }
}

/**
 * Close legacy global browser on shutdown (if used)
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

/**
 * Get current concurrency status (for monitoring)
 */
export function getConcurrencyStatus(): { active: number; max: number; queued: number } {
  return {
    active: activeBrowserCount,
    max: MAX_CONCURRENT_BROWSERS,
    queued: browserQueue.length
  };
}

