/**
 * Core type definitions for the checkout auditor
 */

export type CheckoutStage = 
  | 'homepage'
  | 'product'
  | 'cart'
  | 'checkout_contact'
  | 'checkout_shipping'
  | 'checkout_payment';

export interface Detection {
  present: boolean;
  confidence: number;  // 0-1
  evidence: string[]; // Must be non-empty if present=true
}

export interface Detections {
  edd: Detection;
  upsells: Detection;
  fstBar: Detection;
  shippingAddon: Detection;
  trustBadges: Detection;
}

export interface StageResult {
  key: CheckoutStage;
  url: string;
  screenshotUrl: string;
  notes: string[];
  detections: Detections;
  extractedSnippets: string[];
}

export interface AuditResult {
  domain: string;
  jobId: string;
  startedAt: string;
  completedAt?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  stages: StageResult[];
  error?: string;
}

export interface Job {
  jobId: string;
  domain: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progressPct: number;
  result: AuditResult;
  createdAt: string;
}

export interface CheckoutConfig {
  email: string;
  firstName: string;
  lastName: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string;
}

