/**
 * Utility functions for checkout auditor
 */

import path from 'path';
import fs from 'fs';

/**
 * Ensure artifact directory exists
 */
export function ensureArtifactDir(jobId: string, domain: string): string {
  const dir = path.join(process.cwd(), 'artifacts', jobId, domain, 'screens');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Get artifact path for a screenshot
 */
export function getArtifactPath(jobId: string, domain: string, stage: string): string {
  const dir = ensureArtifactDir(jobId, domain);
  return path.join(dir, `${stage}.jpg`);
}

/**
 * Get served URL for artifact
 */
export function getArtifactUrl(jobId: string, domain: string, stage: string): string {
  return `/artifacts/${jobId}/${domain}/screens/${stage}.jpg`;
}

/**
 * Extract high-signal snippets from page text
 */
export function extractHighSignalSnippets(domText: string): string[] {
  const snippets: string[] = [];
  const patterns = [
    /(?:arrives?|delivery|delivered|get it|ship).{0,100}/gi,
    /(?:free shipping|free ship|fst).{0,100}/gi,
    /(?:protection|insurance|coverage).{0,100}/gi,
    /(?:secure|ssl|trust|verified|badge).{0,100}/gi,
    /(?:recommended|upsell|also like|complete).{0,100}/gi,
  ];
  
  for (const pattern of patterns) {
    const matches = domText.match(pattern);
    if (matches) {
      snippets.push(...matches.slice(0, 2).map(m => m.substring(0, 80)));
    }
  }
  
  // Remove duplicates and limit
  return Array.from(new Set(snippets)).slice(0, 6);
}

/**
 * Normalize domain URL
 */
export function normalizeDomain(domain: string): string {
  if (!domain.startsWith('http://') && !domain.startsWith('https://')) {
    domain = 'https://' + domain;
  }
  return domain;
}

/**
 * Extract domain name from URL
 */
export function getDomainName(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return url;
  }
}

/**
 * Sleep for N milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sanitize filename
 */
export function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

