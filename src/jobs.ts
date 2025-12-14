/**
 * In-memory job management for checkout audits
 * MVP: Simple Map storage (can upgrade to Redis/DB later)
 */

import { v4 as uuidv4 } from 'uuid';
import { Job, AuditResult } from './types';

const jobsMap = new Map<string, Job>();

/**
 * Create a new audit job
 */
export function createJob(domain: string): string {
  const jobId = uuidv4();
  const now = new Date().toISOString();
  
  jobsMap.set(jobId, {
    jobId,
    domain,
    status: 'queued',
    progressPct: 0,
    result: {
      domain,
      jobId,
      stages: [],
      status: 'pending',
      startedAt: now,
    },
    createdAt: now,
  });
  
  return jobId;
}

/**
 * Get a job by ID
 */
export function getJob(jobId: string): Job | undefined {
  return jobsMap.get(jobId);
}

/**
 * Update job status and progress
 */
export function updateJobProgress(
  jobId: string,
  progressPct: number,
  status?: Job['status']
): void {
  const job = jobsMap.get(jobId);
  if (!job) return;
  
  job.progressPct = progressPct;
  if (status) job.status = status;
}

/**
 * Update job with completed result
 */
export function completeJob(jobId: string, result: AuditResult): void {
  const job = jobsMap.get(jobId);
  if (!job) return;
  
  job.result = result;
  job.status = 'completed';
  job.progressPct = 100;
}

/**
 * Mark job as failed
 */
export function failJob(jobId: string, error: string): void {
  const job = jobsMap.get(jobId);
  if (!job) return;
  
  job.status = 'failed';
  job.result.status = 'failed';
  job.result.error = error;
  job.result.completedAt = new Date().toISOString();
}

/**
 * Add a stage to job result
 */
export function addStageToJob(jobId: string, stageResult: any): void {
  const job = jobsMap.get(jobId);
  if (!job) return;
  
  job.result.stages.push(stageResult);
  // Update progress based on stages (6 total: homepage, product, cart, contact, shipping, payment)
  const progressMap: { [key: string]: number } = {
    'homepage': 15,
    'product': 30,
    'cart': 45,
    'checkout_contact': 60,
    'checkout_shipping': 80,
    'checkout_payment': 95,
  };
  
  const lastStage = job.result.stages[job.result.stages.length - 1];
  const progress = progressMap[lastStage.key] || 0;
  job.progressPct = progress;
}

/**
 * Get all jobs (for debugging)
 */
export function getAllJobs(): Job[] {
  return Array.from(jobsMap.values());
}

/**
 * Clean up old jobs (older than 1 hour)
 */
export function cleanupOldJobs(): void {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  
  for (const [jobId, job] of jobsMap.entries()) {
    const createdTime = new Date(job.createdAt).getTime();
    if (createdTime < oneHourAgo && (job.status === 'completed' || job.status === 'failed')) {
      jobsMap.delete(jobId);
    }
  }
}

