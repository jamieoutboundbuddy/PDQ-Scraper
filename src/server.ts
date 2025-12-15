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
import { runCheckoutJourney, closeBrowser, getCheckoutConfigForDomain, getConcurrencyStatus } from './checkout';
import { AuditResult, CheckoutConfig } from './types';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/artifacts', express.static('artifacts'));

// Checkout configuration from environment
const checkoutConfig: CheckoutConfig = {
  email: process.env.CHECKOUT_EMAIL || 'james.mumford@example.com',
  firstName: process.env.CHECKOUT_FIRST_NAME || 'James',
  lastName: process.env.CHECKOUT_LAST_NAME || 'Mumford',
  address: process.env.CHECKOUT_ADDRESS || '43 Bussel, 6 Westfield Avenue',
  city: process.env.CHECKOUT_CITY || 'London',
  state: process.env.CHECKOUT_STATE || 'London',
  zip: process.env.CHECKOUT_ZIP || 'E20 1NB',
  country: process.env.CHECKOUT_COUNTRY || 'GB',
  phone: process.env.CHECKOUT_PHONE || '+44 20 7681 0341',
  // Realistic test payment card (Visa test card)
  cardNumber: process.env.CHECKOUT_CARD || '4111111111111111',
  cardName: process.env.CHECKOUT_CARD_NAME || 'James Mumford',
  cardExpiry: process.env.CHECKOUT_CARD_EXPIRY || '12/27',
  cardCvv: process.env.CHECKOUT_CARD_CVV || '123',
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
 * GET /api/status - Get server status including concurrency info
 */
app.get('/api/status', (req: Request, res: Response) => {
  const concurrency = getConcurrencyStatus();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    concurrency: {
      activeBrowsers: concurrency.active,
      maxBrowsers: concurrency.max,
      queuedJobs: concurrency.queued,
    },
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
 * POST /api/audit-sync - Run audit synchronously and return results
 * Designed for Clay/n8n integration
 * Body: { domain: string }
 * Returns: AuditResult (waits for completion)
 * Timeout: 180 seconds
 */
app.post('/api/audit-sync', async (req: Request, res: Response) => {
  try {
    const { domain } = req.body;
    
    if (!domain) {
      return res.status(400).json({ error: 'domain is required' });
    }
    
    // Set long timeout (audits can take 60+ seconds)
    req.setTimeout(180000); // 3 minutes
    
    const jobId = createJob(domain);
    const job = getJob(jobId);
    
    if (!job) {
      return res.status(500).json({ error: 'Failed to create job' });
    }
    
    const startedAt = new Date().toISOString();
    
    // Get location-specific checkout config
    const domainConfig = getCheckoutConfigForDomain(domain, checkoutConfig);
    
    // Run audit synchronously
    const stages = await runCheckoutJourney(domain, jobId, domainConfig);
    
    // Build result
    const result: AuditResult = {
      domain,
      jobId,
      startedAt: job.result.startedAt || startedAt,
      completedAt: new Date().toISOString(),
      status: 'completed',
      stages,
    };
    
    completeJob(jobId, result);
    
    // Make screenshot URLs absolute for external access
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const resultWithAbsoluteUrls = {
      ...result,
      stages: result.stages.map(stage => ({
        ...stage,
        screenshotUrl: stage.screenshotUrl.startsWith('http') 
          ? stage.screenshotUrl 
          : `${baseUrl}${stage.screenshotUrl}`
      }))
    };
    
    res.json(resultWithAbsoluteUrls);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error in sync audit:', error);
    res.status(500).json({ 
      domain: req.body.domain || 'unknown',
      status: 'failed',
      error: errorMessage,
      stages: []
    });
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
 * POST /api/audit-batch-sync - Run batch audit synchronously
 * Body: { domains: string[] }
 * Returns: { results: AuditResult[] }
 * Timeout: 300 seconds (5 minutes)
 */
app.post('/api/audit-batch-sync', async (req: Request, res: Response) => {
  try {
    const { domains } = req.body;
    
    if (!Array.isArray(domains) || domains.length === 0) {
      return res.status(400).json({ error: 'domains array is required and non-empty' });
    }
    
    // Limit batch size to prevent resource exhaustion
    if (domains.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 domains per batch' });
    }
    
    req.setTimeout(300000); // 5 minutes
    
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const results: AuditResult[] = [];
    
    // Process domains sequentially to avoid overwhelming the server
    for (const domain of domains) {
      try {
        const jobId = createJob(domain);
        const job = getJob(jobId);
        const startedAt = new Date().toISOString();
        
        if (!job) {
          results.push({
            domain,
            jobId: '',
            startedAt,
            completedAt: new Date().toISOString(),
            status: 'failed',
            error: 'Failed to create job',
            stages: [],
          });
          continue;
        }
        
        const domainConfig = getCheckoutConfigForDomain(domain, checkoutConfig);
        const stages = await runCheckoutJourney(domain, jobId, domainConfig);
        
        const result: AuditResult = {
          domain,
          jobId,
          startedAt: job.result.startedAt || startedAt,
          completedAt: new Date().toISOString(),
          status: 'completed',
          stages: stages.map(stage => ({
            ...stage,
            screenshotUrl: stage.screenshotUrl.startsWith('http') 
              ? stage.screenshotUrl 
              : `${baseUrl}${stage.screenshotUrl}`
          })),
        };
        
        completeJob(jobId, result);
        results.push(result);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        results.push({
          domain,
          jobId: '',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          status: 'failed',
          error: errorMessage,
          stages: [],
        });
      }
    }
    
    res.json({ results });
  } catch (error) {
    console.error('Error in batch sync audit:', error);
    res.status(500).json({ error: 'Failed to process batch audit' });
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
    // Get location-specific checkout config based on domain
    const domainConfig = getCheckoutConfigForDomain(domain, checkoutConfig);
    const stages = await runCheckoutJourney(domain, jobId, domainConfig);
    
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
 * Bind to 0.0.0.0 for Railway/production deployment
 */
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`\n🚀 Checkout Auditor Server running on http://${HOST}:${PORT}`);
  console.log(`📊 Frontend: http://${HOST}:${PORT}`);
  console.log(`🔌 API Health: http://${HOST}:${PORT}/api/health`);
  console.log(`🔗 Sync API: POST http://${HOST}:${PORT}/api/audit-sync`);
  
  // Run cleanup every 5 minutes
  setInterval(() => {
    cleanupOldJobs();
  }, 5 * 60 * 1000);
});

