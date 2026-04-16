/**
 * Side Panel Controller (v3)
 *
 * Drives the 4-step UI and listens for real-time progress updates
 * from the background service worker.
 *
 * Progress granularity for DM sending:
 *   Per user: navigating → clickingMessage → waitingDM → typing → sending → done/error
 */

document.addEventListener('DOMContentLoaded', async () => {

  // ─── DOM refs ───
  const steps = { 1: $('step1'), 2: $('step2'), 3: $('step3'), 4: $('step4') };
  const stepDots = document.querySelectorAll('.step-dot');

  // Step 1
  const postUrlInput     = $('postUrl');
  const keywordsInput    = $('keywords');
  const dmTemplateInput  = $('dmTemplate');
  const delayInput       = $('delaySeconds');
  const autoSendToggle   = $('autoSend');
  const btnStartScan     = $('btnStartScan');

  // Step 2
  const scanProgressBar  = $('scanProgressBar');
  const scanLiveLog      = $('scanLiveLog');
  const btnCancelScan    = $('btnCancelScan');

  // Step 3
  const matchSummary     = $('matchSummary');
  const matchedList      = $('matchedList');
  const btnSelectAll     = $('btnSelectAll');
  const btnDeselectAll   = $('btnDeselectAll');
  const selectedCount    = $('selectedCount');
  const dmPreview        = $('dmPreview');
  const btnBackToConfig  = $('btnBackToConfig');
  const btnStartDMs      = $('btnStartDMs');

  // Step 4
  const dmProgressBar    = $('dmProgressBar');
  const dmStatusText     = $('dmStatusText');
  const dmLiveLog        = $('dmLiveLog');
  const dmActiveActions  = $('dmActiveActions');
  const dmDoneActions    = $('dmDoneActions');
  const btnPauseDMs      = $('btnPauseDMs');
  const btnNewCampaign   = $('btnNewCampaign');

  // Pending Follows (Plan B)
  const pendingSection   = $('pendingSection');
  const pendingToggle    = $('pendingToggle');
  const pendingBody      = $('pendingBody');
  const pendingBadge     = $('pendingBadge');
  const pendingList      = $('pendingList');
  const btnRetryPending  = $('btnRetryPending');
  const btnClearPending  = $('btnClearPending');

  // ─── State ───
  let currentStep = 1;
  let matchedUsers = [];
  let pollTimer = null;

  // ─── Init ───
  await loadLastConfig();
  await restoreState();
  await refreshPendingFollows();

  // ─── Listen for real-time progress from background ───
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'progressUpdate') {
      handleProgressUpdate(msg);
    }
    if (msg.action === 'dmProgressUpdate') {
      handleDMProgressUpdate(msg);
    }
  });

  // ═══════════════════════════════════════════
  //  STEP NAVIGATION
  // ═══════════════════════════════════════════

  function goToStep(n) {
    currentStep = n;
    Object.values(steps).forEach(el => el.classList.remove('active'));
    steps[n].classList.add('active');
    stepDots.forEach(dot => {
      const s = parseInt(dot.dataset.step);
      dot.classList.toggle('active', s === n);
      dot.classList.toggle('completed', s < n);
    });
  }

  // ═══════════════════════════════════════════
  //  STEP 1: CONFIGURE
  // ═══════════════════════════════════════════

  btnStartScan.addEventListener('click', async () => {
    const postUrl = postUrlInput.value.trim();
    const keywords = keywordsInput.value.split(',').map(k => k.trim()).filter(Boolean);
    const dmTemplate = dmTemplateInput.value.trim();
    const delaySec = parseInt(delayInput.value) || 30;

    if (!postUrl || !postUrl.includes('instagram.com/')) return flash(postUrlInput);
    if (!keywords.length) return flash(keywordsInput);
    if (!dmTemplate) return flash(dmTemplateInput);

    btnStartScan.disabled = true;
    btnStartScan.textContent = 'Starting...';

    // Clear scan log
    scanLiveLog.innerHTML = '';
    scanProgressBar.style.width = '10%';
    addScanLog('Initializing scan...', 'info');

    goToStep(2);

    const isAutoSend = autoSendToggle.checked;

    try {
      const result = await bg({ action: 'startScan', postUrl, keywords, dmTemplate, delaySeconds: delaySec, autoSend: isAutoSend });

      if (result.matchedUsers) {
        matchedUsers = result.matchedUsers;
        scanProgressBar.style.width = '100%';
        addScanLog(`Scan complete! Found ${matchedUsers.length} matching commenters.`, 'success');
        await sleep(600);

        if (isAutoSend && matchedUsers.length > 0) {
          // Full automation: skip review, go straight to sending
          addScanLog('Full Automation enabled — sending DMs to all matched users...', 'info');
          await sleep(400);
          await startDMsForUsers(matchedUsers);
        } else {
          renderMatchedUsers();
          goToStep(3);
        }
      }
    } catch (e) {
      addScanLog('Error: ' + e.message, 'error');
    } finally {
      btnStartScan.disabled = false;
      btnStartScan.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg> Start Scanning`;
    }
  });

  btnCancelScan.addEventListener('click', async () => {
    await bg({ action: 'cancelScan' });
    goToStep(1);
  });

  // ─── Scan progress handler ───
  function handleProgressUpdate(msg) {
    if (msg.step === 'scan') {
      addScanLog(msg.detail, msg.type || 'info');
      if (msg.type !== 'success' && msg.type !== 'error') {
        scanProgressBar.style.width = '50%';
      }
    }
    if (msg.step === 'dmDone') {
      // Final done
      pollDMState();
    }
  }

  function addScanLog(text, type = 'info') {
    const iconMap = { info: '\u2139\uFE0F', success: '\u2705', error: '\u274C' };
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `
      <div class="log-icon ${type}">${iconMap[type] || '\u2139\uFE0F'}</div>
      <div class="log-body"><div class="log-detail">${text}</div></div>
      <div class="log-time">${timeNow()}</div>
    `;
    scanLiveLog.appendChild(entry);
    scanLiveLog.scrollTop = scanLiveLog.scrollHeight;
  }

  // ═══════════════════════════════════════════
  //  STEP 3: REVIEW
  // ═══════════════════════════════════════════

  function renderMatchedUsers() {
    matchSummary.textContent = `${matchedUsers.length} user(s) commented with your keyword(s).`;

    if (!matchedUsers.length) {
      matchedList.innerHTML = '<div class="empty-state">No matching comments found.</div>';
      btnStartDMs.disabled = true;
      return;
    }

    bg({ action: 'getHistory' }).then(({ history }) => {
      const sentSet = new Set((history || []).filter(h => h.status === 'success').map(h => h.username));

      matchedList.innerHTML = matchedUsers.map((u, i) => `
        <div class="match-item">
          <input type="checkbox" class="match-cb" data-i="${i}" ${sentSet.has(u.username) ? '' : 'checked'} />
          <div class="match-avatar">${u.username[0].toUpperCase()}</div>
          <div class="match-info">
            <div class="match-username">
              @${u.username}
              ${sentSet.has(u.username) ? '<span class="already-sent">Already sent</span>' : ''}
            </div>
            <div class="match-comment">"${u.comment}" <span class="match-keyword">${u.matchedKeyword}</span></div>
          </div>
        </div>
      `).join('');

      matchedList.querySelectorAll('.match-cb').forEach(cb => cb.addEventListener('change', updateCount));
      updateCount();
    });

    const preview = dmTemplateInput.value.trim().replace(/\{\{username\}\}/gi, matchedUsers[0]?.username || 'username');
    dmPreview.textContent = preview;
  }

  function updateCount() {
    const n = matchedList.querySelectorAll('.match-cb:checked').length;
    selectedCount.textContent = `${n} selected`;
    btnStartDMs.disabled = n === 0;
  }

  btnSelectAll.addEventListener('click', () => {
    matchedList.querySelectorAll('.match-cb').forEach(cb => cb.checked = true);
    updateCount();
  });

  btnDeselectAll.addEventListener('click', () => {
    matchedList.querySelectorAll('.match-cb').forEach(cb => cb.checked = false);
    updateCount();
  });

  btnBackToConfig.addEventListener('click', async () => {
    await bg({ action: 'reset' });
    goToStep(1);
  });

  // ═══════════════════════════════════════════
  //  STEP 3 → 4: START DMs
  // ═══════════════════════════════════════════

  /** Shared function to initiate DM sending for a list of users */
  async function startDMsForUsers(users) {
    // Prepare DM log
    dmLiveLog.innerHTML = '';
    dmProgressBar.style.width = '0%';
    dmStatusText.textContent = `Sending DMs: 0 / ${users.length}`;
    dmDoneActions.style.display = 'none';
    dmActiveActions.style.display = 'flex';
    btnPauseDMs.textContent = 'Pause';

    // Pre-populate log entries for all users
    users.forEach(u => {
      addDMUserEntry(u.username, 'pending');
    });

    goToStep(4);

    await bg({ action: 'startSendingDMs', selectedUsers: users });

    // Start polling for state
    startDMPolling(users);
  }

  btnStartDMs.addEventListener('click', async () => {
    const indices = [];
    matchedList.querySelectorAll('.match-cb:checked').forEach(cb => indices.push(parseInt(cb.dataset.i)));
    const selected = indices.map(i => matchedUsers[i]);
    if (!selected.length) return;

    await startDMsForUsers(selected);
  });

  // ═══════════════════════════════════════════
  //  STEP 4: DM PROGRESS
  // ═══════════════════════════════════════════

  // Sub-step labels
  const substepLabels = {
    navigating:      'Opening profile...',
    clickingMessage: 'Clicking "Message" button...',
    following:       'Following user (no Message button)...',
    followed:        'Followed — saved to retry queue',
    waitingDM:       'Waiting for DM to open...',
    typing:          'Typing message...',
    sending:         'Sending message...',
    done:            'DM sent!',
    error:           'Error',
    waiting:         'Waiting before next DM...'
  };

  const substepOrder = ['navigating', 'clickingMessage', 'waitingDM', 'typing', 'done'];

  function handleDMProgressUpdate(msg) {
    const { username, substep, detail, currentIndex, total, sentLog } = msg;

    // Update overall progress
    const pct = total > 0 ? Math.round(((sentLog?.length || 0) / total) * 100) : 0;
    dmProgressBar.style.width = `${pct}%`;
    dmStatusText.textContent = `Sending DMs: ${sentLog?.length || 0} / ${total}`;

    if (username) {
      updateDMUserEntry(username, substep, detail);
    }

    // Check if done
    if (sentLog && sentLog.length >= total) {
      const successCount = sentLog.filter(l => l.status === 'success').length;
      const followedCount = sentLog.filter(l => l.status === 'followed').length;
      dmProgressBar.style.width = '100%';
      let statusMsg = `Complete! ${successCount} / ${total} DMs sent.`;
      if (followedCount > 0) statusMsg += ` ${followedCount} followed (pending).`;
      dmStatusText.textContent = statusMsg;
      dmDoneActions.style.display = 'flex';
      dmActiveActions.style.display = 'none';
      clearInterval(pollTimer);
      refreshPendingFollows();
    }
  }

  function addDMUserEntry(username, status) {
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.id = `dm-user-${username}`;
    entry.innerHTML = `
      <div class="log-icon pending"></div>
      <div class="log-body">
        <div class="log-username">@${username}</div>
        <div class="log-substeps" id="dm-substeps-${username}">
          ${substepOrder.map(s => `
            <div class="log-substep waiting" data-substep="${s}">
              <span class="substep-icon">\u25CB</span>
              <span>${substepLabels[s]}</span>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="log-time" id="dm-time-${username}"></div>
    `;
    dmLiveLog.appendChild(entry);
  }

  function updateDMUserEntry(username, substep, detail) {
    const entry = document.getElementById(`dm-user-${username}`);
    if (!entry) return;

    const icon = entry.querySelector('.log-icon');
    const timeEl = document.getElementById(`dm-time-${username}`);

    // Update icon
    if (substep === 'done') {
      icon.className = 'log-icon success';
      icon.textContent = '\u2705';
    } else if (substep === 'error') {
      icon.className = 'log-icon error';
      icon.textContent = '\u274C';
    } else {
      icon.className = 'log-icon active';
      icon.textContent = '';
    }

    // Update sub-steps
    const container = document.getElementById(`dm-substeps-${username}`);
    if (!container) return;

    const allSubsteps = container.querySelectorAll('.log-substep');
    let reachedCurrent = false;

    for (const el of allSubsteps) {
      const s = el.dataset.substep;

      if (substep === 'error') {
        // Mark current as error, rest as waiting
        if (s === substep || (!reachedCurrent && s !== 'done')) {
          // Find the active one and mark it error
        }
        // Simple: mark all up to current as done, current as error
        const idx = substepOrder.indexOf(s);
        const errIdx = substepOrder.indexOf('done'); // error replaces done
        if (idx < substepOrder.length - 1) {
          // Check if this step was before the error
          el.className = 'log-substep done';
          el.querySelector('.substep-icon').textContent = '\u2713';
        }
      } else if (s === substep) {
        el.className = 'log-substep active';
        el.querySelector('.substep-icon').textContent = '\u25CF';
        if (detail) el.querySelector('span:last-child').textContent = detail;
        reachedCurrent = true;
      } else if (!reachedCurrent) {
        el.className = 'log-substep done';
        el.querySelector('.substep-icon').textContent = '\u2713';
      } else {
        el.className = 'log-substep waiting';
        el.querySelector('.substep-icon').textContent = '\u25CB';
      }
    }

    // Handle error — replace the "done" substep with error message
    if (substep === 'error') {
      const doneEl = container.querySelector('[data-substep="done"]');
      if (doneEl) {
        doneEl.className = 'log-substep error';
        doneEl.querySelector('.substep-icon').textContent = '\u2717';
        doneEl.querySelector('span:last-child').textContent = detail || 'Error';
      }
    }

    // Handle followed (Plan B) — replace remaining substeps with followed status
    if (substep === 'following' || substep === 'followed') {
      // Mark navigating and clickingMessage as done
      for (const el of allSubsteps) {
        const s = el.dataset.substep;
        if (s === 'navigating') {
          el.className = 'log-substep done';
          el.querySelector('.substep-icon').textContent = '\u2713';
        } else if (s === 'clickingMessage') {
          el.className = 'log-substep done';
          el.querySelector('.substep-icon').textContent = '\u2713';
          el.querySelector('span:last-child').textContent = 'No Message button found';
        } else if (s === 'waitingDM' || s === 'typing') {
          el.style.display = 'none';
        } else if (s === 'done') {
          if (substep === 'followed') {
            el.className = 'log-substep followed';
            el.querySelector('.substep-icon').textContent = '\uD83D\uDC64';
            el.querySelector('span:last-child').textContent = detail || 'Followed — saved to retry queue';
          } else {
            el.className = 'log-substep active';
            el.querySelector('.substep-icon').textContent = '\u25CF';
            el.querySelector('span:last-child').textContent = detail || 'Following user...';
          }
        }
      }
      // Update entry icon
      if (substep === 'followed') {
        icon.className = 'log-icon followed';
        icon.textContent = '';
      }
    }

    if (substep === 'done' || substep === 'error') {
      if (timeEl) timeEl.textContent = timeNow();
    }

    // Auto-scroll
    dmLiveLog.scrollTop = dmLiveLog.scrollHeight;
  }

  function startDMPolling(selectedUsers) {
    pollTimer = setInterval(async () => {
      try {
        const s = await bg({ action: 'getState' });
        if (s.status === 'done') {
          clearInterval(pollTimer);
          const successCount = (s.sentLog || []).filter(l => l.status === 'success').length;
          dmProgressBar.style.width = '100%';
          dmStatusText.textContent = `Complete! ${successCount} / ${selectedUsers.length} DMs sent.`;
          dmDoneActions.style.display = 'flex';
          dmActiveActions.style.display = 'none';
        } else if (s.status === 'paused') {
          dmStatusText.textContent = `Paused — ${s.sentLog?.length || 0} / ${selectedUsers.length} processed`;
          btnPauseDMs.textContent = 'Resume';
        } else {
          btnPauseDMs.textContent = 'Pause';
        }
      } catch (e) { /* ignore */ }
    }, 2000);
  }

  async function pollDMState() {
    const s = await bg({ action: 'getState' });
    if (s.status === 'done') {
      clearInterval(pollTimer);
      const total = s.selectedUsers?.length || 0;
      const successCount = (s.sentLog || []).filter(l => l.status === 'success').length;
      dmProgressBar.style.width = '100%';
      dmStatusText.textContent = `Complete! ${successCount} / ${total} DMs sent.`;
      dmDoneActions.style.display = 'flex';
      dmActiveActions.style.display = 'none';
    }
  }

  btnPauseDMs.addEventListener('click', async () => {
    const s = await bg({ action: 'getState' });
    if (s.status === 'paused') {
      await bg({ action: 'resumeDMs' });
      btnPauseDMs.textContent = 'Pause';
    } else {
      await bg({ action: 'pauseDMs' });
      btnPauseDMs.textContent = 'Resume';
    }
  });

  btnNewCampaign.addEventListener('click', async () => {
    clearInterval(pollTimer);
    await bg({ action: 'reset' });
    await refreshPendingFollows();
    goToStep(1);
  });

  // ═════════════════════════════════════════
  //  PENDING FOLLOWS (Plan B)
  // ═════════════════════════════════════════

  async function refreshPendingFollows() {
    try {
      const { pendingFollows } = await bg({ action: 'getPendingFollows' });
      if (pendingFollows && pendingFollows.length > 0) {
        pendingSection.style.display = 'block';
        pendingBadge.textContent = pendingFollows.length;

        pendingList.innerHTML = pendingFollows.map(u => {
          const statusClass = (u.followStatus || '').toLowerCase().includes('request') ? 'requested' : 'following';
          const statusLabel = u.alreadyFollowing ? 'Already following' : (u.followStatus || 'Followed');
          const timeAgo = u.timestamp ? new Date(u.timestamp).toLocaleDateString() : '';
          return `
            <div class="pending-user">
              <div class="pending-avatar">${(u.username || '?')[0].toUpperCase()}</div>
              <div class="pending-info">
                <div class="pending-username">@${u.username}</div>
                <div class="pending-status">
                  <span class="pending-status-badge ${statusClass}">${statusLabel}</span>
                  ${timeAgo ? `<span style="margin-left:4px;font-size:10px;color:var(--text-muted)">${timeAgo}</span>` : ''}
                </div>
              </div>
            </div>
          `;
        }).join('');
      } else {
        pendingSection.style.display = 'none';
      }
    } catch (e) {
      pendingSection.style.display = 'none';
    }
  }

  pendingToggle.addEventListener('click', () => {
    const isOpen = pendingBody.style.display !== 'none';
    pendingBody.style.display = isOpen ? 'none' : 'block';
    pendingToggle.classList.toggle('open', !isOpen);
  });

  btnRetryPending.addEventListener('click', async () => {
    const dmTemplate = dmTemplateInput.value.trim();
    const delaySec = parseInt(delayInput.value) || 30;
    if (!dmTemplate) {
      flash(dmTemplateInput);
      goToStep(1);
      return;
    }

    const { pendingFollows } = await bg({ action: 'getPendingFollows' });
    if (!pendingFollows || !pendingFollows.length) return;

    // Clear pending queue before retrying
    await bg({ action: 'clearPendingFollows' });

    // Start DMs for pending users
    await startDMsForUsers(pendingFollows.map(p => ({
      username: p.username,
      comment: p.comment || '',
      matchedKeyword: p.matchedKeyword || ''
    })));
  });

  btnClearPending.addEventListener('click', async () => {
    await bg({ action: 'clearPendingFollows' });
    await refreshPendingFollows();
  });

  // ═══════════════════════════════════════════
  //  RESTORE STATE
  // ═══════════════════════════════════════════

  async function restoreState() {
    try {
      const s = await bg({ action: 'getState' });
      if (s.status === 'reviewing') {
        matchedUsers = s.matchedUsers || [];
        renderMatchedUsers();
        goToStep(3);
      } else if (s.status === 'sending' || s.status === 'paused') {
        goToStep(4);
        dmLiveLog.innerHTML = '';
        (s.selectedUsers || []).forEach(u => addDMUserEntry(u.username, 'pending'));
        // Update already-processed entries
        (s.sentLog || []).forEach(log => {
          const st = log.status === 'success' ? 'done' : (log.status === 'followed' ? 'followed' : 'error');
          updateDMUserEntry(log.username, st, log.message);
        });
        startDMPolling(s.selectedUsers || []);
      } else if (s.status === 'done') {
        matchedUsers = s.matchedUsers || [];
        goToStep(4);
        const total = s.selectedUsers?.length || 0;
        const successCount = (s.sentLog || []).filter(l => l.status === 'success').length;
        dmStatusText.textContent = `Complete! ${successCount} / ${total} DMs sent.`;
        dmProgressBar.style.width = '100%';
        dmDoneActions.style.display = 'flex';
        dmActiveActions.style.display = 'none';
        dmLiveLog.innerHTML = '';
        (s.selectedUsers || []).forEach(u => addDMUserEntry(u.username, 'pending'));
        (s.sentLog || []).forEach(log => {
          const st = log.status === 'success' ? 'done' : (log.status === 'followed' ? 'followed' : 'error');
          updateDMUserEntry(log.username, st, log.message);
        });
      }
    } catch (e) { /* fresh */ }
  }

  async function loadLastConfig() {
    try {
      const { config } = await bg({ action: 'getLastConfig' });
      if (config) {
        if (config.postUrl) postUrlInput.value = config.postUrl;
        if (config.keywords) keywordsInput.value = config.keywords.join(', ');
        if (config.dmTemplate) dmTemplateInput.value = config.dmTemplate;
        if (config.delaySeconds) delayInput.value = config.delaySeconds;
        if (config.autoSend) autoSendToggle.checked = config.autoSend;
      }
    } catch (e) {}
  }

  // ═══════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════

  function $(id) { return document.getElementById(id); }

  function bg(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, r => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(r || {});
      });
    });
  }

  function flash(input) {
    input.style.borderColor = '#ed4956';
    input.style.boxShadow = '0 0 0 3px rgba(237,73,86,0.15)';
    setTimeout(() => { input.style.borderColor = ''; input.style.boxShadow = ''; }, 2000);
  }

  function timeNow() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

});
