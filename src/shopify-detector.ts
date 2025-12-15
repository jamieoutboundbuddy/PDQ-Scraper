/**
 * Shopify platform and theme detection
 * Detects Shopify stores and identifies themes for better selector matching
 */

import { Page } from 'playwright';

export interface ShopifyInfo {
  isShopify: boolean;
  theme?: string;
  themeId?: string;
  confidence: number;
  selectors: ShopifySelectors;
}

export interface ShopifySelectors {
  addToCart: string[];
  variantSelector: string[];
  cartDrawer: string[];
  cartIcon: string[];
  checkoutButton: string[];
  viewCart: string[];
  productForm: string[];
}

/**
 * Detect if a site is Shopify and identify the theme
 */
export async function detectShopify(page: Page): Promise<ShopifyInfo> {
  const info: ShopifyInfo = {
    isShopify: false,
    confidence: 0,
    selectors: getDefaultShopifySelectors()
  };

  try {
    // Strategy 1: Check for Shopify JavaScript variables
    const shopifyVars = await page.evaluate(() => {
      return {
        hasShopify: typeof (window as any).Shopify !== 'undefined',
        hasTheme: typeof (window as any).Shopify?.theme !== 'undefined',
        themeName: (window as any).Shopify?.theme?.name,
        themeId: (window as any).Shopify?.theme?.id,
        themeVersion: (window as any).Shopify?.theme?.version
      };
    });

    if (shopifyVars.hasShopify) {
      info.isShopify = true;
      info.confidence = 100;
      info.theme = shopifyVars.themeName;
      info.themeId = shopifyVars.themeId?.toString();
    }

    // Strategy 2: Check HTML for Shopify indicators
    if (!info.isShopify) {
      const html = await page.content();
      const scripts = await page.evaluate(() => {
        return Array.from(document.scripts)
          .map(s => s.src || s.textContent || '')
          .join(' ');
      });

      const shopifyIndicators = [
        'Shopify.theme',
        'cdn.shopify.com',
        'myshopify.com',
        'shopifycdn.com',
        'shopify-scripts.com',
        'data-shopify',
        'shopify-section'
      ];

      const matches = shopifyIndicators.filter(indicator => 
        html.includes(indicator) || scripts.includes(indicator)
      );

      if (matches.length >= 2) {
        info.isShopify = true;
        info.confidence = Math.min(90, matches.length * 15);
      }
    }

    // Strategy 3: Check for Shopify-specific DOM elements
    if (info.isShopify) {
      const shopifyElements = await page.evaluate(() => {
        return {
          hasCartDrawer: !!document.querySelector('[data-cart-drawer], #CartDrawer, .cart-drawer'),
          hasProductForm: !!document.querySelector('form[action*="/cart/add"]'),
          hasShopifySection: !!document.querySelector('[data-section-type]'),
          hasThemeName: document.querySelector('meta[name="theme-name"]')?.getAttribute('content')
        };
      });

      if (shopifyElements.hasThemeName) {
        info.theme = shopifyElements.hasThemeName;
      }

      // Detect theme by CSS/class patterns
      if (!info.theme) {
        info.theme = await detectThemeByPatterns(page);
      }
    }

    // Get theme-specific selectors
    if (info.theme) {
      info.selectors = getThemeSelectors(info.theme);
    }

    console.log(`🔍 Shopify Detection: ${info.isShopify ? '✅' : '❌'} ${info.theme ? `Theme: ${info.theme}` : ''} (confidence: ${info.confidence}%)`);

  } catch (error) {
    console.log(`⚠ Shopify detection error: ${error}`);
  }

  return info;
}

/**
 * Detect theme by analyzing CSS classes, IDs, and structure
 */
async function detectThemeByPatterns(page: Page): Promise<string | undefined> {
  try {
    const patterns = await page.evaluate(() => {
      const body = document.body;
      const html = document.documentElement;
      
      // Check for theme-specific classes/IDs
      const classList = Array.from(body.classList).join(' ') + ' ' + 
                       Array.from(html.classList).join(' ');
      
      // Check for theme-specific meta tags
      const themeMeta = document.querySelector('meta[name="theme-name"]')?.getAttribute('content');
      const generatorMeta = document.querySelector('meta[name="generator"]')?.getAttribute('content');
      
      // Check for theme-specific script sources
      const scripts = Array.from(document.scripts)
        .map(s => s.src)
        .join(' ');
      
      // Check for theme-specific CSS files
      const stylesheets = Array.from(document.styleSheets)
        .map(s => (s as any).href || '')
        .join(' ');

      return {
        classList,
        themeMeta,
        generatorMeta,
        scripts,
        stylesheets
      };
    });

    // Theme detection patterns
    const themePatterns: Record<string, RegExp[]> = {
      'Dawn': [
        /theme-dawn/i,
        /dawn/i,
        /\/themes\/.*dawn/i
      ],
      'Debut': [
        /theme-debut/i,
        /debut/i,
        /\/themes\/.*debut/i
      ],
      'Brooklyn': [
        /theme-brooklyn/i,
        /brooklyn/i,
        /\/themes\/.*brooklyn/i
      ],
      'Impulse': [
        /impulse/i,
        /theme-impulse/i
      ],
      'Narrative': [
        /narrative/i,
        /theme-narrative/i
      ],
      'Supply': [
        /supply/i,
        /theme-supply/i
      ],
      'Venture': [
        /venture/i,
        /theme-venture/i
      ],
      'Boundless': [
        /boundless/i,
        /theme-boundless/i
      ],
      'Minimal': [
        /minimal/i,
        /theme-minimal/i
      ]
    };

    const allText = [
      patterns.classList,
      patterns.themeMeta,
      patterns.generatorMeta,
      patterns.scripts,
      patterns.stylesheets
    ].join(' ').toLowerCase();

    for (const [theme, regexes] of Object.entries(themePatterns)) {
      for (const regex of regexes) {
        if (regex.test(allText)) {
          return theme;
        }
      }
    }

    // Check for custom theme indicators
    if (patterns.classList.includes('theme-')) {
      const match = patterns.classList.match(/theme-([a-z0-9-]+)/i);
      if (match) {
        return match[1].charAt(0).toUpperCase() + match[1].slice(1);
      }
    }

  } catch (error) {
    console.log(`Theme pattern detection error: ${error}`);
  }

  return undefined;
}

/**
 * Get default Shopify selectors (works for most themes)
 */
function getDefaultShopifySelectors(): ShopifySelectors {
  return {
    addToCart: [
      'button[name="add"]',
      '[data-add-to-cart]',
      'form[action*="/cart/add"] button[type="submit"]',
      '.product-form__cart-submit',
      '.btn--add-to-cart',
      '[data-product-add]',
      'button[data-add-to-cart-button]'
    ],
    variantSelector: [
      'select[name*="id"]',
      '[data-product-options]',
      '.product-form__input--dropdown',
      'input[type="radio"][name*="id"]',
      '.variant-input',
      '[data-variant-select]'
    ],
    cartDrawer: [
      '[data-cart-drawer]',
      '#CartDrawer',
      '.cart-drawer',
      '[id*="cart-drawer"]',
      '[class*="cart-drawer"]',
      '.drawer--cart'
    ],
    cartIcon: [
      '[data-cart-icon]',
      '[href*="/cart"]',
      '.cart-icon',
      '[aria-label*="cart"]',
      '.site-header__cart'
    ],
    checkoutButton: [
      'button[name="checkout"]',
      '[href*="/checkout"]',
      '.cart__checkout',
      '[data-checkout-button]',
      'a[href*="/checkout"]',
      'form[action*="/checkout"] button'
    ],
    viewCart: [
      'a[href*="/cart"]',
      '[data-view-cart]',
      '.cart__view',
      'button:has-text("View cart")',
      'a:has-text("View cart")'
    ],
    productForm: [
      'form[action*="/cart/add"]',
      '.product-form',
      '[data-product-form]'
    ]
  };
}

/**
 * Get theme-specific selectors (override defaults for known themes)
 */
function getThemeSelectors(theme: string): ShopifySelectors {
  const base = getDefaultShopifySelectors();
  const themeLower = theme.toLowerCase();

  // Dawn theme (Shopify's latest default theme)
  if (themeLower.includes('dawn')) {
    return {
      ...base,
      addToCart: [
        'button[name="add"]',
        'form[action*="/cart/add"] button[type="submit"]',
        '.product-form__submit',
        '[data-add-to-cart]'
      ],
      cartDrawer: [
        'cart-drawer',
        '#cart-drawer',
        '[id="cart-drawer"]'
      ],
      variantSelector: [
        'select[name="id"]',
        '.product-form__input input[type="radio"]',
        'variant-selects select'
      ]
    };
  }

  // Debut theme
  if (themeLower.includes('debut')) {
    return {
      ...base,
      addToCart: [
        'button[name="add"]',
        '.btn--add-to-cart',
        'form[action*="/cart/add"] button'
      ],
      cartDrawer: [
        '#CartDrawer',
        '.cart-drawer'
      ]
    };
  }

  // Brooklyn theme
  if (themeLower.includes('brooklyn')) {
    return {
      ...base,
      addToCart: [
        'button[name="add"]',
        '.product-single__cart-submit',
        'form[action*="/cart/add"] button'
      ],
      cartDrawer: [
        '#CartDrawer',
        '.ajaxcart'
      ]
    };
  }

  // Impulse theme
  if (themeLower.includes('impulse')) {
    return {
      ...base,
      addToCart: [
        'button[name="add"]',
        '.product-form__cart-submit',
        '[data-add-to-cart]'
      ],
      cartDrawer: [
        '#CartDrawer',
        '.cart-drawer'
      ]
    };
  }

  // Return base selectors for unknown themes
  return base;
}

/**
 * Check if current page is a Shopify product page
 */
export async function isShopifyProductPage(page: Page): Promise<boolean> {
  try {
    const indicators = await page.evaluate(() => {
      return {
        hasProductForm: !!document.querySelector('form[action*="/cart/add"]'),
        hasProductJson: !!document.querySelector('[data-product-json]'),
        hasShopifyProduct: typeof (window as any).Shopify?.analytics?.meta?.product !== 'undefined',
        urlMatches: window.location.pathname.includes('/products/')
      };
    });

    return indicators.hasProductForm || indicators.hasProductJson || 
           indicators.hasShopifyProduct || indicators.urlMatches;
  } catch {
    return false;
  }
}

/**
 * Check if current page is a Shopify cart page
 */
export async function isShopifyCartPage(page: Page): Promise<boolean> {
  try {
    const indicators = await page.evaluate(() => {
      return {
        urlMatches: window.location.pathname.includes('/cart'),
        hasCartForm: !!document.querySelector('form[action*="/cart"]'),
        hasCartItems: !!document.querySelector('[data-cart-items], .cart__items')
      };
    });

    return indicators.urlMatches || indicators.hasCartForm || indicators.hasCartItems;
  } catch {
    return false;
  }
}

