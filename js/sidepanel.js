/**
 * Side Panel Controller (v7)
 *
 * Two modes:
 *   1. Bulk Outreach (primary) — handle list, templates, status lights, history, cadence
 *   2. Keyword Scan — scan post comments for keywords, send DMs
 *
 * New in v7:
 *   - Dashboard sub-tab with stats grid, 7-day activity chart, outcome breakdown, session health
 *   - CSV Import: parse CSV/TXT files into handles textarea
 *   - CSV Export: download handles list or full history as CSV
 *   - Dashboard is the default active sub-tab in Bulk Outreach
 *
 * Previous versions:
 *   v6: Multi-platform (Instagram + Threads), session health monitoring, DM reliability
 *   v5: Three-light status, history, cadence follow-ups, full automation toggle
 */

document.addEventListener('DOMContentLoaded', async () => {

  // ─── DOM refs: Mode Tabs ───
  const modeTabs = document.querySelectorAll('.mode-tab');
  const modePanels = { outreach: $('modeOutreach'), keyword: $('modeKeyword') };

  // ─── DOM refs: Keyword Scan ───
  const steps = { 1: $('step1'), 2: $('step2'), 3: $('step3'), 4: $('step4') };
  const stepDots = document.querySelectorAll('.step-dot');

  const postUrlInput     = $('postUrl');
  const keywordsInput    = $('keywords');
  const dmTemplateInput  = $('dmTemplate');
  const delayInput       = $('delaySeconds');
  const autoSendToggle   = $('autoSend');
  const btnStartScan     = $('btnStartScan');

  const scanProgressBar  = $('scanProgressBar');
  const scanLiveLog      = $('scanLiveLog');
  const btnCancelScan    = $('btnCancelScan');

  const matchSummary     = $('matchSummary');
  const matchedList      = $('matchedList');
  const btnSelectAll     = $('btnSelectAll');
  const btnDeselectAll   = $('btnDeselectAll');
  const selectedCount    = $('selectedCount');
  const dmPreview        = $('dmPreview');
  const btnBackToConfig  = $('btnBackToConfig');
  const btnStartDMs      = $('btnStartDMs');

  const dmProgressBar    = $('dmProgressBar');
  const dmStatusText     = $('dmStatusText');
  const dmLiveLog        = $('dmLiveLog');
  const dmActiveActions  = $('dmActiveActions');
  const dmDoneActions    = $('dmDoneActions');
  const btnPauseDMs      = $('btnPauseDMs');
  const btnBackToConfigDM = $('btnBackToConfigFromDM');
  const btnNewCampaign   = $('btnNewCampaign');

  const pendingSection   = $('pendingSection');
  const pendingToggle    = $('pendingToggle');
  const pendingBody      = $('pendingBody');
  const pendingBadge     = $('pendingBadge');
  const pendingList      = $('pendingList');
  const btnRetryPending  = $('btnRetryPending');
  const btnClearPending  = $('btnClearPending');

  // ─── DOM refs: Bulk Outreach ───
  const subTabs          = document.querySelectorAll('.sub-tab');
  const subPanels        = {
    'bo-dashboard': $('bo-dashboard'),
    'bo-outreach': $('bo-outreach'),
    'bo-history': $('bo-history'),
    'bo-waitlist': $('bo-waitlist'),
    'bo-templates': $('bo-templates')
  };

  // ─── DOM refs: Dashboard ───
  const statDMsToday     = $('statDMsToday');
  const statDMsWeek      = $('statDMsWeek');
  const statSuccessRate  = $('statSuccessRate');
  const statWaitlist     = $('statWaitlist');
  const activityChart    = $('activityChart');
  const outcomeChart     = $('outcomeChart');
  const sessionHealthDisplay = $('sessionHealthDisplay');

  // ─── DOM refs: CSV Import/Export ───
  const btnImportCSV     = $('btnImportCSV');
  const btnExportCSV     = $('btnExportCSV');
  const csvFileInput     = $('csvFileInput');
  const btnExportHistory = $('btnExportHistory');

  // Templates
  const templatesList    = $('templatesList');
  const newTemplateName  = $('newTemplateName');
  const newTemplateBody  = $('newTemplateBody');
  const btnAddTemplate   = $('btnAddTemplate');

  // Outreach
  const boHandlesInput   = $('boHandles');
  const boDefaultTemplate = $('boDefaultTemplate');
  const btnParseHandles  = $('btnParseHandles');
  const boHandleAssignments = $('boHandleAssignments');
  const boHandleCount    = $('boHandleCount');
  const boHandleList     = $('boHandleList');
  const boDelayInput     = $('boDelay');
  const boAutoSend       = $('boAutoSend');
  const btnStartOutreach = $('btnStartOutreach');

  const boProgress       = $('boProgress');
  const boProgressBar    = $('boProgressBar');
  const boStatusText     = $('boStatusText');
  const boStatusBadge    = $('boStatusBadge');
  const boLiveLog        = $('boLiveLog');
  const boActiveActions  = $('boActiveActions');
  const boDoneActions    = $('boDoneActions');
  const btnPauseOutreach = $('btnPauseOutreach');
  const btnBackFromOutreach = $('btnBackFromOutreach');
  const btnNewOutreach   = $('btnNewOutreach');

  // History
  const historyBadge     = $('historyBadge');
  const historyCount     = $('historyCount');
  const historyList      = $('historyList');
  const btnClearHistory  = $('btnClearHistory');
  const cadenceQueue     = $('cadenceQueue');
  const cadenceQueueCount = $('cadenceQueueCount');
  const cadenceQueueList = $('cadenceQueueList');

  // Cadence
  const cadence6h        = $('cadence6h');
  const cadence12h       = $('cadence12h');
  const cadence24h       = $('cadence24h');
  const cadenceTemplateField = $('cadenceTemplateField');
  const cadenceTemplate  = $('cadenceTemplate');

  // Waitlist
  const waitlistBadge    = $('waitlistBadge');
  const waitlistCount    = $('waitlistCount');
  const waitlistList     = $('waitlistList');
  const btnRecheckWaitlist = $('btnRecheckWaitlist');
  const btnClearWaitlist = $('btnClearWaitlist');
  const waitlistProgress = $('waitlistProgress');
  const waitlistProgressBar = $('waitlistProgressBar');
  const waitlistStatusText = $('waitlistStatusText');
  const waitlistLiveLog  = $('waitlistLiveLog');

  // ─── DOM refs: Platform Selector ───
  const platformBtns = document.querySelectorAll('.platform-btn');
  const postUrlLabel = $('postUrlLabel');
  const boHandlesLabel = $('boHandlesLabel');

  // ─── DOM refs: Behavior Settings ───
  const settingAlwaysFollow = $('settingAlwaysFollow');
  const settingDMAfterFollow = $('settingDMAfterFollow');
  const settingWaitlistPrivate = $('settingWaitlistPrivate');

  // ─── State ───
  let currentStep = 1;
  let matchedUsers = [];
  let pollTimer = null;
  let templates = [];
  let parsedHandles = [];
  let boPollTimer = null;
  let editingTemplateIdx = -1;
  let currentHistoryFilter = 'all';
  let currentPlatform = 'instagram';

  const TEMPLATE_COLORS = ['#833ab4', '#fd1d1d', '#fcb045', '#0095f6', '#2ecc71', '#e74c3c', '#9b59b6', '#1abc9c'];

  // ─── Init ───
  await loadTemplates();
  await loadLastConfig();
  await restoreState();
  await refreshPendingFollows();
  await refreshWaitlist();
  await refreshHistory();
  await refreshCadenceQueue();
  setupCadenceToggles();
  setupPlatformSelector();
  setupCSVHandlers();
  renderDashboard();

  // ─── Listen for real-time progress from background ───
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'progressUpdate') handleProgressUpdate(msg);
    if (msg.action === 'dmProgressUpdate') handleDMProgressUpdate(msg);
    if (msg.action === 'boProgressUpdate') { handleBOProgressUpdate(msg); renderDashboard(); }
    if (msg.action === 'waitlistCheckUpdate') handleWaitlistCheckUpdate(msg);
    if (msg.action === 'cadenceUpdate') refreshCadenceQueue();
    if (msg.action === 'historyUpdate') { refreshHistory(); renderDashboard(); }
  });


  // ═══════════════════════════════════════════
  //  PLATFORM SELECTOR
  // ═══════════════════════════════════════════

  function setupPlatformSelector() {
    platformBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        currentPlatform = btn.dataset.platform;
        platformBtns.forEach(b => b.classList.toggle('active', b === btn));
        document.body.className = `platform-${currentPlatform}`;
        updatePlatformLabels();
      });
    });
    updatePlatformLabels();
  }

  function updatePlatformLabels() {
    const isThreads = currentPlatform === 'threads';
    if (postUrlLabel) postUrlLabel.textContent = isThreads ? 'Threads Post URL' : 'Instagram Post URL';
    if (postUrlInput) postUrlInput.placeholder = isThreads ? 'https://www.threads.net/@user/post/...' : 'https://www.instagram.com/p/...';
    if (boHandlesLabel) boHandlesLabel.textContent = isThreads ? 'Threads Handles' : 'Instagram Handles';
    if (boHandlesInput) boHandlesInput.placeholder = isThreads ? '@handle1\n@handle2\n@handle3' : '@handle1\n@handle2\n@handle3';
  }


  // ═══════════════════════════════════════════
  //  MODE TAB SWITCHING
  // ═══════════════════════════════════════════

  modeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.mode;
      modeTabs.forEach(t => t.classList.toggle('active', t === tab));
      Object.entries(modePanels).forEach(([k, v]) => { if (v) v.classList.toggle('active', k === mode); });
    });
  });

  // Sub-tab switching (Bulk Outreach)
  subTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const id = tab.dataset.subtab;
      subTabs.forEach(t => t.classList.toggle('active', t === tab));
      Object.entries(subPanels).forEach(([k, v]) => { if (v) v.classList.toggle('active', k === id); });
      if (id === 'bo-dashboard') renderDashboard();
      if (id === 'bo-waitlist') refreshWaitlist();
      if (id === 'bo-history') { refreshHistory(); refreshCadenceQueue(); }
    });
  });


  // ═══════════════════════════════════════════
  //  KEYWORD SCAN: STEP NAVIGATION
  // ═══════════════════════════════════════════

  function goToStep(n) {
    currentStep = n;
    Object.values(steps).forEach(el => { if (el) el.classList.remove('active'); });
    if (steps[n]) steps[n].classList.add('active');
    stepDots.forEach(dot => {
      const s = parseInt(dot.dataset.step);
      dot.classList.toggle('active', s === n);
      dot.classList.toggle('completed', s < n);
    });
  }


  // ═══════════════════════════════════════════
  //  KEYWORD SCAN: STEP 1 CONFIGURE
  // ═══════════════════════════════════════════

  btnStartScan.addEventListener('click', async () => {
    const postUrl = postUrlInput.value.trim();
    const keywords = keywordsInput.value.split(',').map(k => k.trim()).filter(Boolean);
    const dmTemplate = dmTemplateInput.value.trim();
    const delaySec = parseInt(delayInput.value) || 60;

    const validUrl = currentPlatform === 'threads'
      ? (postUrl.includes('threads.net/') || postUrl.includes('threads.com/'))
      : postUrl.includes('instagram.com/');
    if (!postUrl || !validUrl) return flash(postUrlInput);
    if (!keywords.length) return flash(keywordsInput);
    if (!dmTemplate) return flash(dmTemplateInput);

    btnStartScan.disabled = true;
    btnStartScan.textContent = 'Starting...';
    scanLiveLog.innerHTML = '';
    scanProgressBar.style.width = '10%';
    addScanLog('Initializing scan...', 'info');
    goToStep(2);

    const isAutoSend = autoSendToggle.checked;

    try {
      const result = await bg({ action: 'startScan', postUrl, keywords, dmTemplate, delaySeconds: delaySec, autoSend: isAutoSend, platform: currentPlatform });
      if (result.matchedUsers) {
        matchedUsers = result.matchedUsers;
        scanProgressBar.style.width = '100%';
        addScanLog(`Scan complete! Found ${matchedUsers.length} matching commenters.`, 'success');
        await sleep(600);
        if (isAutoSend && matchedUsers.length > 0) {
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

  function handleProgressUpdate(msg) {
    if (msg.step === 'scan') {
      addScanLog(msg.detail, msg.type || 'info');
      if (msg.type !== 'success' && msg.type !== 'error') scanProgressBar.style.width = '50%';
    }
    if (msg.step === 'dmDone') pollDMState();
    if (msg.step === 'boDone') pollBOState();
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
  //  KEYWORD SCAN: STEP 3 REVIEW
  // ═══════════════════════════════════════════

  function renderMatchedUsers() {
    matchSummary.textContent = `${matchedUsers.length} user(s) commented with your keyword(s).`;
    if (!matchedUsers.length) {
      matchedList.innerHTML = '<div class="empty-state">No matching comments found.</div>';
      btnStartDMs.disabled = true;
      return;
    }
    bg({ action: 'getHistory' }).then(({ history }) => {
      const sentSet = new Set((history || []).filter(h => h.status === 'messaged').map(h => h.username));
      matchedList.innerHTML = matchedUsers.map((u, i) => `
        <div class="match-item">
          <input type="checkbox" class="match-cb" data-i="${i}" ${sentSet.has(u.username) ? '' : 'checked'} />
          <div class="match-avatar">${u.username[0].toUpperCase()}</div>
          <div class="match-info">
            <div class="match-username">@${u.username} ${sentSet.has(u.username) ? '<span class="already-sent">Already sent</span>' : ''}</div>
            <div class="match-comment">"${escHtml(u.comment)}" <span class="match-keyword">${escHtml(u.matchedKeyword)}</span></div>
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

  btnSelectAll.addEventListener('click', () => { matchedList.querySelectorAll('.match-cb').forEach(cb => cb.checked = true); updateCount(); });
  btnDeselectAll.addEventListener('click', () => { matchedList.querySelectorAll('.match-cb').forEach(cb => cb.checked = false); updateCount(); });
  btnBackToConfig.addEventListener('click', async () => { await bg({ action: 'reset' }); goToStep(1); });


  // ═══════════════════════════════════════════
  //  KEYWORD SCAN: STEP 3 → 4 START DMs
  // ═══════════════════════════════════════════

  async function startDMsForUsers(users) {
    dmLiveLog.innerHTML = '';
    dmProgressBar.style.width = '0%';
    dmStatusText.textContent = `Sending DMs: 0 / ${users.length}`;
    dmDoneActions.style.display = 'none';
    dmActiveActions.style.display = 'flex';
    btnPauseDMs.textContent = 'Pause';
    btnBackToConfigDM.style.display = 'none';
    users.forEach(u => addDMUserEntry(u.username, 'pending'));
    goToStep(4);
    await bg({ action: 'startSendingDMs', selectedUsers: users });
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
  //  KEYWORD SCAN: STEP 4 DM PROGRESS
  // ═══════════════════════════════════════════

  const substepLabels = {
    navigating: 'Opening profile...', clickingMessage: 'Clicking "Message" button...',
    following: 'Following user (no Message button)...', followed: 'Followed — saved to retry queue',
    waitingDM: 'Waiting for DM to open...', typing: 'Typing message...',
    sending: 'Sending message...', done: 'DM sent!', error: 'Error', waiting: 'Waiting before next DM...'
  };
  const substepOrder = ['navigating', 'clickingMessage', 'waitingDM', 'typing', 'done'];

  function handleDMProgressUpdate(msg) {
    const { username, substep, detail, currentIndex, total, sentLog } = msg;
    const pct = total > 0 ? Math.round(((sentLog?.length || 0) / total) * 100) : 0;
    dmProgressBar.style.width = `${pct}%`;
    dmStatusText.textContent = `Sending DMs: ${sentLog?.length || 0} / ${total}`;
    if (username) updateDMUserEntry(username, substep, detail);
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
      refreshHistory();
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
    const container = document.getElementById(`dm-substeps-${username}`);
    if (!container) return;

    if (substep === 'done') { icon.className = 'log-icon success'; icon.textContent = '\u2705'; }
    else if (substep === 'error') { icon.className = 'log-icon error'; icon.textContent = '\u274C'; }
    else if (substep === 'followed') { icon.className = 'log-icon followed'; icon.textContent = ''; }
    else { icon.className = 'log-icon active'; icon.textContent = ''; }

    const allSubsteps = container.querySelectorAll('.log-substep');

    if (substep === 'following' || substep === 'followed') {
      for (const el of allSubsteps) {
        const s = el.dataset.substep;
        if (s === 'navigating') { el.className = 'log-substep done'; el.querySelector('.substep-icon').textContent = '\u2713'; }
        else if (s === 'clickingMessage') { el.className = 'log-substep done'; el.querySelector('.substep-icon').textContent = '\u2713'; el.querySelector('span:last-child').textContent = 'No Message button found'; }
        else if (s === 'waitingDM' || s === 'typing') { el.style.display = 'none'; }
        else if (s === 'done') {
          if (substep === 'followed') { el.className = 'log-substep followed'; el.querySelector('.substep-icon').textContent = '\uD83D\uDC64'; el.querySelector('span:last-child').textContent = detail || 'Followed — saved to retry queue'; }
          else { el.className = 'log-substep active'; el.querySelector('.substep-icon').textContent = '\u25CF'; el.querySelector('span:last-child').textContent = detail || 'Following user...'; }
        }
      }
    } else if (substep === 'error') {
      for (const el of allSubsteps) {
        const s = el.dataset.substep;
        if (s === 'done') { el.className = 'log-substep error'; el.querySelector('.substep-icon').textContent = '\u2717'; el.querySelector('span:last-child').textContent = detail || 'Error'; }
        else { el.className = 'log-substep done'; el.querySelector('.substep-icon').textContent = '\u2713'; }
      }
    } else {
      let reachedCurrent = false;
      for (const el of allSubsteps) {
        const s = el.dataset.substep;
        if (s === substep) { el.className = 'log-substep active'; el.querySelector('.substep-icon').textContent = '\u25CF'; if (detail) el.querySelector('span:last-child').textContent = detail; reachedCurrent = true; }
        else if (!reachedCurrent) { el.className = 'log-substep done'; el.querySelector('.substep-icon').textContent = '\u2713'; }
        else { el.className = 'log-substep waiting'; el.querySelector('.substep-icon').textContent = '\u25CB'; }
      }
    }

    if (substep === 'done' || substep === 'error' || substep === 'followed') { if (timeEl) timeEl.textContent = timeNow(); }
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
          btnBackToConfigDM.style.display = 'inline-flex';
        } else {
          btnPauseDMs.textContent = 'Pause';
          btnBackToConfigDM.style.display = 'none';
        }
      } catch (e) {}
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
    if (s.status === 'paused') { await bg({ action: 'resumeDMs' }); btnPauseDMs.textContent = 'Pause'; btnBackToConfigDM.style.display = 'none'; }
    else { await bg({ action: 'pauseDMs' }); btnPauseDMs.textContent = 'Resume'; btnBackToConfigDM.style.display = 'inline-flex'; }
  });

  btnBackToConfigDM.addEventListener('click', async () => {
    clearInterval(pollTimer);
    await bg({ action: 'reset' });
    await refreshPendingFollows();
    btnBackToConfigDM.style.display = 'none';
    goToStep(1);
  });

  btnNewCampaign.addEventListener('click', async () => {
    clearInterval(pollTimer);
    await bg({ action: 'reset' });
    await refreshPendingFollows();
    goToStep(1);
  });


  // ═══════════════════════════════════════════
  //  KEYWORD SCAN: PENDING FOLLOWS
  // ═══════════════════════════════════════════

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
          return `<div class="pending-user">
            <div class="pending-avatar">${(u.username || '?')[0].toUpperCase()}</div>
            <div class="pending-info">
              <div class="pending-username">@${u.username}</div>
              <div class="pending-status"><span class="pending-status-badge ${statusClass}">${statusLabel}</span>${timeAgo ? ` <span style="margin-left:4px;font-size:10px;color:var(--text-muted)">${timeAgo}</span>` : ''}</div>
            </div>
          </div>`;
        }).join('');
      } else {
        pendingSection.style.display = 'none';
      }
    } catch (e) { pendingSection.style.display = 'none'; }
  }

  if (pendingToggle) {
    pendingToggle.addEventListener('click', () => {
      const isOpen = pendingBody.style.display !== 'none';
      pendingBody.style.display = isOpen ? 'none' : 'block';
      pendingToggle.classList.toggle('open', !isOpen);
    });
  }

  btnRetryPending.addEventListener('click', async () => {
    const dmTemplate = dmTemplateInput.value.trim();
    if (!dmTemplate) { flash(dmTemplateInput); goToStep(1); return; }
    const { pendingFollows } = await bg({ action: 'getPendingFollows' });
    if (!pendingFollows || !pendingFollows.length) return;
    await bg({ action: 'clearPendingFollows' });
    await startDMsForUsers(pendingFollows.map(p => ({ username: p.username, comment: p.comment || '', matchedKeyword: p.matchedKeyword || '' })));
  });

  btnClearPending.addEventListener('click', async () => { await bg({ action: 'clearPendingFollows' }); await refreshPendingFollows(); });


  // ═══════════════════════════════════════════════════════════════
  //  BULK OUTREACH: REPLY DIRECTIONS (TEMPLATES)
  // ═══════════════════════════════════════════════════════════════

  async function loadTemplates() {
    const data = await chrome.storage.local.get('boTemplates');
    templates = data.boTemplates || [];
    renderTemplates();
    populateTemplateDropdowns();
  }

  async function saveTemplates() {
    await chrome.storage.local.set({ boTemplates: templates });
    renderTemplates();
    populateTemplateDropdowns();
  }

  function renderTemplates() {
    if (!templates.length) {
      templatesList.innerHTML = '<div class="empty-state">No templates yet. Add one below.</div>';
      return;
    }
    templatesList.innerHTML = templates.map((t, i) => `
      <div class="template-item${editingTemplateIdx === i ? ' editing' : ''}" data-idx="${i}">
        <div class="template-color" style="background:${t.color}"></div>
        <div class="template-body">
          ${editingTemplateIdx === i ? `
            <input class="template-edit-name" type="text" value="${escHtml(t.name)}" />
            <textarea class="template-edit-body" rows="3">${escHtml(t.body)}</textarea>
            <div class="template-edit-actions">
              <button class="btn btn-sm btn-primary template-save-btn" data-idx="${i}">Save</button>
              <button class="btn btn-sm btn-secondary template-cancel-btn" data-idx="${i}">Cancel</button>
            </div>
          ` : `
            <div class="template-name">${escHtml(t.name)}</div>
            <div class="template-preview">${escHtml(t.body.substring(0, 80))}${t.body.length > 80 ? '...' : ''}</div>
          `}
        </div>
        ${editingTemplateIdx !== i ? `
        <div class="template-actions">
          <button class="template-btn edit" data-idx="${i}" title="Edit">&#x270E;</button>
          <button class="template-btn delete" data-idx="${i}" title="Delete">&#x2715;</button>
        </div>` : ''}
      </div>
    `).join('');

    templatesList.querySelectorAll('.template-btn.edit').forEach(btn => {
      btn.addEventListener('click', () => { editingTemplateIdx = parseInt(btn.dataset.idx); renderTemplates(); });
    });

    templatesList.querySelectorAll('.template-btn.delete').forEach(btn => {
      btn.addEventListener('click', async () => { templates.splice(parseInt(btn.dataset.idx), 1); editingTemplateIdx = -1; await saveTemplates(); });
    });

    templatesList.querySelectorAll('.template-save-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.idx);
        const item = btn.closest('.template-item');
        const newName = item.querySelector('.template-edit-name').value.trim();
        const newBody = item.querySelector('.template-edit-body').value.trim();
        if (!newName || !newBody) return;
        templates[idx].name = newName;
        templates[idx].body = newBody;
        editingTemplateIdx = -1;
        await saveTemplates();
      });
    });

    templatesList.querySelectorAll('.template-cancel-btn').forEach(btn => {
      btn.addEventListener('click', () => { editingTemplateIdx = -1; renderTemplates(); });
    });
  }

  function populateTemplateDropdowns() {
    const val = boDefaultTemplate.value;
    boDefaultTemplate.innerHTML = '<option value="">-- Select --</option>' +
      templates.map(t => `<option value="${t.id}">${escHtml(t.name)}</option>`).join('');
    if (val) boDefaultTemplate.value = val;

    // Cadence follow-up template dropdown
    const cVal = cadenceTemplate ? cadenceTemplate.value : '';
    if (cadenceTemplate) {
      cadenceTemplate.innerHTML = '<option value="">-- Select --</option>' +
        templates.map(t => `<option value="${t.id}">${escHtml(t.name)}</option>`).join('');
      if (cVal) cadenceTemplate.value = cVal;
    }

    document.querySelectorAll('.handle-template-select').forEach(sel => {
      const v = sel.value;
      sel.innerHTML = templates.map(t => `<option value="${t.id}">${escHtml(t.name)}</option>`).join('');
      if (v) sel.value = v;
    });
  }

  btnAddTemplate.addEventListener('click', async () => {
    const name = newTemplateName.value.trim();
    const body = newTemplateBody.value.trim();
    if (!name) return flash(newTemplateName);
    if (!body) return flash(newTemplateBody);
    templates.push({ id: 'tpl_' + Date.now(), name, body, color: TEMPLATE_COLORS[templates.length % TEMPLATE_COLORS.length] });
    await saveTemplates();
    newTemplateName.value = '';
    newTemplateBody.value = '';
  });


  // ═══════════════════════════════════════════════════════════════
  //  BULK OUTREACH: CADENCE TOGGLE
  // ═══════════════════════════════════════════════════════════════

  function setupCadenceToggles() {
    const checks = [cadence6h, cadence12h, cadence24h].filter(Boolean);
    checks.forEach(cb => {
      cb.addEventListener('change', () => {
        const anyChecked = checks.some(c => c.checked);
        if (cadenceTemplateField) cadenceTemplateField.style.display = anyChecked ? 'block' : 'none';
      });
    });
  }

  function getCadenceConfig() {
    const intervals = [];
    if (cadence6h && cadence6h.checked) intervals.push(6);
    if (cadence12h && cadence12h.checked) intervals.push(12);
    if (cadence24h && cadence24h.checked) intervals.push(24);
    const followUpTemplateId = cadenceTemplate ? cadenceTemplate.value : '';
    return { intervals, followUpTemplateId };
  }


  // ═══════════════════════════════════════════════════════════════
  //  BULK OUTREACH: HANDLE LIST & RUN
  // ═══════════════════════════════════════════════════════════════

  function renderHandleList() {
    boHandleCount.textContent = `${parsedHandles.length} handles`;
    boHandleList.innerHTML = parsedHandles.map((h, i) => `
      <div class="handle-row" data-idx="${i}">
        <div class="handle-avatar">${h.username[0].toUpperCase()}</div>
        <div class="handle-name">@${h.username}</div>
        <select class="handle-template-select" data-idx="${i}">
          ${templates.map(t => `<option value="${t.id}" ${t.id === h.templateId ? 'selected' : ''}>${escHtml(t.name)}</option>`).join('')}
        </select>
        <button class="handle-remove" data-idx="${i}">&times;</button>
      </div>
    `).join('');

    boHandleList.querySelectorAll('.handle-template-select').forEach(sel => {
      sel.addEventListener('change', () => { parsedHandles[parseInt(sel.dataset.idx)].templateId = sel.value; });
    });

    boHandleList.querySelectorAll('.handle-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        parsedHandles.splice(parseInt(btn.dataset.idx), 1);
        if (parsedHandles.length === 0) { boHandleAssignments.style.display = 'none'; btnStartOutreach.style.display = 'none'; return; }
        renderHandleList();
      });
    });
  }

  btnParseHandles.addEventListener('click', () => {
    const raw = boHandlesInput.value.trim();
    if (!raw) return flash(boHandlesInput);
    if (!templates.length) {
      flash(newTemplateName);
      subTabs.forEach(t => t.classList.toggle('active', t.dataset.subtab === 'bo-templates'));
      Object.entries(subPanels).forEach(([k, v]) => { if (v) v.classList.toggle('active', k === 'bo-templates'); });
      return;
    }

    const defaultTplId = boDefaultTemplate.value || templates[0]?.id || '';
    const handles = raw.split('\n').map(h => h.trim().replace(/^@/, '')).filter(Boolean);
    const unique = [...new Set(handles)];

    parsedHandles = unique.map(username => ({ username, templateId: defaultTplId }));
    renderHandleList();

    boHandleAssignments.style.display = 'block';
    btnStartOutreach.style.display = 'flex';

    // If full auto, start immediately
    if (boAutoSend && boAutoSend.checked) {
      btnStartOutreach.click();
    }
  });

  btnStartOutreach.addEventListener('click', async () => {
    if (!parsedHandles.length) return;

    const outreachList = parsedHandles.map(h => {
      const tpl = templates.find(t => t.id === h.templateId);
      return {
        username: h.username,
        templateId: h.templateId,
        templateName: tpl?.name || 'Unknown',
        dmTemplate: tpl?.body || ''
      };
    });

    const delaySec = parseInt(boDelayInput.value) || 60;
    const cadenceConfig = getCadenceConfig();

    // Show progress
    boProgress.style.display = 'block';
    boLiveLog.innerHTML = '';
    boProgressBar.style.width = '0%';
    boStatusText.textContent = `Processing: 0 / ${outreachList.length}`;
    boStatusBadge.textContent = 'Running';
    boStatusBadge.className = 'status-badge running';
    boDoneActions.style.display = 'none';
    boActiveActions.style.display = 'flex';
    btnPauseOutreach.textContent = 'Pause';
    btnBackFromOutreach.style.display = 'none';

    // Pre-populate log with status lights
    outreachList.forEach(u => addBOUserEntry(u.username, u.templateName));

    // Scroll to progress card
    boProgress.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const behaviorSettings = {
      alwaysFollow: settingAlwaysFollow?.checked ?? true,
      dmAfterFollow: settingDMAfterFollow?.checked ?? true,
      waitlistPrivate: settingWaitlistPrivate?.checked ?? true
    };

    await bg({ action: 'startBulkOutreach', outreachList, delaySeconds: delaySec, cadenceConfig, platform: currentPlatform, behaviorSettings });
    startBOPolling(outreachList);
  });

  function addBOUserEntry(username, templateName) {
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.id = `bo-user-${username}`;
    entry.innerHTML = `
      <div class="log-icon pending"></div>
      <div class="log-body">
        <div class="log-username" style="display:flex;align-items:center;gap:8px;">
          @${username}
          <div class="status-lights" id="lights-${username}">
            <div class="status-light" data-light="viewed" title="Viewed"></div>
            <div class="status-light" data-light="followed" title="Followed"></div>
            <div class="status-light" data-light="messaged" title="Messaged"></div>
          </div>
          <span class="waitlist-template-name">${escHtml(templateName)}</span>
        </div>
        <div class="log-substeps" id="bo-substeps-${username}">
          <div class="log-substep waiting" data-substep="checking"><span class="substep-icon">\u25CB</span><span>Checking profile...</span></div>
          <div class="log-substep waiting" data-substep="action"><span class="substep-icon">\u25CB</span><span>Determining action...</span></div>
          <div class="log-substep waiting" data-substep="result"><span class="substep-icon">\u25CB</span><span>Waiting...</span></div>
        </div>
      </div>
      <div class="log-time" id="bo-time-${username}"></div>
    `;
    boLiveLog.appendChild(entry);
  }

  function updateStatusLight(username, light) {
    const container = document.getElementById(`lights-${username}`);
    if (!container) return;
    const dot = container.querySelector(`[data-light="${light}"]`);
    if (dot) dot.classList.add(light);
  }

  function handleBOProgressUpdate(msg) {
    const { username, substep, detail, currentIndex, total, sentLog } = msg;
    const pct = total > 0 ? Math.round(((sentLog?.length || 0) / total) * 100) : 0;
    boProgressBar.style.width = `${pct}%`;
    boStatusText.textContent = `Processing: ${sentLog?.length || 0} / ${total}`;

    if (username) {
      updateBOUserEntry(username, substep, detail);

      // Update status lights based on substep
      if (substep === 'checking') updateStatusLight(username, 'viewed');
      if (substep === 'following' || substep === 'waitlisted') updateStatusLight(username, 'followed');
      if (substep === 'done') { updateStatusLight(username, 'viewed'); updateStatusLight(username, 'messaged'); }
      if (substep === 'dm-direct') { updateStatusLight(username, 'viewed'); }
      if (substep === 'typing') { updateStatusLight(username, 'viewed'); }
    }

    if (sentLog && sentLog.length >= total) {
      const dmSent = sentLog.filter(l => l.status === 'success').length;
      const waitlisted = sentLog.filter(l => l.status === 'waitlisted').length;
      boProgressBar.style.width = '100%';
      let msg2 = `Complete! ${dmSent} DMs sent.`;
      if (waitlisted > 0) msg2 += ` ${waitlisted} added to waitlist.`;
      boStatusText.textContent = msg2;
      boStatusBadge.textContent = 'Done';
      boStatusBadge.className = 'status-badge done';
      boDoneActions.style.display = 'flex';
      boActiveActions.style.display = 'none';
      clearInterval(boPollTimer);
      refreshWaitlist();
      refreshHistory();
      refreshCadenceQueue();
    }
  }

  function updateBOUserEntry(username, substep, detail) {
    const entry = document.getElementById(`bo-user-${username}`);
    if (!entry) return;
    const icon = entry.querySelector('.log-icon');
    const timeEl = document.getElementById(`bo-time-${username}`);
    const container = document.getElementById(`bo-substeps-${username}`);
    if (!container) return;

    const allSubs = container.querySelectorAll('.log-substep');

    if (substep === 'checking') {
      icon.className = 'log-icon active'; icon.textContent = '';
      allSubs[0].className = 'log-substep active';
      allSubs[0].querySelector('.substep-icon').textContent = '\u25CF';
      allSubs[0].querySelector('span:last-child').textContent = detail || 'Checking profile...';
    } else if (substep === 'dm-direct') {
      allSubs[0].className = 'log-substep done'; allSubs[0].querySelector('.substep-icon').textContent = '\u2713';
      allSubs[1].className = 'log-substep active'; allSubs[1].querySelector('.substep-icon').textContent = '\u25CF';
      allSubs[1].querySelector('span:last-child').textContent = detail || 'Message button found — sending DM...';
    } else if (substep === 'following') {
      allSubs[0].className = 'log-substep done'; allSubs[0].querySelector('.substep-icon').textContent = '\u2713';
      allSubs[1].className = 'log-substep active'; allSubs[1].querySelector('.substep-icon').textContent = '\u25CF';
      allSubs[1].querySelector('span:last-child').textContent = detail || 'No Message button — following...';
    } else if (substep === 'typing') {
      allSubs[1].className = 'log-substep done'; allSubs[1].querySelector('.substep-icon').textContent = '\u2713';
      allSubs[2].className = 'log-substep active'; allSubs[2].querySelector('.substep-icon').textContent = '\u25CF';
      allSubs[2].querySelector('span:last-child').textContent = detail || 'Typing message...';
    } else if (substep === 'done') {
      icon.className = 'log-icon success'; icon.textContent = '\u2705';
      allSubs.forEach(el => { el.className = 'log-substep done'; el.querySelector('.substep-icon').textContent = '\u2713'; });
      allSubs[2].querySelector('span:last-child').textContent = detail || 'DM sent!';
      if (timeEl) timeEl.textContent = timeNow();
    } else if (substep === 'waitlisted') {
      icon.className = 'log-icon followed'; icon.textContent = '';
      allSubs[0].className = 'log-substep done'; allSubs[0].querySelector('.substep-icon').textContent = '\u2713';
      allSubs[1].className = 'log-substep done'; allSubs[1].querySelector('.substep-icon').textContent = '\u2713';
      allSubs[1].querySelector('span:last-child').textContent = 'Followed — added to waitlist';
      allSubs[2].className = 'log-substep followed'; allSubs[2].querySelector('.substep-icon').textContent = '\uD83D\uDC64';
      allSubs[2].querySelector('span:last-child').textContent = detail || 'Waiting for follow-back';
      if (timeEl) timeEl.textContent = timeNow();
    } else if (substep === 'error') {
      icon.className = 'log-icon error'; icon.textContent = '\u274C';
      allSubs[0].className = 'log-substep done'; allSubs[0].querySelector('.substep-icon').textContent = '\u2713';
      allSubs[1].className = 'log-substep done'; allSubs[1].querySelector('.substep-icon').textContent = '\u2713';
      allSubs[2].className = 'log-substep error'; allSubs[2].querySelector('.substep-icon').textContent = '\u2717';
      allSubs[2].querySelector('span:last-child').textContent = detail || 'Error';
      if (timeEl) timeEl.textContent = timeNow();
    }

    boLiveLog.scrollTop = boLiveLog.scrollHeight;
  }

  function startBOPolling(outreachList) {
    boPollTimer = setInterval(async () => {
      try {
        const s = await bg({ action: 'getBOState' });
        if (s.status === 'done') {
          clearInterval(boPollTimer);
          boStatusBadge.textContent = 'Done';
          boStatusBadge.className = 'status-badge done';
          boDoneActions.style.display = 'flex';
          boActiveActions.style.display = 'none';
        } else if (s.status === 'paused') {
          boStatusText.textContent = `Paused — ${s.sentLog?.length || 0} / ${outreachList.length} processed`;
          boStatusBadge.textContent = 'Paused';
          boStatusBadge.className = 'status-badge paused';
          btnPauseOutreach.textContent = 'Resume';
          btnBackFromOutreach.style.display = 'inline-flex';
        } else {
          boStatusBadge.textContent = 'Running';
          boStatusBadge.className = 'status-badge running';
          btnPauseOutreach.textContent = 'Pause';
          btnBackFromOutreach.style.display = 'none';
        }
      } catch (e) {}
    }, 2000);
  }

  async function pollBOState() {
    const s = await bg({ action: 'getBOState' });
    if (s.status === 'done') {
      clearInterval(boPollTimer);
      boStatusBadge.textContent = 'Done';
      boStatusBadge.className = 'status-badge done';
      boDoneActions.style.display = 'flex';
      boActiveActions.style.display = 'none';
    }
  }

  btnPauseOutreach.addEventListener('click', async () => {
    const s = await bg({ action: 'getBOState' });
    if (s.status === 'paused') { await bg({ action: 'resumeBO' }); btnPauseOutreach.textContent = 'Pause'; btnBackFromOutreach.style.display = 'none'; }
    else { await bg({ action: 'pauseBO' }); btnPauseOutreach.textContent = 'Resume'; btnBackFromOutreach.style.display = 'inline-flex'; }
  });

  btnBackFromOutreach.addEventListener('click', async () => {
    clearInterval(boPollTimer);
    await bg({ action: 'resetBO' });
    boProgress.style.display = 'none';
    btnStartOutreach.style.display = 'flex';
  });

  btnNewOutreach.addEventListener('click', async () => {
    clearInterval(boPollTimer);
    await bg({ action: 'resetBO' });
    boProgress.style.display = 'none';
    boHandleAssignments.style.display = 'none';
    btnStartOutreach.style.display = 'none';
    boHandlesInput.value = '';
    parsedHandles = [];
    await refreshWaitlist();
    await refreshHistory();
  });


  // ═══════════════════════════════════════════════════════════════
  //  BULK OUTREACH: HISTORY
  // ═══════════════════════════════════════════════════════════════

  async function refreshHistory() {
    try {
      const { history } = await bg({ action: 'getHistory' });
      const items = history || [];

      // Update badge
      if (historyBadge) { historyBadge.textContent = items.length; historyBadge.style.display = items.length > 0 ? 'inline-flex' : 'none'; }
      if (historyCount) historyCount.textContent = items.length;

      renderHistoryList(items);
    } catch (e) {
      if (historyList) historyList.innerHTML = '<div class="empty-state">No history yet.</div>';
    }
  }

  function renderHistoryList(items) {
    if (!historyList) return;

    // Apply filter
    let filtered = items;
    if (currentHistoryFilter !== 'all') {
      filtered = items.filter(h => h.status === currentHistoryFilter);
    }

    if (!filtered.length) {
      historyList.innerHTML = `<div class="empty-state">No ${currentHistoryFilter === 'all' ? '' : currentHistoryFilter + ' '}entries yet.</div>`;
      return;
    }

    // Sort newest first
    filtered.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    historyList.innerHTML = `
      <div class="status-lights-legend">
        <div class="legend-item"><div class="legend-dot viewed"></div>Viewed</div>
        <div class="legend-item"><div class="legend-dot followed"></div>Followed</div>
        <div class="legend-item"><div class="legend-dot messaged"></div>Messaged</div>
      </div>
    ` + filtered.map(h => {
      const date = h.timestamp ? new Date(h.timestamp) : null;
      const dateStr = date ? date.toLocaleDateString() : '';
      const timeStr = date ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      const tplName = h.templateName || '';

      return `<div class="history-item">
        <div class="history-avatar">${(h.username || '?')[0].toUpperCase()}</div>
        <div class="history-info">
          <div class="history-username" style="display:flex;align-items:center;gap:8px;">
            @${escHtml(h.username)}
            <div class="status-lights">
              <div class="status-light ${h.viewed ? 'viewed' : ''}" title="Viewed"></div>
              <div class="status-light ${h.followed ? 'followed' : ''}" title="Followed"></div>
              <div class="status-light ${h.status === 'messaged' ? 'messaged' : ''}" title="Messaged"></div>
            </div>
          </div>
          <div class="history-meta">
            ${tplName ? `<span class="history-template-tag">${escHtml(tplName)}</span>` : ''}
            ${h.cadenceStep ? `<span class="history-cadence-tag">${h.cadenceStep}h follow-up</span>` : ''}
          </div>
        </div>
        <div class="history-time">${dateStr}<br/>${timeStr}</div>
      </div>`;
    }).join('');
  }

  // History filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      currentHistoryFilter = btn.dataset.filter;
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b === btn));
      await refreshHistory();
    });
  });

  if (btnClearHistory) {
    btnClearHistory.addEventListener('click', async () => {
      await bg({ action: 'clearHistory' });
      await refreshHistory();
    });
  }


  // ═══════════════════════════════════════════════════════════════
  //  BULK OUTREACH: CADENCE QUEUE
  // ═══════════════════════════════════════════════════════════════

  async function refreshCadenceQueue() {
    try {
      const { cadenceQueue: queue } = await bg({ action: 'getCadenceQueue' });
      const items = queue || [];

      if (cadenceQueue) cadenceQueue.style.display = items.length > 0 ? 'block' : 'none';
      if (cadenceQueueCount) cadenceQueueCount.textContent = items.length;

      if (cadenceQueueList && items.length > 0) {
        cadenceQueueList.innerHTML = items.map(item => {
          const sendAt = new Date(item.sendAt);
          const now = Date.now();
          const diffMs = sendAt.getTime() - now;
          const diffH = Math.max(0, Math.floor(diffMs / 3600000));
          const diffM = Math.max(0, Math.floor((diffMs % 3600000) / 60000));
          const countdown = diffMs > 0 ? `${diffH}h ${diffM}m` : 'Due now';

          return `<div class="cadence-queue-item">
            <div class="handle-avatar">${(item.username || '?')[0].toUpperCase()}</div>
            <div>
              <div class="cadence-queue-username">@${escHtml(item.username)}</div>
              <div class="cadence-queue-countdown">${item.cadenceHours}h follow-up</div>
            </div>
            <div class="cadence-queue-time">${countdown}</div>
          </div>`;
        }).join('');
      } else if (cadenceQueueList) {
        cadenceQueueList.innerHTML = '';
      }
    } catch (e) {}
  }

  // Refresh cadence queue every 60 seconds
  setInterval(refreshCadenceQueue, 60000);


  // ═══════════════════════════════════════════════════════════════
  //  BULK OUTREACH: WAITLIST
  // ═══════════════════════════════════════════════════════════════

  async function refreshWaitlist() {
    try {
      const { waitlist } = await bg({ action: 'getWaitlist' });
      const count = (waitlist || []).length;

      if (waitlistBadge) { waitlistBadge.textContent = count; waitlistBadge.style.display = count > 0 ? 'inline-flex' : 'none'; }
      if (waitlistCount) waitlistCount.textContent = count;

      if (count > 0) {
        waitlistList.innerHTML = waitlist.map(u => {
          const tpl = templates.find(t => t.id === u.templateId);
          return `<div class="waitlist-item">
            <div class="pending-avatar">${(u.username || '?')[0].toUpperCase()}</div>
            <div class="waitlist-info">
              <div class="waitlist-username">@${u.username}</div>
              <div class="waitlist-meta">
                <span class="waitlist-template-name">${escHtml(tpl?.name || u.templateName || 'Unknown')}</span>
                ${u.timestamp ? `<span style="margin-left:4px">${new Date(u.timestamp).toLocaleDateString()}</span>` : ''}
              </div>
            </div>
          </div>`;
        }).join('');
      } else {
        waitlistList.innerHTML = '<div class="empty-state">No users on the waitlist.</div>';
      }
    } catch (e) {
      waitlistList.innerHTML = '<div class="empty-state">No users on the waitlist.</div>';
    }
  }

  btnRecheckWaitlist.addEventListener('click', async () => {
    const { waitlist } = await bg({ action: 'getWaitlist' });
    if (!waitlist || !waitlist.length) return;
    waitlistProgress.style.display = 'block';
    waitlistLiveLog.innerHTML = '';
    waitlistProgressBar.style.width = '0%';
    waitlistStatusText.textContent = `Re-checking: 0 / ${waitlist.length}`;
    await bg({ action: 'recheckWaitlist', platform: currentPlatform });
  });

  function handleWaitlistCheckUpdate(msg) {
    const { username, substep, detail, currentIndex, total, results } = msg;
    const pct = total > 0 ? Math.round(((results?.length || 0) / total) * 100) : 0;
    waitlistProgressBar.style.width = `${pct}%`;
    waitlistStatusText.textContent = `Re-checking: ${results?.length || 0} / ${total}`;

    if (username) {
      const iconMap = { checking: '\u2139\uFE0F', 'dm-sent': '\u2705', 'still-waiting': '\uD83D\uDC64', error: '\u274C' };
      const typeMap = { checking: 'info', 'dm-sent': 'success', 'still-waiting': 'info', error: 'error' };
      addLogEntry(waitlistLiveLog, `@${username}: ${detail}`, typeMap[substep] || 'info', iconMap[substep]);
    }

    if (results && results.length >= total) {
      const sent = results.filter(r => r.status === 'dm-sent').length;
      waitlistStatusText.textContent = `Done! ${sent} DMs sent. ${total - sent} still waiting.`;
      waitlistProgressBar.style.width = '100%';
      refreshWaitlist();
      refreshHistory();
    }
  }

  btnClearWaitlist.addEventListener('click', async () => {
    await bg({ action: 'clearWaitlist' });
    await refreshWaitlist();
    waitlistProgress.style.display = 'none';
  });


  // ═══════════════════════════════════════════
  //  RESTORE STATE
  // ═══════════════════════════════════════════

  async function restoreState() {
    try {
      const s = await bg({ action: 'getState' });
      if (s.status === 'reviewing') { matchedUsers = s.matchedUsers || []; renderMatchedUsers(); goToStep(3); }
      else if (s.status === 'sending' || s.status === 'paused') {
        goToStep(4); dmLiveLog.innerHTML = '';
        (s.selectedUsers || []).forEach(u => addDMUserEntry(u.username, 'pending'));
        (s.sentLog || []).forEach(log => { const st = log.status === 'success' ? 'done' : (log.status === 'followed' ? 'followed' : 'error'); updateDMUserEntry(log.username, st, log.message); });
        startDMPolling(s.selectedUsers || []);
      } else if (s.status === 'done') {
        matchedUsers = s.matchedUsers || []; goToStep(4);
        const total = s.selectedUsers?.length || 0;
        const successCount = (s.sentLog || []).filter(l => l.status === 'success').length;
        dmStatusText.textContent = `Complete! ${successCount} / ${total} DMs sent.`;
        dmProgressBar.style.width = '100%';
        dmDoneActions.style.display = 'flex'; dmActiveActions.style.display = 'none';
        dmLiveLog.innerHTML = '';
        (s.selectedUsers || []).forEach(u => addDMUserEntry(u.username, 'pending'));
        (s.sentLog || []).forEach(log => { const st = log.status === 'success' ? 'done' : (log.status === 'followed' ? 'followed' : 'error'); updateDMUserEntry(log.username, st, log.message); });
      }
    } catch (e) {}
  }

  async function loadLastConfig() {
    try {
      const { config } = await bg({ action: 'getLastConfig' });
      if (config) {
        if (config.postUrl) postUrlInput.value = config.postUrl;
        if (config.keywords) keywordsInput.value = config.keywords.join(', ');
        if (config.dmTemplate) dmTemplateInput.value = config.dmTemplate;
        if (config.delaySeconds) delayInput.value = config.delaySeconds;
        autoSendToggle.checked = false;
      }
    } catch (e) {}
    // Trigger initial warning check
    checkDelayWarning(delayInput, $('delayWarning'));
    checkDelayWarning(boDelayInput, $('boDelayWarning'));
  }

  // ─── Delay Warning Logic ───
  function checkDelayWarning(input, warningEl) {
    if (!input || !warningEl) return;
    const val = parseInt(input.value);
    warningEl.style.display = (val && val < 60) ? 'block' : 'none';
  }

  delayInput.addEventListener('input', () => checkDelayWarning(delayInput, $('delayWarning')));
  boDelayInput.addEventListener('input', () => checkDelayWarning(boDelayInput, $('boDelayWarning')));


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
    if (!input) return;
    input.style.borderColor = '#ed4956';
    input.style.boxShadow = '0 0 0 3px rgba(237,73,86,0.15)';
    setTimeout(() => { input.style.borderColor = ''; input.style.boxShadow = ''; }, 2000);
  }

  function timeNow() { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function escHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function addLogEntry(container, text, type, icon) {
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `<div class="log-icon ${type}">${icon || ''}</div><div class="log-body"><div class="log-detail">${text}</div></div><div class="log-time">${timeNow()}</div>`;
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;
  }


  // ═══════════════════════════════════════════════════════════════
  //  DASHBOARD
  // ═══════════════════════════════════════════════════════════════

  async function renderDashboard() {
    try {
      // Fetch history and waitlist
      const [histData, waitData, healthData] = await Promise.all([
        bg({ action: 'getHistory' }),
        bg({ action: 'getWaitlist' }),
        bg({ action: 'getSessionHealth' })
      ]);

      const history = histData.history || [];
      const waitlist = waitData.waitlist || [];
      const health = healthData || {};

      const now = Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;
      const oneWeekMs = 7 * oneDayMs;

      // Compute stats
      const dmsToday = history.filter(h => h.status === 'messaged' && h.timestamp && (now - h.timestamp) < oneDayMs).length;
      const dmsWeek = history.filter(h => h.status === 'messaged' && h.timestamp && (now - h.timestamp) < oneWeekMs).length;
      const totalAttempts = history.filter(h => h.timestamp && (now - h.timestamp) < oneWeekMs).length;
      const successCount = history.filter(h => h.status === 'messaged' && h.timestamp && (now - h.timestamp) < oneWeekMs).length;
      const successRate = totalAttempts > 0 ? Math.round((successCount / totalAttempts) * 100) : 0;
      const waitlistCount = waitlist.length;

      // Update stat cards
      if (statDMsToday) statDMsToday.textContent = dmsToday;
      if (statDMsWeek) statDMsWeek.textContent = dmsWeek;
      if (statSuccessRate) statSuccessRate.textContent = `${successRate}%`;
      if (statWaitlist) statWaitlist.textContent = waitlistCount;

      // Render 7-day bar chart
      renderActivityChart(history);

      // Render outcome breakdown
      renderOutcomeChart(history);

      // Render session health
      renderSessionHealth(health);

    } catch (e) {
      console.warn('Dashboard render error:', e);
    }
  }

  function renderActivityChart(history) {
    if (!activityChart) return;

    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const days = [];
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    // Build last 7 days (today = index 6)
    for (let i = 6; i >= 0; i--) {
      const dayStart = new Date(now - i * oneDayMs);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart.getTime() + oneDayMs);
      const count = history.filter(h =>
        h.status === 'messaged' && h.timestamp && h.timestamp >= dayStart.getTime() && h.timestamp < dayEnd.getTime()
      ).length;
      days.push({ label: dayNames[dayStart.getDay()], count });
    }

    const maxCount = Math.max(...days.map(d => d.count), 1);

    activityChart.innerHTML = days.map(d => {
      const heightPct = Math.max((d.count / maxCount) * 100, 3);
      return `<div class="bar-day">
        <span class="bar-count">${d.count || ''}</span>
        <div class="bar-fill" style="height:${heightPct}%"></div>
        <span class="bar-label">${d.label}</span>
      </div>`;
    }).join('');
  }

  function renderOutcomeChart(history) {
    if (!outcomeChart) return;

    const now = Date.now();
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
    const weekHistory = history.filter(h => h.timestamp && (now - h.timestamp) < oneWeekMs);

    const messaged = weekHistory.filter(h => h.status === 'messaged').length;
    const followed = weekHistory.filter(h => h.status === 'followed' || h.status === 'requested').length;
    const waitlisted = weekHistory.filter(h => h.status === 'skipped' || h.status === 'requested').length;
    const errors = weekHistory.filter(h => h.status === 'error').length;

    const maxVal = Math.max(messaged, followed, waitlisted, errors, 1);

    const bars = [
      { label: 'Messaged', cls: 'messaged', value: messaged },
      { label: 'Followed', cls: 'followed', value: followed },
      { label: 'Waitlisted', cls: 'waitlisted', value: waitlisted },
      { label: 'Errors', cls: 'error', value: errors }
    ];

    outcomeChart.innerHTML = bars.map(b => {
      const widthPct = maxVal > 0 ? Math.round((b.value / maxVal) * 100) : 0;
      return `<div class="h-bar-row">
        <span class="h-bar-label">${b.label}</span>
        <div class="h-bar-track"><div class="h-bar-fill ${b.cls}" style="width:${widthPct}%"></div></div>
        <span class="h-bar-value">${b.value}</span>
      </div>`;
    }).join('');
  }

  function renderSessionHealth(health) {
    if (!sessionHealthDisplay) return;

    const total = (health.totalSent || 0) + (health.totalFailed || 0);
    if (total === 0) {
      sessionHealthDisplay.innerHTML = '<span class="health-status good">No active session</span>';
      return;
    }

    const rate = health.successRate ?? 100;
    let statusClass = 'good';
    let statusText = 'Healthy';
    let barColor = '#00c853';

    if (rate < 60) { statusClass = 'bad'; statusText = 'Degraded'; barColor = '#ed4956'; }
    else if (rate < 80) { statusClass = 'warning'; statusText = 'Fair'; barColor = '#ff9800'; }

    sessionHealthDisplay.innerHTML = `
      <span class="health-status ${statusClass}">${statusText} — ${health.totalSent || 0} sent, ${health.totalFailed || 0} failed</span>
      <div class="health-bar">
        <div class="health-bar-track">
          <div class="health-bar-fill" style="width:${rate}%;background:${barColor}"></div>
        </div>
        <span class="health-bar-pct" style="color:${barColor}">${rate}%</span>
      </div>
    `;
  }


  // ═══════════════════════════════════════════════════════════════
  //  CSV IMPORT / EXPORT
  // ═══════════════════════════════════════════════════════════════

  function setupCSVHandlers() {
    // Import CSV
    if (btnImportCSV) {
      btnImportCSV.addEventListener('click', () => {
        if (csvFileInput) csvFileInput.click();
      });
    }

    if (csvFileInput) {
      csvFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (evt) => {
          const text = evt.target.result;
          const handles = parseCSVHandles(text);
          if (handles.length > 0 && boHandlesInput) {
            // Append to existing content or replace
            const existing = boHandlesInput.value.trim();
            boHandlesInput.value = existing ? existing + '\n' + handles.join('\n') : handles.join('\n');
          }
          // Reset file input so same file can be re-imported
          csvFileInput.value = '';
        };
        reader.readAsText(file);
      });
    }

    // Export handles to CSV
    if (btnExportCSV) {
      btnExportCSV.addEventListener('click', () => {
        if (!boHandlesInput) return;
        const raw = boHandlesInput.value.trim();
        if (!raw) return;

        const handles = raw.split('\n').map(h => h.trim().replace(/^@/, '')).filter(Boolean);
        const csvContent = 'handle\n' + handles.map(h => h).join('\n');
        downloadCSV(csvContent, 'handles_export.csv');
      });
    }

    // Export History to CSV
    if (btnExportHistory) {
      btnExportHistory.addEventListener('click', async () => {
        try {
          const { history } = await bg({ action: 'getHistory' });
          const items = history || [];
          if (!items.length) return;

          const headers = ['username', 'platform', 'status', 'viewed', 'followed', 'messaged', 'templateName', 'timestamp', 'message', 'cadenceStep'];
          const rows = items.map(h => [
            h.username || '',
            h.platform || 'instagram',
            h.status || '',
            h.viewed ? 'true' : 'false',
            h.followed ? 'true' : 'false',
            h.status === 'messaged' ? 'true' : 'false',
            csvEscape(h.templateName || ''),
            h.timestamp ? new Date(h.timestamp).toISOString() : '',
            csvEscape(h.message || ''),
            h.cadenceStep || ''
          ]);

          const csvContent = headers.join(',') + '\n' + rows.map(r => r.join(',')).join('\n');
          downloadCSV(csvContent, 'outreach_history.csv');
        } catch (e) {
          console.warn('Export history error:', e);
        }
      });
    }
  }

  function parseCSVHandles(text) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return [];

    // Check if first line is a header
    const firstLine = lines[0].toLowerCase();
    const hasHeader = firstLine.includes('handle') || firstLine.includes('username') || firstLine.includes('user');
    const dataLines = hasHeader ? lines.slice(1) : lines;

    // Determine column index
    let colIdx = 0;
    if (hasHeader) {
      const cols = lines[0].split(',').map(c => c.trim().toLowerCase().replace(/["']/g, ''));
      const handleIdx = cols.findIndex(c => c === 'handle' || c === 'username' || c === 'user');
      if (handleIdx >= 0) colIdx = handleIdx;
    }

    const handles = [];
    for (const line of dataLines) {
      // Simple CSV parsing (handles commas in quotes)
      const cols = parseCSVLine(line);
      const val = (cols[colIdx] || '').trim().replace(/^@/, '');
      if (val && !val.includes(' ')) handles.push(val);
    }

    return [...new Set(handles)];
  }

  function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === ',' && !inQuotes) {
        result.push(current); current = '';
      } else {
        current += ch;
      }
    }
    result.push(current);
    return result;
  }

  function csvEscape(str) {
    if (!str) return '';
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  function downloadCSV(content, filename) {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }


});
