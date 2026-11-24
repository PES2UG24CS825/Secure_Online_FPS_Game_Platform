/**
 * Cheater Demonstration & Real-Time Detection Feed Controller
 * Powers Phase 8 Admin Demonstration View with live SSE security alerts.
 */

import { escapeHtml } from './admin_core.js';

let isListeningSSE = false;

export async function loadCheaterDemoState() {
  const container = document.getElementById('cheaterDemoSection');
  if (!container) return;

  try {
    const resp = await fetch('/api/admin/demo-cheater/status', {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!resp.ok) return;

    const data = await resp.json();
    container.hidden = !(data.account?.exists || data.active_session || data.alerts?.length);
    renderCheaterDemoData(data);
  } catch (err) {
    console.warn('[AdminDemo] Error loading demo state:', err);
  }
}

export function renderCheaterDemoData(data) {
  if (!data) return;

  // Account Badge
  const badge = document.getElementById('demoAccountBadge');
  if (badge) {
    if (data.active_session) {
      badge.className = 'badge badge-emerald';
      badge.textContent = `cheater_demo: MATCH ACTIVE (${data.active_session.session_id})`;
    } else if (data.account?.exists) {
      badge.className = 'badge badge-purple';
      badge.textContent = `cheater_demo: PROVISIONED & READY`;
    } else {
      badge.className = 'badge badge-amber';
      badge.textContent = `cheater_demo: NOT PROVISIONED`;
    }
  }

  // ML Analysis & Cards
  const analysis = data.latest_analysis;
  const riskVal = document.getElementById('demoRiskScoreVal');
  const riskCat = document.getElementById('demoRiskCategory');
  const rfDec = document.getElementById('demoRfDecisionVal');
  const rfProb = document.getElementById('demoRfProbVal');
  const ifDec = document.getElementById('demoIfDecisionVal');
  const ifAnom = document.getElementById('demoIfAnomalyVal');
  const violCount = document.getElementById('demoViolationCountVal');

  if (violCount && data.violation_counts) {
    violCount.textContent = data.violation_counts.total || 0;
  }

  if (analysis) {
    if (riskVal) {
      const score = Number.isFinite(analysis.risk_score) ? Math.round(analysis.risk_score) : null;
      riskVal.textContent = score ?? 'Unavailable';
      riskVal.style.color = score >= 75 ? '#ef4444' : score >= 50 ? '#f59e0b' : '#10b981';
    }
    if (riskCat) {
      riskCat.textContent = analysis.alert_severity
        ? `Severity: ${analysis.alert_severity.toUpperCase()} • Session: ${analysis.session_id || '—'}`
        : 'Severity unavailable';
      const reasons = [];
      if (Number.isFinite(analysis.model_risk_score)) reasons.push(`Raw model score ${analysis.model_risk_score.toFixed(1)}/100`);
      if (analysis.risk_calibration) reasons.push(`Calibration: ${analysis.risk_calibration.replaceAll('_', ' ')}`);
      if (analysis.risk_explanation) reasons.push(analysis.risk_explanation);
      if (analysis.created_at) reasons.push(new Date(analysis.created_at).toLocaleString());
      riskCat.textContent += reasons.length ? ` · ${reasons.join(' · ')}` : '';
    }
    if (rfDec) {
      rfDec.textContent = (analysis.random_forest || 'monitoring').toUpperCase();
      rfDec.style.color = analysis.random_forest === 'cheater' ? '#ef4444' : '#38bdf8';
    }
    if (rfProb) {
      const prob = analysis.random_forest_probability != null
        ? `${Math.round(analysis.random_forest_probability * 100)}%`
        : '—';
      rfProb.textContent = `Cheater Probability: ${prob}`;
    }
    if (ifDec) {
      ifDec.textContent = (analysis.isolation_forest || 'monitoring').toUpperCase();
      ifDec.style.color = analysis.isolation_forest === 'anomaly' ? '#ef4444' : '#c084fc';
    }
    if (ifAnom) {
      const anom = analysis.isolation_forest_anomaly_score != null
        ? Number(analysis.isolation_forest_anomaly_score).toFixed(3)
        : '—';
      ifAnom.textContent = `Anomaly Score: ${anom}`;
    }

    // Five-Feature Telemetry Contract
    const feat = analysis.features || {};
    const featAcc = document.getElementById('demoFeatAccuracy');
    const featFR = document.getElementById('demoFeatFireRate');
    const featSpd = document.getElementById('demoFeatSpeed');
    const featSm = document.getElementById('demoFeatSmoothness');
    const featKdr = document.getElementById('demoFeatKdr');

    if (featAcc) featAcc.textContent = feat.accuracy != null ? `${(feat.accuracy * 100).toFixed(1)}%` : '—';
    if (featFR) featFR.textContent = feat.fire_rate != null ? `${Number(feat.fire_rate).toFixed(1)} shots/s` : '—';
    if (featSpd) featSpd.textContent = feat.movement_speed != null ? `${Number(feat.movement_speed).toFixed(1)} m/s` : '—';
    if (featSm) featSm.textContent = feat.aim_smoothness != null ? Number(feat.aim_smoothness).toFixed(2) : '—';
    if (featKdr) featKdr.textContent = feat.kdr != null ? Number(feat.kdr).toFixed(2) : '—';
  }

  // Alerts Feed
  const feed = document.getElementById('demoAlertsFeed');
  if (feed && Array.isArray(data.alerts)) {
    if (data.alerts.length === 0) {
      feed.innerHTML = `<div class="empty" id="demoAlertsEmpty">No simulated cheat violations recorded yet. Launch CyberStrike 3D with cheater_demo to trigger real-time detection.</div>`;
    } else {
      feed.innerHTML = data.alerts.map(renderAlertCardHtml).join('');
    }
  }
}

export function handleLiveDemoAlert(payload) {
  if (!payload) return;
  const isDemo = payload.is_demo || payload.environment === 'DEMONSTRATION' || payload.player_name === 'cheater_demo';
  if (!isDemo) return;

  const feed = document.getElementById('demoAlertsFeed');
  const emptyMsg = document.getElementById('demoAlertsEmpty');
  if (emptyMsg) emptyMsg.remove();

  if (feed) {
    const alertHtml = renderAlertCardHtml({
      id: 'live-' + Date.now(),
      event_type: payload.alert_type || payload.event_type || 'violation',
      severity: payload.severity || 'critical',
      violation: payload.violation || 'Suspicious demo event detected',
      observed_value: payload.observed_value || '—',
      allowed_value: payload.allowed_value || '—',
      evidence: payload.evidence || {},
      source: payload.source || 'Server-verified demo event',
      environment: 'DEMONSTRATION',
      player_name: payload.player_name || 'cheater_demo',
      session_id: payload.session_id || payload.demo_session_id || '—',
      created_at: payload.timestamp || payload.created_at || new Date().toISOString()
    });

    feed.insertAdjacentHTML('afterbegin', alertHtml);

    // Bump violation count
    const violCount = document.getElementById('demoViolationCountVal');
    if (violCount) {
      const cur = parseInt(violCount.textContent || '0', 10);
      violCount.textContent = cur + 1;
    }
  }
}

function renderAlertCardHtml(alert) {
  const isCritical = alert.severity === 'critical';
  const badgeClass = isCritical ? 'badge-rose' : 'badge-amber';
  const borderCol = isCritical ? 'rgba(239, 68, 68, 0.4)' : 'rgba(245, 158, 11, 0.4)';
  const bgCol = isCritical ? 'rgba(239, 68, 68, 0.08)' : 'rgba(245, 158, 11, 0.08)';

  const timeStr = alert.created_at
    ? new Date(alert.created_at).toLocaleTimeString()
    : 'Just now';

  let evidenceDetails = '';
  if (alert.evidence && typeof alert.evidence === 'object') {
    const items = Object.entries(alert.evidence)
      .filter(([k, v]) => v !== null && v !== undefined && k !== 'timestamp')
      .map(([k, v]) => {
        let valStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
        return `<span style="color:#94a3b8;">${escapeHtml(k)}:</span> <b style="color:#e2e8f0;">${escapeHtml(valStr)}</b>`;
      });
    if (items.length > 0) {
      evidenceDetails = `<div style="margin-top:6px; font-size:11px; background:rgba(0,0,0,0.3); padding:4px 8px; border-radius:4px; display:flex; flex-wrap:wrap; gap:10px;">${items.join(' • ')}</div>`;
    }
  }

  return `
    <div class="demo-alert-item" style="border: 1px solid ${borderCol}; background: ${bgCol}; border-radius: 6px; padding: 10px 14px; animation: alertPulse 0.4s ease-out;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="badge ${badgeClass}" style="font-weight: 700; font-size: 10px;">${escapeHtml((alert.severity || 'high').toUpperCase())}</span>
          <strong style="color: #f1f5f9; font-size: 13px;">${escapeHtml(alert.violation || 'Violation Detected')}</strong>
        </div>
        <span style="font-size: 11px; color: #94a3b8;">${escapeHtml(timeStr)}</span>
      </div>
      <div style="font-size: 12px; color: #cbd5e1; display: flex; flex-wrap: wrap; gap: 14px;">
        <span>Player: <code style="color:#38bdf8;">${escapeHtml(alert.player_name || 'cheater_demo')}</code></span>
        <span>Session: <code>${escapeHtml(String(alert.session_id || '—'))}</code></span>
        <span>Observed: <b style="color:#f87171;">${escapeHtml(String(alert.observed_value))}</b></span>
        <span>Allowed Limit: <b style="color:#34d399;">${escapeHtml(String(alert.allowed_value))}</b></span>
        <span style="color: #a78bfa;">Env: DEMONSTRATION</span>
      </div>
      ${evidenceDetails}
    </div>
  `;
}

export function initCheaterDemoControls() {
  const refreshBtn = document.getElementById('refreshDemoFeedBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadCheaterDemoState());
  }

  const resetBtn = document.getElementById('resetDemoAlertsBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      if (!confirm('Clear all historical demonstration security alerts?')) return;
      try {
        const resp = await fetch('/api/admin/demo-cheater/reset', {
          method: 'POST',
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' }
        });
        if (resp.ok) {
          loadCheaterDemoState();
        }
      } catch (err) {
        console.warn('[AdminDemo] Error clearing demo alerts:', err);
      }
    });
  }

  // Load initial state
  loadCheaterDemoState();
}
