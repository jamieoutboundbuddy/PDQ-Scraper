/**
 * Frontend JavaScript for eCommerce Checkout Auditor
 */

let currentJobId = null;
let pollInterval = null;

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
  document.getElementById('timeline').innerHTML = '';
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

    const data = await response.json();
    currentJobId = data.jobId;

    showToast(`Audit started for ${domain}`, 'success');

    // Start polling
    pollJob();
  } catch (error) {
    console.error('Error starting audit:', error);
    showToast('Failed to start audit', 'error');
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

  // Reset UI
  document.getElementById('timeline').innerHTML = '';
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('timeline-section').classList.remove('hidden');
  document.getElementById('progress-section').classList.remove('hidden');

  try {
    // Create batch audit
    const response = await fetch('/api/audit-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domains }),
    });

    const data = await response.json();
    currentJobId = data.jobIds[0]; // Track first job for progress

    showToast(`Batch audit started for ${domains.length} domains`, 'success');

    // Start polling
    pollJob();
  } catch (error) {
    console.error('Error starting batch audit:', error);
    showToast('Failed to start batch audit', 'error');
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

    // Render stages
    const timeline = document.getElementById('timeline');
    job.stages.forEach((stage, index) => {
      const stageId = `stage-${stage.key}`;
      if (!document.getElementById(stageId)) {
        const card = createStageCard(stage, index);
        timeline.insertAdjacentHTML('beforeend', card);
      }
    });

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
 * Create stage card HTML
 */
function createStageCard(stage, index) {
  const stageNames = {
    homepage: '🏠 Homepage',
    product: '📦 Product Page',
    cart: '🛒 Cart',
    checkout_contact: '✉️ Contact Info',
    checkout_shipping: '📍 Shipping',
    checkout_payment: '💳 Payment',
  };

  const stageName = stageNames[stage.key] || stage.key;

  // Build detection pills
  const pillsHtml = buildDetectionPills(stage.detections);

  // Build evidence sections
  const evidenceHtml = buildEvidenceSections(stage.detections);

  // Build notes
  const notesHtml = stage.notes.length > 0
    ? `<div class="notes">
         ${stage.notes.map(note => `<p>${escapeHtml(note)}</p>`).join('')}
       </div>`
    : '';

  return `
    <div class="stage-card ${stage.detections.edd.present ? 'has-edd' : 'no-edd'}" id="stage-${stage.key}">
      <div class="stage-header">
        <div>
          <h3 class="stage-title">${stageName}</h3>
          <p class="stage-url">${escapeHtml(stage.url)}</p>
        </div>
      </div>

      <!-- Screenshot -->
      <img 
        src="${escapeHtml(stage.screenshotUrl)}"
        alt="${stageName}"
        class="screenshot"
        onclick="openModal('${escapeHtml(stage.screenshotUrl)}', '${stageName}')"
      >

      <!-- Detections -->
      <div class="detections">
        ${pillsHtml}
      </div>

      <!-- Evidence -->
      <div>
        ${evidenceHtml}
      </div>

      <!-- Notes -->
      ${notesHtml}
    </div>
  `;
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

