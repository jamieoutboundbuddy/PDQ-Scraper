/**
 * Frontend JavaScript for eCommerce Checkout Auditor
 */

let currentJobId = null;
let pollInterval = null;

// Batch audit state
let batchJobs = []; // Array of { jobId, domain, status, stages }
let batchPollInterval = null;

/**
 * Switch between tabs
 */
function switchTab(tab) {
  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');

  // Update tab content
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.add('hidden');
  });
  document.getElementById(`${tab}-tab`).classList.remove('hidden');
}

/**
 * Start a single domain audit
 */
async function startAudit() {
  const domainInput = document.getElementById('domain-input');
  const domain = domainInput.value.trim();

  if (!domain) {
    showToast('Please enter a domain', 'error');
    return;
  }

  // Reset UI
  document.getElementById('stage-tabs').innerHTML = '';
  document.getElementById('stage-content').innerHTML = '';
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('timeline-section').classList.remove('hidden');
  document.getElementById('progress-section').classList.remove('hidden');

  try {
    // Create audit job
    const response = await fetch('/api/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(errorData.error || `Server error: ${response.status}`);
    }

    const data = await response.json();
    
    if (!data.jobId) {
      throw new Error('No jobId returned from server');
    }
    
    currentJobId = data.jobId;

    showToast(`Audit started for ${domain}`, 'success');

    // Start polling
    pollJob();
  } catch (error) {
    console.error('Error starting audit:', error);
    showToast(`Failed to start audit: ${error.message}`, 'error');
  }
}

/**
 * Start batch audit
 */
async function startBatchAudit() {
  const batchInput = document.getElementById('batch-input');
  const domainsText = batchInput.value.trim();

  if (!domainsText) {
    showToast('Please enter at least one domain', 'error');
    return;
  }

  const domains = domainsText
    .split('\n')
    .map(d => d.trim())
    .filter(d => d.length > 0);

  if (domains.length === 0) {
    showToast('Please enter valid domains', 'error');
    return;
  }

  // Reset batch state
  batchJobs = [];
  if (batchPollInterval) {
    clearTimeout(batchPollInterval);
    batchPollInterval = null;
  }

  // Reset UI and show batch results container
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('timeline-section').classList.add('hidden');
  document.getElementById('progress-section').classList.add('hidden');
  
  // Show batch results section
  let batchSection = document.getElementById('batch-results-section');
  if (!batchSection) {
    // Create batch results section if it doesn't exist
    const container = document.querySelector('.max-w-7xl.mx-auto');
    const batchHtml = `
      <div id="batch-results-section">
        <div class="flex justify-between items-center mb-6">
          <h2 class="text-2xl font-bold text-slate-900">
            <i class="fas fa-list text-blue-600 mr-3"></i>
            Batch Audit Results
          </h2>
          <div class="flex gap-2">
            <span id="batch-progress-text" class="text-sm text-slate-600 self-center"></span>
            <button 
              onclick="exportBatchCSV()"
              class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition text-sm flex items-center gap-2"
            >
              <i class="fas fa-download"></i>
              Export All CSV
            </button>
          </div>
        </div>
        <div id="batch-jobs-container" class="space-y-4">
          <!-- Job cards will be inserted here -->
        </div>
      </div>
    `;
    container.insertAdjacentHTML('beforeend', batchHtml);
    batchSection = document.getElementById('batch-results-section');
  }
  
  batchSection.classList.remove('hidden');
  document.getElementById('batch-jobs-container').innerHTML = '';

  try {
    // Create batch audit
    const response = await fetch('/api/audit-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domains }),
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }

    const data = await response.json();
    
    // Initialize batch jobs tracking
    batchJobs = data.jobIds.map((jobId, index) => ({
      jobId,
      domain: domains[index],
      status: 'queued',
      progressPct: 0,
      stages: [],
      expanded: index === 0 // Expand first job by default
    }));

    // Render initial job cards
    renderBatchJobCards();

    showToast(`Batch audit started for ${domains.length} domains`, 'success');

    // Start polling all jobs
    pollBatchJobs();
  } catch (error) {
    console.error('Error starting batch audit:', error);
    showToast('Failed to start batch audit', 'error');
  }
}

/**
 * Render batch job cards
 */
function renderBatchJobCards() {
  const container = document.getElementById('batch-jobs-container');
  
  const cardsHtml = batchJobs.map((job, index) => {
    const statusIcon = getStatusIcon(job.status);
    const statusColor = getStatusColor(job.status);
    const expandIcon = job.expanded ? 'fa-chevron-up' : 'fa-chevron-down';
    
    return `
      <div class="batch-job-card bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden" data-job-id="${job.jobId}">
        <!-- Job Header (clickable to expand/collapse) -->
        <div class="batch-job-header p-4 cursor-pointer hover:bg-slate-50 transition" onclick="toggleJobExpand('${job.jobId}')">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-4 flex-1">
              <div class="w-8 h-8 rounded-full ${statusColor} flex items-center justify-center">
                <i class="fas ${statusIcon} text-white text-sm"></i>
              </div>
              <div class="flex-1">
                <div class="flex items-center gap-2">
                  <span class="font-semibold text-slate-900">${escapeHtml(job.domain)}</span>
                  <span class="text-xs px-2 py-0.5 rounded-full ${statusColor} text-white">${job.status}</span>
                </div>
                <div class="text-sm text-slate-500 mt-1">
                  ${job.stages.length > 0 ? `${job.stages.length} stages captured` : 'Waiting to start...'}
                </div>
              </div>
            </div>
            <div class="flex items-center gap-4">
              <!-- Progress bar -->
              <div class="w-32 h-2 bg-slate-200 rounded-full overflow-hidden">
                <div class="h-full ob-progress-bar transition-all duration-300" style="width: ${job.progressPct}%"></div>
              </div>
              <span class="text-sm text-slate-600 w-12 text-right">${job.progressPct}%</span>
              <i class="fas ${expandIcon} text-slate-400"></i>
            </div>
          </div>
        </div>
        
        <!-- Expanded Content -->
        <div class="batch-job-content ${job.expanded ? '' : 'hidden'}" id="job-content-${job.jobId}">
          ${job.stages.length > 0 ? renderJobStages(job) : `
            <div class="p-6 text-center text-slate-500">
              <i class="fas fa-spinner fa-spin text-2xl mb-2"></i>
              <p>Audit in progress...</p>
            </div>
          `}
        </div>
      </div>
    `;
  }).join('');
  
  container.innerHTML = cardsHtml;
  
  // Update overall progress text
  const completed = batchJobs.filter(j => j.status === 'completed' || j.status === 'failed').length;
  document.getElementById('batch-progress-text').textContent = `${completed}/${batchJobs.length} completed`;
}

/**
 * Render stages for a single job
 */
function renderJobStages(job) {
  const stageNames = {
    summary: '📋 Summary',
    homepage: '🏠 Homepage',
    product: '📦 Product',
    cart: '🛒 Cart',
    view_cart: '🛒 View Cart',
    checkout: '🔘 Checkout',
    checkout_contact: '✅ Checkout',
    checkout_shipping: '✅ Checkout',
    checkout_payment: '✅ Checkout Filled',
  };
  
  // Filter out duplicate checkout stages (keep payment as "filled out")
  const filteredStages = job.stages.filter(s => 
    s.key !== 'checkout_contact' && s.key !== 'checkout_shipping'
  );
  
  const stagesHtml = filteredStages.map(stage => {
    const stageName = stageNames[stage.key] || stage.key;
    const pillsHtml = buildDetectionPillsCompact(stage.detections);
    
    return `
      <div class="batch-stage-item border-b border-slate-100 last:border-0">
        <div class="flex items-start gap-4 p-4 hover:bg-slate-50 cursor-pointer" onclick="showBatchStageModal('${job.jobId}', '${stage.key}')">
          <div class="flex-shrink-0">
            ${stage.screenshotUrl && stage.key !== 'summary' ? `
              <img src="${stage.screenshotUrl}" alt="${stageName}" class="w-24 h-16 object-cover object-top rounded border border-slate-200">
            ` : `
              <div class="w-24 h-16 bg-slate-100 rounded flex items-center justify-center text-slate-400">
                <i class="fas fa-file-alt text-xl"></i>
              </div>
            `}
          </div>
          <div class="flex-1 min-w-0">
            <div class="font-medium text-slate-900">${stageName}</div>
            <div class="text-xs text-slate-500 truncate mt-1">${new URL(stage.url).pathname}</div>
            <div class="flex gap-1 mt-2 flex-wrap">
              ${pillsHtml}
            </div>
          </div>
          <div class="text-slate-400">
            <i class="fas fa-external-link-alt"></i>
          </div>
        </div>
      </div>
    `;
  }).join('');
  
  return `<div class="batch-stages-list">${stagesHtml}</div>`;
}

/**
 * Build compact detection pills for batch view
 */
function buildDetectionPillsCompact(detections) {
  const pills = [];
  
  if (detections.edd?.present) {
    pills.push(`<span class="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full">EDD</span>`);
  }
  if (detections.upsells?.present) {
    pills.push(`<span class="text-xs px-2 py-0.5 bg-purple-100 text-purple-700 rounded-full">Upsells</span>`);
  }
  if (detections.fstBar?.present) {
    pills.push(`<span class="text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded-full">FST</span>`);
  }
  if (detections.shippingAddon?.present) {
    pills.push(`<span class="text-xs px-2 py-0.5 bg-orange-100 text-orange-700 rounded-full">Add-on</span>`);
  }
  if (detections.trustBadges?.present) {
    pills.push(`<span class="text-xs px-2 py-0.5 bg-teal-100 text-teal-700 rounded-full">Trust</span>`);
  }
  
  if (pills.length === 0) {
    pills.push(`<span class="text-xs px-2 py-0.5 bg-slate-100 text-slate-500 rounded-full">No features</span>`);
  }
  
  return pills.join('');
}

/**
 * Get status icon
 */
function getStatusIcon(status) {
  const icons = {
    queued: 'fa-clock',
    running: 'fa-spinner fa-spin',
    completed: 'fa-check',
    failed: 'fa-times'
  };
  return icons[status] || 'fa-question';
}

/**
 * Get status color class
 */
function getStatusColor(status) {
  const colors = {
    queued: 'bg-slate-400',
    running: 'bg-blue-500',
    completed: 'bg-green-500',
    failed: 'bg-red-500'
  };
  return colors[status] || 'bg-slate-400';
}

/**
 * Toggle job card expansion
 */
window.toggleJobExpand = function(jobId) {
  const job = batchJobs.find(j => j.jobId === jobId);
  if (job) {
    job.expanded = !job.expanded;
    const content = document.getElementById(`job-content-${jobId}`);
    const card = document.querySelector(`[data-job-id="${jobId}"]`);
    const icon = card.querySelector('.fa-chevron-up, .fa-chevron-down');
    
    if (job.expanded) {
      content.classList.remove('hidden');
      icon.classList.remove('fa-chevron-down');
      icon.classList.add('fa-chevron-up');
    } else {
      content.classList.add('hidden');
      icon.classList.remove('fa-chevron-up');
      icon.classList.add('fa-chevron-down');
    }
  }
};

/**
 * Show stage details in modal (for batch view)
 */
window.showBatchStageModal = function(jobId, stageKey) {
  const job = batchJobs.find(j => j.jobId === jobId);
  if (!job) return;
  
  // For checkout stages, show the payment one
  let stage = job.stages.find(s => s.key === stageKey);
  if (stageKey === 'checkout_contact' || stageKey === 'checkout_shipping') {
    stage = job.stages.find(s => s.key === 'checkout_payment') || stage;
  }
  
  if (stage) {
    // Set up modal with full stage content
    const modalImage = document.getElementById('modal-image');
    const modalTitle = document.getElementById('modal-title');
    
    if (stage.screenshotUrl && stage.key !== 'summary') {
      modalImage.src = stage.screenshotUrl;
      modalImage.classList.remove('hidden');
    } else {
      modalImage.classList.add('hidden');
    }
    
    const stageNames = {
      summary: '📋 Summary',
      homepage: '🏠 Homepage',
      product: '📦 Product',
      cart: '🛒 Cart',
      view_cart: '🛒 View Cart',
      checkout: '🔘 Checkout',
      checkout_payment: '✅ Checkout Filled Out',
    };
    
    modalTitle.textContent = `${job.domain} - ${stageNames[stage.key] || stage.key}`;
    document.getElementById('image-modal').classList.remove('hidden');
  }
};

/**
 * Poll all batch jobs
 */
async function pollBatchJobs() {
  const pendingJobs = batchJobs.filter(j => j.status !== 'completed' && j.status !== 'failed');
  
  if (pendingJobs.length === 0) {
    // All done!
    showToast('All batch audits completed!', 'success');
    return;
  }
  
  try {
    // Poll all pending jobs in parallel
    const pollPromises = pendingJobs.map(async (job) => {
      try {
        const response = await fetch(`/api/audit/${job.jobId}`);
        if (!response.ok) return;
        
        const data = await response.json();
        
        // Update job state
        job.status = data.status;
        job.progressPct = data.progressPct || 0;
        job.stages = data.stages || [];
      } catch (e) {
        console.error(`Error polling job ${job.jobId}:`, e);
      }
    });
    
    await Promise.all(pollPromises);
    
    // Re-render cards with updated data
    renderBatchJobCards();
    
    // Continue polling if not all done
    const stillPending = batchJobs.filter(j => j.status !== 'completed' && j.status !== 'failed');
    if (stillPending.length > 0) {
      batchPollInterval = setTimeout(() => pollBatchJobs(), 2000);
    } else {
      showToast('All batch audits completed!', 'success');
    }
  } catch (error) {
    console.error('Error polling batch jobs:', error);
    // Retry polling
    batchPollInterval = setTimeout(() => pollBatchJobs(), 3000);
  }
}

/**
 * Export all batch results to CSV
 */
async function exportBatchCSV() {
  if (batchJobs.length === 0) {
    showToast('No batch results to export', 'error');
    return;
  }
  
  try {
    // Create CSV content
    const headers = ['Domain', 'Status', 'Stages', 'EDD', 'Upsells', 'FST Bar', 'Shipping Add-on', 'Trust Badges'];
    const rows = batchJobs.map(job => {
      // Aggregate detections across all stages
      const hasFeature = (key) => job.stages.some(s => s.detections?.[key]?.present);
      
      return [
        job.domain,
        job.status,
        job.stages.length,
        hasFeature('edd') ? 'Yes' : 'No',
        hasFeature('upsells') ? 'Yes' : 'No',
        hasFeature('fstBar') ? 'Yes' : 'No',
        hasFeature('shippingAddon') ? 'Yes' : 'No',
        hasFeature('trustBadges') ? 'Yes' : 'No'
      ].join(',');
    });
    
    const csvContent = [headers.join(','), ...rows].join('\n');
    
    // Download CSV
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `batch-audit-${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
    
    showToast('Batch CSV exported successfully', 'success');
  } catch (error) {
    console.error('Error exporting batch CSV:', error);
    showToast('Failed to export CSV', 'error');
  }
}

/**
 * Poll job status and render stages as they complete
 */
async function pollJob() {
  if (!currentJobId) return;

  try {
    const response = await fetch(`/api/audit/${currentJobId}`);
    const job = await response.json();

    // Update progress
    updateProgress(job.progressPct, job.status);

    // Render tabs on first load
    const tabsContainer = document.getElementById('stage-tabs');
    if (tabsContainer && job.stages.length > 0 && tabsContainer.children.length === 0) {
      renderStageTabs(job.stages);
    }

    // Update active stage to show latest
    if (job.stages.length > 0) {
      const lastStage = job.stages[job.stages.length - 1];
      if (document.querySelector(`[data-stage="${lastStage.key}"]`)) {
        selectStage(lastStage.key);
      }
    }

    // Continue polling if not done
    if (job.status !== 'completed' && job.status !== 'failed') {
      pollInterval = setTimeout(() => pollJob(), 1000);
    } else {
      // Done!
      showToast(
        job.status === 'completed' ? 'Audit completed!' : 'Audit failed',
        job.status === 'completed' ? 'success' : 'error'
      );
    }
  } catch (error) {
    console.error('Error polling job:', error);
    showToast('Error checking audit status', 'error');
  }
}

/**
 * Render stages as tabs
 */
function renderStageTabs(stages) {
  const tabsContainer = document.getElementById('stage-tabs');
  
  const stageNames = {
    summary: '📋 Summary',
    homepage: '🏠 Homepage',
    product: '📦 Product',
    cart: '🛒 Cart',
    view_cart: '🛒 View Cart',
    checkout: '🔘 Checkout',
    checkout_contact: '✅ Checkout Filled Out',
    checkout_shipping: '✅ Checkout Filled Out',
    checkout_payment: '✅ Checkout Filled Out',
  };

  // Track checkout stages to merge
  let checkoutFilledStage = null;

  stages.forEach((stage, index) => {
    // Collect checkout filled stages (contact, shipping, payment)
    if (stage.key === 'checkout_contact' || stage.key === 'checkout_shipping' || stage.key === 'checkout_payment') {
      // Keep the payment stage (most complete)
      if (stage.key === 'checkout_payment') {
        checkoutFilledStage = stage;
      }
      return; // Skip adding individual tabs
    }

    const stageName = stageNames[stage.key] || stage.key;
    const isActive = index === 0 ? 'active' : '';
    
    const tab = `
      <button 
        class="stage-tab ${isActive}" 
        data-stage="${stage.key}"
        onclick="selectStage('${stage.key}')"
      >
        ${stageName}
      </button>
    `;
    
    tabsContainer.insertAdjacentHTML('beforeend', tab);
  });

  // Add merged "Checkout Filled Out" tab after all other stages
  if (checkoutFilledStage) {
    const tab = `
      <button 
        class="stage-tab" 
        data-stage="checkout_payment"
        onclick="selectStage('checkout_payment')"
      >
        ✅ Checkout Filled Out
      </button>
    `;
    tabsContainer.insertAdjacentHTML('beforeend', tab);
  }
  
  // Auto-select first stage
  if (stages.length > 0) {
    selectStage(stages[0].key);
  }
}

/**
 * Select and display a stage
 */
window.selectStage = function(stageKey) {
  // Update active tab
  document.querySelectorAll('.stage-tab').forEach(tab => {
    tab.classList.remove('active');
  });
  const tabElement = document.querySelector(`[data-stage="${stageKey}"]`);
  if (tabElement) {
    tabElement.classList.add('active');
  }
  
  // Find the stage data
  const response = fetch(`/api/audit/${currentJobId}`);
  response.then(r => r.json()).then(job => {
    // For merged checkout stages, show the payment stage (most complete)
    let stage = job.stages.find(s => s.key === stageKey);
    
    // If clicking on checkout_contact or checkout_shipping tab, show payment instead
    if (stageKey === 'checkout_contact' || stageKey === 'checkout_shipping') {
      stage = job.stages.find(s => s.key === 'checkout_payment') || stage;
    }
    
    if (stage) {
      displayStageContent(stage);
    }
  });
};

/**
 * Display stage content in the main panel
 */
function displayStageContent(stage) {
  const stageNames = {
    summary: '📋 Summary',
    homepage: '🏠 Homepage',
    product: '📦 Product',
    cart: '🛒 Cart',
    view_cart: '🛒 View Cart',
    checkout: '🔘 Checkout',
    checkout_contact: '✅ Checkout Filled Out',
    checkout_shipping: '✅ Checkout Filled Out',
    checkout_payment: '✅ Checkout Filled Out',
  };

  const stageName = stageNames[stage.key] || stage.key;
  const pillsHtml = buildDetectionPills(stage.detections);
  const evidenceHtml = buildEvidenceSections(stage.detections);
  
  // Extract domain and truncate URL
  const urlObj = new URL(stage.url).hostname;
  const pathPart = new URL(stage.url).pathname.substring(0, 50);
  
  const notesHtml = stage.notes.length > 0
    ? `<div class="stage-notes">
         ${stage.notes.map(note => `<div class="note-item">✓ ${escapeHtml(note)}</div>`).join('')}
       </div>`
    : '';

  // Handle summary stage differently (no screenshot)
  if (stage.key === 'summary') {
    const html = `
      <div class="stage-content">
        <div class="stage-header-new">
          <div class="stage-title-section">
            <h2 class="stage-title-large">${stageName}</h2>
            <a href="${escapeHtml(stage.url)}" target="_blank" rel="noopener" class="stage-link-badge">
              <span class="link-icon">🔗</span>
              <span class="link-text">${escapeHtml(urlObj)}</span>
              <span class="link-arrow">↗</span>
            </a>
          </div>
        </div>

        <!-- Features Summary -->
        <div class="features-summary">
          <div class="features-label">🎯 Detected Features:</div>
          <div class="detections">
            ${pillsHtml}
          </div>
        </div>

        <!-- Notes/Summary -->
        ${notesHtml}

        <!-- Evidence Details (if any features detected) -->
        ${pillsHtml.includes('absent') ? '' : `
          <div class="evidence-section">
            <h3 class="evidence-title">📋 Feature Evidence</h3>
            ${evidenceHtml}
          </div>
        `}
      </div>
    `;
    document.getElementById('stage-content').innerHTML = html;
    return;
  }

  const html = `
    <div class="stage-content">
      <!-- Header with title and link -->
      <div class="stage-header-new">
        <div class="stage-title-section">
          <h2 class="stage-title-large">${stageName}</h2>
          <a href="${escapeHtml(stage.url)}" target="_blank" rel="noopener" class="stage-link-badge">
            <span class="link-icon">🔗</span>
            <span class="link-text">${escapeHtml(urlObj)}</span>
            <span class="link-arrow">↗</span>
          </a>
        </div>
      </div>

      <!-- Features Summary -->
      <div class="features-summary">
        <div class="features-label">🎯 Detected Features:</div>
        <div class="detections">
          ${pillsHtml}
        </div>
      </div>

      <!-- Screenshot -->
      <div class="screenshot-container">
        <img 
          src="${escapeHtml(stage.screenshotUrl)}"
          alt="${stageName}"
          class="screenshot"
          onclick="openModal('${escapeHtml(stage.screenshotUrl)}', '${stageName}')"
        >
      </div>

      <!-- Notes/Summary -->
      ${notesHtml}

      <!-- Evidence Details (if any features detected) -->
      ${pillsHtml.includes('absent') ? '' : `
        <div class="evidence-section">
          <h3 class="evidence-title">📋 Feature Evidence</h3>
          ${evidenceHtml}
        </div>
      `}
    </div>
  `;
  
  document.getElementById('stage-content').innerHTML = html;
}

/**
 * Build detection pills HTML
 */
function buildDetectionPills(detections) {
  const pills = [];

  if (detections.edd.present) {
    pills.push(`<span class="pill edd"><i class="fas fa-calendar"></i> EDD</span>`);
  }

  if (detections.upsells.present) {
    pills.push(`<span class="pill upsells"><i class="fas fa-plus"></i> Upsells</span>`);
  }

  if (detections.fstBar.present) {
    pills.push(`<span class="pill fst"><i class="fas fa-chart-bar"></i> FST Bar</span>`);
  }

  if (detections.shippingAddon.present) {
    pills.push(`<span class="pill addon"><i class="fas fa-shield-alt"></i> Shipping Add-on</span>`);
  }

  if (detections.trustBadges.present) {
    pills.push(`<span class="pill trust"><i class="fas fa-lock"></i> Trust Badges</span>`);
  }

  if (pills.length === 0) {
    pills.push(`<span class="pill absent"><i class="fas fa-info-circle"></i> No features detected</span>`);
  }

  return pills.join('');
}

/**
 * Build evidence sections HTML
 */
function buildEvidenceSections(detections) {
  const sections = [];

  const detectionMap = {
    edd: { label: 'Delivery Promise (EDD)', icon: 'calendar' },
    upsells: { label: 'Upsells / Cross-sells', icon: 'plus' },
    fstBar: { label: 'Free Shipping Threshold', icon: 'chart-bar' },
    shippingAddon: { label: 'Shipping/Returns Add-on', icon: 'shield-alt' },
    trustBadges: { label: 'Trust Badges', icon: 'lock' },
  };

  for (const [key, detection] of Object.entries(detections)) {
    if (detection.evidence && detection.evidence.length > 0) {
      const meta = detectionMap[key] || { label: key, icon: 'info-circle' };
      sections.push(`
        <div class="evidence-section">
          <div class="evidence-title">
            <i class="fas fa-${meta.icon} mr-2"></i>${meta.label}
          </div>
          <ul class="evidence-list">
            ${detection.evidence
              .map(
                evidence =>
                  `<li class="evidence-item">${escapeHtml(evidence)}</li>`
              )
              .join('')}
          </ul>
        </div>
      `);
    }
  }

  return sections.join('');
}

/**
 * Update progress bar and message
 */
function updateProgress(progressPct, status) {
  document.getElementById('progress-bar').style.width = `${progressPct}%`;
  document.getElementById('progress-text').textContent = `${progressPct}%`;

  const messageMap = {
    queued: 'Waiting to start...',
    running: 'Audit in progress... please wait',
    completed: 'Audit completed!',
    failed: 'Audit failed',
  };

  document.getElementById('progress-message').textContent =
    messageMap[status] || 'Processing...';
}

/**
 * Export audit results to CSV
 */
async function exportCSV() {
  if (!currentJobId) {
    showToast('No audit to export', 'error');
    return;
  }

  try {
    const response = await fetch('/api/download-csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: currentJobId }),
    });

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-${currentJobId}.csv`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);

    showToast('CSV exported successfully', 'success');
  } catch (error) {
    console.error('Error exporting CSV:', error);
    showToast('Failed to export CSV', 'error');
  }
}

/**
 * Open image modal
 */
function openModal(imageSrc, title) {
  document.getElementById('modal-image').src = imageSrc;
  document.getElementById('modal-title').textContent = title || 'Screenshot';
  document.getElementById('image-modal').classList.remove('hidden');
}

/**
 * Close image modal
 */
function closeModal() {
  document.getElementById('image-modal').classList.add('hidden');
}

/**
 * Show toast notification
 */
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icons = {
    success: 'check-circle',
    error: 'exclamation-circle',
    info: 'info-circle',
  };

  toast.innerHTML = `
    <div class="toast-content">
      <i class="fas fa-${icons[type] || 'info-circle'}"></i>
      <span>${escapeHtml(message)}</span>
    </div>
  `;

  document.getElementById('toast-container').appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4000);
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Close modal when clicking outside image
 */
document.getElementById('image-modal')?.addEventListener('click', e => {
  if (e.target.id === 'image-modal') {
    closeModal();
  }
});

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('empty-state').classList.remove('hidden');
});

