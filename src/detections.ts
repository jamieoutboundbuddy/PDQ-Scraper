/**
 * Detection pipeline: Rules-first, LLM fallback for ambiguous cases
 */

import { Page } from 'playwright';
import { Detection, Detections } from './types';
import OpenAI from 'openai';

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    })
  : null;

/**
 * Main detection orchestrator - runs all detection rules
 */
export async function detectFeaturesOnPage(
  page: Page,
  domText: string,
  stage: string
): Promise<Detections> {
  return {
    edd: await detectEDD(domText),
    upsells: await detectUpsells(page, domText),
    fstBar: await detectFSTBar(domText),
    shippingAddon: await detectShippingAddon(domText),
    trustBadges: await detectTrustBadges(page, domText),
  };
}

/**
 * Detect Estimated Delivery Date (EDD)
 * Rules-based: Look for delivery date patterns
 */
async function detectEDD(domText: string): Promise<Detection> {
  const patterns = [
    /(?:arrives?|delivery|delivered|get it|arrives by|delivery by|estimated delivery|ship by|arriving|EDD).{0,150}/gi,
    /\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b/gi,
    /\b(?:\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}|(?:in|within)\s+\d+\s+(?:days?|weeks?))\b/gi,
  ];
  
  const matches: string[] = [];
  for (const pattern of patterns) {
    const found = domText.match(pattern);
    if (found) {
      matches.push(...found);
    }
  }
  
  if (matches.length > 0) {
    const evidence = Array.from(new Set(matches))
      .slice(0, 3)
      .map(m => m.trim().substring(0, 100));
    
    return {
      present: true,
      confidence: 0.92,
      evidence,
    };
  }
  
  return {
    present: false,
    confidence: 1.0,
    evidence: [],
  };
}

/**
 * Detect Upsells / Cross-sells
 * Rules-first with LLM fallback for ambiguous cases
 */
async function detectUpsells(page: Page, domText: string): Promise<Detection> {
  // Quick rules check
  const upsellPhrases = [
    'you may also like',
    'recommended',
    'complete the set',
    'frequently bought together',
    'customers also purchased',
    'add to order',
    'add another item',
    'combo',
    'bundle',
  ];
  
  const lowerText = domText.toLowerCase();
  const foundPhrases = upsellPhrases.filter(phrase => lowerText.includes(phrase));
  
  if (foundPhrases.length > 0) {
    return {
      present: true,
      confidence: 0.90,
      evidence: foundPhrases.slice(0, 3),
    };
  }
  
  // Ambiguous case: check page structure with LLM (if available)
  if (!openai) {
    return {
      present: false,
      confidence: 0.3,
      evidence: [],
    };
  }

  try {
    const promptText = `
You are analyzing an ecommerce page for upsell/cross-sell sections.

Look for patterns like:
- "You may also like" / "Recommended products" sections
- "Complete the set" or "Bundle" offers
- "Add another item" buttons
- "Frequently bought together" modules
- Additional product suggestions in checkout

Page text (first 2000 chars):
${domText.substring(0, 2000)}

RETURN ONLY THIS JSON (no markdown, no explanation):
{
  "present": boolean,
  "confidence": 0.0-1.0,
  "evidence": ["specific phrase or description"]
}
`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: promptText }],
      temperature: 0.2,
      max_tokens: 200,
      response_format: { type: 'json_object' },
    });
    
    const content = response.choices[0].message.content || '{}';
    const result = JSON.parse(content);
    
    // Only return true if we have evidence
    if (result.present && (!result.evidence || result.evidence.length === 0)) {
      return {
        present: false,
        confidence: 0.5,
        evidence: [],
      };
    }
    
    return {
      present: result.present ?? false,
      confidence: result.confidence ?? 0.5,
      evidence: Array.isArray(result.evidence) ? result.evidence : [],
    };
  } catch (error) {
    console.error('LLM upsell detection failed:', error);
    return {
      present: false,
      confidence: 0.3,
      evidence: [],
    };
  }
}

/**
 * Detect Free Shipping Threshold (FST) progress bar
 * Rules-based: Look for progress bar indicators and FST messaging
 */
async function detectFSTBar(domText: string): Promise<Detection> {
  const patterns = [
    /(?:you'?re|you are)\s+(?:£|\$|€)?[\d.]+\s+(?:away|short|off)\s+from\s+free\s+shipping/gi,
    /(?:spend|buy|add)\s+(?:£|\$|€)?[\d.]+\s+(?:more|additional)\s+(?:for|to get)\s+free\s+shipping/gi,
    /progress.*?(?:free\s+shipping|free\s+ship)/gi,
    /free\s+shipping\s+(?:on orders|over|at|threshold|progress)/gi,
    /(?:qualify for|reach)\s+free\s+(?:shipping|delivery|ship)/gi,
  ];
  
  const matches: string[] = [];
  for (const pattern of patterns) {
    const found = domText.match(pattern);
    if (found) {
      matches.push(...found);
    }
  }
  
  if (matches.length > 0) {
    const evidence = Array.from(new Set(matches))
      .slice(0, 3)
      .map(m => m.trim().substring(0, 100));
    
    return {
      present: true,
      confidence: 0.95,
      evidence,
    };
  }
  
  return {
    present: false,
    confidence: 1.0,
    evidence: [],
  };
}

/**
 * Detect Shipping insurance / returns add-on
 * Rules-based: Look for protection service offerings
 */
async function detectShippingAddon(domText: string): Promise<Detection> {
  const patterns = [
    /(?:shipping\s+)?protection|package\s+protection|delivery\s+protection/gi,
    /(?:shipping\s+)?insurance|coverage|route|navidium|shipsurance/gi,
    /return\s+protection|extended\s+returns|(?:hassle-free|easy)\s+returns/gi,
    /add.*?protection|protect\s+your\s+order|order\s+protection/gi,
    /optional\s+coverage|add-on\s+(?:service|coverage|protection)/gi,
  ];
  
  const matches: string[] = [];
  for (const pattern of patterns) {
    const found = domText.match(pattern);
    if (found) {
      matches.push(...found);
    }
  }
  
  if (matches.length > 0) {
    const evidence = Array.from(new Set(matches))
      .slice(0, 3)
      .map(m => m.trim().substring(0, 100));
    
    return {
      present: true,
      confidence: 0.90,
      evidence,
    };
  }
  
  return {
    present: false,
    confidence: 1.0,
    evidence: [],
  };
}

/**
 * Detect Trust badges / security indicators
 * Rules-first with LLM fallback
 */
async function detectTrustBadges(page: Page, domText: string): Promise<Detection> {
  // Quick rules check - look for common trust signals
  const trustPhrases = [
    'secure checkout',
    'ssl',
    'tls',
    'trusted',
    'verified',
    'secure connection',
    'lock icon',
    '🔒',
    'security badge',
    'safe checkout',
    'certified',
  ];
  
  const lowerText = domText.toLowerCase();
  const foundPhrases = trustPhrases.filter(phrase => lowerText.includes(phrase));
  
  // Also check for payment badges in HTML
  try {
    const paymentBadges = await page.locator('[class*="payment"], [class*="badge"], [class*="trust"]').count();
    if (paymentBadges > 0 || foundPhrases.length > 0) {
      return {
        present: true,
        confidence: 0.88,
        evidence: foundPhrases.slice(0, 3),
      };
    }
  } catch {
    // Continue with text-based detection
  }
  
  if (foundPhrases.length > 0) {
    return {
      present: true,
      confidence: 0.88,
      evidence: foundPhrases.slice(0, 3),
    };
  }
  
  return {
    present: false,
    confidence: 1.0,
    evidence: [],
  };
}

