/**
 * Express server with REST API for checkout auditor
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

import {
  createJob,
  getJob,
  addStageToJob,
  completeJob,
  failJob,
  cleanupOldJobs,
} from './jobs';
import { runCheckoutJourney, closeBrowser } from './checkout';
import { AuditResult, CheckoutConfig } from './types';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/artifacts', express.static('artifacts'));

// Checkout configuration from environment
const checkoutConfig: CheckoutConfig = {
  email: process.env.CHECKOUT_EMAIL || 'test@example.com',
  firstName: process.env.CHECKOUT_FIRST_NAME || 'Test',
  lastName: process.env.CHECKOUT_LAST_NAME || 'User',
  address: process.env.CHECKOUT_ADDRESS || '123 Main St',
  city: process.env.CHECKOUT_CITY || 'San Francisco',
  state: process.env.CHECKOUT_STATE || 'CA',
  zip: process.env.CHECKOUT_ZIP || '94102',
  country: process.env.CHECKOUT_COUNTRY || 'US',
  phone: process.env.CHECKOUT_PHONE || '5551234567',
};

/**
 * Health check endpoint
 */
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

/**
 * POST /api/audit - Start a new checkout audit
 * Body: { domain: string }
 * Returns: { jobId: string }
 */
app.post('/api/audit', (req: Request, res: Response) => {
  try {
    const { domain } = req.body;
    
    if (!domain) {
      return res.status(400).json({ error: 'domain is required' });
    }
    
    const jobId = createJob(domain);
    
    // Start audit in background (don't await)
    runAuditAsync(jobId, domain).catch(error => {
      console.error(`Error in background audit ${jobId}:`, error);
      failJob(jobId, error.message);
    });
    
    res.json({ jobId });
  } catch (error) {
    console.error('Error creating audit job:', error);
    res.status(500).json({ error: 'Failed to create audit job' });
  }
});

/**
 * GET /api/audit/:jobId - Get audit job status and results
 * Returns: { jobId, status, progressPct, stages[], error? }
 */
app.get('/api/audit/:jobId', (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const job = getJob(jobId);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    res.json({
      jobId: job.jobId,
      status: job.status,
      progressPct: job.progressPct,
      stages: job.result.stages,
      error: job.result.error,
    });
  } catch (error) {
    console.error('Error fetching job:', error);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

/**
 * POST /api/audit-batch - Start batch audit
 * Body: { domains: string[] }
 * Returns: { jobIds: string[] }
 */
app.post('/api/audit-batch', (req: Request, res: Response) => {
  try {
    const { domains } = req.body;
    
    if (!Array.isArray(domains) || domains.length === 0) {
      return res.status(400).json({ error: 'domains array is required and non-empty' });
    }
    
    const jobIds = domains.map(domain => createJob(domain));
    
    // Start all audits in background
    jobIds.forEach((jobId, index) => {
      const domain = domains[index];
      runAuditAsync(jobId, domain).catch(error => {
        console.error(`Error in background audit ${jobId}:`, error);
        failJob(jobId, error.message);
      });
    });
    
    res.json({ jobIds });
  } catch (error) {
    console.error('Error creating batch audit:', error);
    res.status(500).json({ error: 'Failed to create batch audit' });
  }
});

/**
 * GET /api/jobs - Get status of all jobs (for monitoring)
 */
app.get('/api/jobs', (req: Request, res: Response) => {
  try {
    // Note: Would need to export getAllJobs from jobs.ts
    res.json({ message: 'Endpoint for monitoring all jobs' });
  } catch (error) {
    console.error('Error fetching jobs:', error);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

/**
 * POST /api/download-csv - Export audit results as CSV
 * Body: { jobId: string }
 */
app.post('/api/download-csv', (req: Request, res: Response) => {
  try {
    const { jobId } = req.body;
    
    if (!jobId) {
      return res.status(400).json({ error: 'jobId is required' });
    }
    
    const job = getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    // Build CSV
    const csvRows = [];
    csvRows.push([
      'Domain',
      'Stage',
      'URL',
      'Screenshot URL',
      'EDD Present',
      'EDD Evidence',
      'Upsells Present',
      'Upsells Evidence',
      'FST Bar Present',
      'FST Evidence',
      'Shipping Addon Present',
      'Shipping Evidence',
      'Trust Badges Present',
      'Trust Evidence',
      'Notes',
    ]);
    
    job.result.stages.forEach(stage => {
      const eddEvidence = stage.detections.edd.evidence.join('; ');
      const upsellsEvidence = stage.detections.upsells.evidence.join('; ');
      const fstEvidence = stage.detections.fstBar.evidence.join('; ');
      const shippingEvidence = stage.detections.shippingAddon.evidence.join('; ');
      const trustEvidence = stage.detections.trustBadges.evidence.join('; ');
      
      csvRows.push([
        job.domain,
        stage.key,
        stage.url,
        stage.screenshotUrl,
        stage.detections.edd.present.toString(),
        eddEvidence,
        stage.detections.upsells.present.toString(),
        upsellsEvidence,
        stage.detections.fstBar.present.toString(),
        fstEvidence,
        stage.detections.shippingAddon.present.toString(),
        shippingEvidence,
        stage.detections.trustBadges.present.toString(),
        trustEvidence,
        stage.notes.join('; '),
      ]);
    });
    
    // Convert to CSV string
    const csv = csvRows.map(row =>
      row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
    ).join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${jobId}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Error generating CSV:', error);
    res.status(500).json({ error: 'Failed to generate CSV' });
  }
});

/**
 * Run audit asynchronously (fired in background)
 */
async function runAuditAsync(jobId: string, domain: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) return;
  
  job.status = 'running';
  job.progressPct = 5;
  
  try {
    const stages = await runCheckoutJourney(domain, jobId, checkoutConfig);
    
    // Build final result
    const result: AuditResult = {
      domain,
      jobId,
      startedAt: job.result.startedAt,
      completedAt: new Date().toISOString(),
      status: 'completed',
      stages,
    };
    
    completeJob(jobId, result);
    console.log(`✅ Audit completed for ${domain}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    failJob(jobId, errorMessage);
    console.error(`❌ Audit failed for ${domain}:`, errorMessage);
  }
}

/**
 * Graceful shutdown
 */
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await closeBrowser();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await closeBrowser();
  process.exit(0);
});

/**
 * Start server
 */
app.listen(PORT, () => {
  console.log(`\n🚀 Checkout Auditor Server running on http://localhost:${PORT}`);
  console.log(`📊 Frontend: http://localhost:${PORT}`);
  console.log(`🔌 API Health: http://localhost:${PORT}/api/health`);
  
  // Run cleanup every 5 minutes
  setInterval(() => {
    cleanupOldJobs();
  }, 5 * 60 * 1000);
});

