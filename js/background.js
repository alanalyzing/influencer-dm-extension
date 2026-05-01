/**
 * Background Service Worker (v6) — Multi-Platform
 *
 * THE ORCHESTRATOR — drives all navigation and content-script injection.
 * Now supports both Instagram and Threads.
 *
 * Two modes:
 *   1. Bulk Outreach (primary) — handle list, follow/DM, waitlist, cadence
 *   2. Keyword Scan — scan post comments, send DMs
 *
 * Platform routing:
 *   - Instagram: instagram.com profiles, DMs via Message button
 *   - Threads: threads.net profiles for follow, but DMs redirect to Instagram
 *     (Threads web DMs not yet available)
 */

// ─── State: Keyword Scan ───
let state = {
  status: 'idle',
  postUrl: '',
  keywords: [],
  dmTemplate: '',
  delaySeconds: 60,
  matchedUsers: [],
  selectedUsers: [],
  sentLog: [],
  pendingFollow: [],
  currentIndex: 0,
  tabId: null,
  currentDMStep: '',
  currentDMUser: '',
  platform: 'instagram'
};

// ─── State: Bulk Outreach ───
let boState = {
  status: 'idle',
  outreachList: [],
  delaySeconds: 60,
  sentLog: [],
  currentIndex: 0,
  tabId: null,
  cadenceConfig: null,
  platform: 'instagram',
  behaviorSettings: { alwaysFollow: true, dmAfterFollow: true, waitlistPrivate: true, skipPrivate: false }
};

// ─── Session Health Monitor ───
let sessionHealth = {
  recentResults: [],   // Last N results: true = success, false = failure
  windowSize: 5,       // Track last 5 DM send attempts
  failThreshold: 4,    // Auto-pause if 4 of last 5 DM sends fail
  consecutiveFails: 0, // Track consecutive DM send failures
  consecutiveFailMax: 3, // Auto-pause after 3 consecutive DM send failures
  totalSent: 0,
  totalFailed: 0,
  adaptiveDelay: 0     // Extra delay added when health degrades
};

function resetSessionHealth() {
  sessionHealth.recentResults = [];
  sessionHealth.consecutiveFails = 0;
  sessionHealth.totalSent = 0;
  sessionHealth.totalFailed = 0;
  sessionHealth.adaptiveDelay = 0;
}

function recordHealthResult(success) {
  sessionHealth.recentResults.push(success);
  if (sessionHealth.recentResults.length > sessionHealth.windowSize) {
    sessionHealth.recentResults.shift();
  }

  if (success) {
    sessionHealth.consecutiveFails = 0;
    sessionHealth.totalSent++;
    // Reduce adaptive delay on success (min 0)
    sessionHealth.adaptiveDelay = Math.max(0, sessionHealth.adaptiveDelay - 5000);
  } else {
    sessionHealth.consecutiveFails++;
    sessionHealth.totalFailed++;
    // Increase adaptive delay on failure (+10s per failure)
    sessionHealth.adaptiveDelay = Math.min(60000, sessionHealth.adaptiveDelay + 10000);
  }
}

function shouldAutoPause() {
  // Check consecutive failures
  if (sessionHealth.consecutiveFails >= sessionHealth.consecutiveFailMax) {
    return { pause: true, reason: `${sessionHealth.consecutiveFails} consecutive failures detected — possible rate limit` };
  }

  // Check rolling window
  if (sessionHealth.recentResults.length >= sessionHealth.windowSize) {
    const failures = sessionHealth.recentResults.filter(r => !r).length;
    if (failures >= sessionHealth.failThreshold) {
      return { pause: true, reason: `${failures}/${sessionHealth.windowSize} recent attempts failed — possible rate limit or silent block` };
    }
  }

  return { pause: false };
}

// ─── Cadence timer ───
let cadenceTimerId = null;

// ─── Platform helpers ───
function profileUrl(username, platform) {
  if (platform === 'threads') return `https://www.threads.net/@${username}`;
  return `https://www.instagram.com/${username}/`;
}

function platformBaseUrl(platform) {
  if (platform === 'threads') return 'https://www.threads.net/';
  return 'https://www.instagram.com/';
}

function platformTabQuery(platform) {
  if (platform === 'threads') return 'https://www.threads.net/*';
  return 'https://www.instagram.com/*';
}

function contentScriptFile(platform) {
  if (platform === 'threads') return 'js/threads-content.js';
  return 'js/content.js';
}

// For DMs, always use Instagram (Threads has no web DMs)
function dmProfileUrl(username) {
  return `https://www.instagram.com/${username}/`;
}

// ─── Open side panel when extension icon is clicked ───
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ─── Start cadence processor on startup ───
startCadenceProcessor();

// ─── Message Router ───
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = handlers[msg.action];
  if (!fn) return;
  const result = fn(msg, sender);
  if (result instanceof Promise) {
    result.then(r => sendResponse(r)).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  sendResponse(result);
  return true;
});

const handlers = {

  getState: () => ({ ...state }),

  // ═══════════════════════════════════════════
  //  KEYWORD SCAN
  // ═══════════════════════════════════════════

  startScan: async (msg) => {
    state.postUrl = msg.postUrl;
    state.keywords = msg.keywords;
    state.dmTemplate = msg.dmTemplate;
    state.delaySeconds = msg.delaySeconds || 60;
    state.platform = msg.platform || 'instagram';
    state.status = 'scanning';
    state.matchedUsers = [];
    state.sentLog = [];
    state.currentIndex = 0;

    await chrome.storage.local.set({ lastConfig: {
      postUrl: msg.postUrl, keywords: msg.keywords,
      dmTemplate: msg.dmTemplate, delaySeconds: msg.delaySeconds,
      autoSend: msg.autoSend || false, platform: state.platform
    }});

    broadcastProgress({ step: 'scan', detail: 'Navigating to post...' });

    // Detect platform from URL if not explicitly set
    if (msg.postUrl.includes('threads.net')) state.platform = 'threads';
    else if (msg.postUrl.includes('instagram.com')) state.platform = 'instagram';

    const tab = await getOrCreateTab(msg.postUrl, state.platform);
    state.tabId = tab.id;
    await waitForTabLoad(tab.id);
    await delay(4000);
    await injectContentScript(tab.id, state.platform);
    await delay(1000);
    broadcastProgress({ step: 'scan', detail: 'Scrolling comment area and extracting comments...' });

    try {
      const result = await sendToTab(tab.id, { action: 'scanComments', keywords: state.keywords });
      if (result && result.matchedUsers) state.matchedUsers = result.matchedUsers;
    } catch (e) {
      broadcastProgress({ step: 'scan', detail: 'Scan error: ' + e.message, type: 'error' });
    }

    state.status = 'reviewing';
    broadcastProgress({ step: 'scan', detail: `Scan complete! Found ${state.matchedUsers.length} matches.`, type: 'success' });
    return { success: true, matchedUsers: state.matchedUsers };
  },

  scanProgress: (msg) => { broadcastProgress({ step: 'scan', detail: msg.detail || `Scanned ${msg.scanned}/${msg.total} comments` }); return { success: true }; },
  scanResults: (msg) => { state.matchedUsers = msg.matchedUsers || []; state.status = 'reviewing'; return { success: true }; },
  cancelScan: () => { state.status = 'idle'; return { success: true }; },

  startSendingDMs: async (msg) => {
    state.selectedUsers = msg.selectedUsers;
    state.status = 'sending';
    state.currentIndex = 0;
    state.sentLog = [];
    runDMLoop();
    return { success: true };
  },

  pauseDMs: () => { state.status = 'paused'; return { success: true }; },
  resumeDMs: () => {
    state.status = 'sending';
    sessionHealth.consecutiveFails = 0;
    sessionHealth.recentResults = [];
    runDMLoop();
    return { success: true };
  },

  reset: () => {
    state.status = 'idle'; state.matchedUsers = []; state.selectedUsers = [];
    state.sentLog = []; state.currentIndex = 0; state.currentDMStep = ''; state.currentDMUser = '';
    return { success: true };
  },

  getHistory: async () => { const data = await chrome.storage.local.get('dmHistory'); return { history: data.dmHistory || [] }; },
  clearHistory: async () => { await chrome.storage.local.set({ dmHistory: [] }); return { success: true }; },
  getLastConfig: async () => { const data = await chrome.storage.local.get('lastConfig'); return { config: data.lastConfig || null }; },

  getPendingFollows: async () => { const data = await chrome.storage.local.get('pendingFollows'); return { pendingFollows: data.pendingFollows || [] }; },
  clearPendingFollows: async () => { await chrome.storage.local.set({ pendingFollows: [] }); return { success: true }; },

  // ═══════════════════════════════════════════
  //  BULK OUTREACH
  // ═══════════════════════════════════════════

  getBOState: () => ({ ...boState }),

  startBulkOutreach: async (msg) => {
    boState.outreachList = msg.outreachList;
    boState.delaySeconds = msg.delaySeconds || 60;
    boState.cadenceConfig = msg.cadenceConfig || null;
    boState.platform = msg.platform || 'instagram';
    boState.behaviorSettings = msg.behaviorSettings || { alwaysFollow: true, dmAfterFollow: true, waitlistPrivate: true };
    boState.status = 'sending';
    boState.currentIndex = 0;
    boState.sentLog = [];
    resetSessionHealth();
    runBulkOutreachLoop();
    return { success: true };
  },

  pauseBO: () => { boState.status = 'paused'; return { success: true }; },
  resumeBO: () => {
    boState.status = 'sending';
    // Reset health tracking on resume so old failures don't immediately re-trigger pause
    sessionHealth.consecutiveFails = 0;
    sessionHealth.recentResults = [];
    sessionHealth.adaptiveDelay = Math.max(0, sessionHealth.adaptiveDelay - 15000); // Reduce adaptive delay on resume
    runBulkOutreachLoop();
    return { success: true };
  },

  getSessionHealth: () => ({
    ...sessionHealth,
    successRate: sessionHealth.totalSent + sessionHealth.totalFailed > 0
      ? Math.round((sessionHealth.totalSent / (sessionHealth.totalSent + sessionHealth.totalFailed)) * 100)
      : 100
  }),

  resetBO: () => {
    boState.status = 'idle'; boState.outreachList = []; boState.sentLog = [];
    boState.currentIndex = 0; boState.cadenceConfig = null;
    return { success: true };
  },

  // ═══════════════════════════════════════════
  //  WAITLIST
  // ═══════════════════════════════════════════

  getWaitlist: async () => {
    const data = await chrome.storage.local.get('boWaitlist');
    return { waitlist: data.boWaitlist || [] };
  },

  clearWaitlist: async () => {
    await chrome.storage.local.set({ boWaitlist: [] });
    return { success: true };
  },

  recheckWaitlist: async (msg) => {
    const data = await chrome.storage.local.get('boWaitlist');
    const waitlist = data.boWaitlist || [];
    if (!waitlist.length) return { success: false, error: 'Waitlist empty' };
    runWaitlistRecheck(waitlist, msg.platform || 'instagram');
    return { success: true };
  },

  // ═══════════════════════════════════════════
  //  CADENCE QUEUE
  // ═══════════════════════════════════════════

  getCadenceQueue: async () => {
    const data = await chrome.storage.local.get('cadenceQueue');
    return { cadenceQueue: data.cadenceQueue || [] };
  },

  clearCadenceQueue: async () => {
    await chrome.storage.local.set({ cadenceQueue: [] });
    return { success: true };
  }
};


// ════════════════════════════════════════════════════════════
//  KEYWORD SCAN: DM LOOP
// ════════════════════════════════════════════════════════════

async function runDMLoop() {
  // DMs always go through Instagram
  while (state.status === 'sending' && state.currentIndex < state.selectedUsers.length) {
    const user = state.selectedUsers[state.currentIndex];
    const personalizedMsg = state.dmTemplate.replace(/\{\{username\}\}/gi, user.username);
    state.currentDMUser = user.username;

    try {
      // ── DEDUPLICATION CHECK: Skip if already messaged ──
      const alreadySent = await isAlreadyMessaged(user.username);
      if (alreadySent) {
        const skipMsg = `Skipped @${user.username} — already messaged previously`;
        broadcastDMProgress(user.username, 'done', skipMsg);
        state.sentLog.push({ username: user.username, status: 'skipped-dup', message: skipMsg, timestamp: Date.now(), viewed: false, followed: false, platform: state.platform });
        state.currentIndex++;
        continue;
      }

      // Always navigate to Instagram profile for DMs (even if scan was on Threads)
      state.currentDMStep = 'navigating';
      broadcastDMProgress(user.username, 'navigating', `Opening @${user.username}'s profile...`);
      await chrome.tabs.update(state.tabId, { url: dmProfileUrl(user.username) });
      await waitForTabLoad(state.tabId);
      await delay(3000);

      state.currentDMStep = 'clickingMessage';
      broadcastDMProgress(user.username, 'clickingMessage', 'Finding and clicking "Message" button...');
      await injectContentScript(state.tabId, 'instagram'); // Always Instagram for DMs
      await delay(500);
      const clickResult = await sendToTab(state.tabId, { action: 'clickMessageButton' });

      if (clickResult && clickResult.error && clickResult.noMessage) {
        state.currentDMStep = 'following';
        broadcastDMProgress(user.username, 'following', 'No Message button — following user instead...');
        await delay(500);
        const followResult = await sendToTab(state.tabId, { action: 'clickFollowButton' });
        const followStatus = followResult?.status || 'unknown';
        const alreadyFollowing = followResult?.alreadyFollowing || false;
        await savePendingFollow({ username: user.username, comment: user.comment || '', matchedKeyword: user.matchedKeyword || '', followStatus, alreadyFollowing, timestamp: new Date().toISOString() });
        state.currentDMStep = 'followed';
        const statusMsg = alreadyFollowing ? `Already following @${user.username} — saved to retry queue` : `Followed @${user.username} (${followStatus}) — saved to retry queue`;
        broadcastDMProgress(user.username, 'followed', statusMsg);
        const logEntry = { username: user.username, status: 'followed', message: statusMsg, timestamp: Date.now(), viewed: true, followed: true, platform: state.platform };
        state.sentLog.push(logEntry);
        await saveDMHistory(logEntry);
        state.currentIndex++;
        if (state.status === 'sending' && state.currentIndex < state.selectedUsers.length) {
          broadcastDMProgress('', 'waiting', `Waiting ${state.delaySeconds}s before next user...`);
          await delay(state.delaySeconds * 1000, true, () => state.status !== 'sending');
        }
        continue;
      } else if (clickResult && clickResult.error) {
        throw new Error(clickResult.error);
      }

      state.currentDMStep = 'waitingDM';
      broadcastDMProgress(user.username, 'waitingDM', 'Waiting for DM conversation to open...');
      await delay(3000);
      await injectContentScript(state.tabId, 'instagram');
      await delay(1000);

      state.currentDMStep = 'typing';
      broadcastDMProgress(user.username, 'typing', 'Typing message...');
      const typeResult = await sendToTab(state.tabId, { action: 'typeAndSendDM', message: personalizedMsg });
      if (typeResult && typeResult.error) throw new Error(typeResult.error);

      state.currentDMStep = 'done';
      broadcastDMProgress(user.username, 'done', 'DM sent successfully!');
      const logEntry = { username: user.username, status: 'messaged', message: 'DM sent successfully', timestamp: Date.now(), viewed: true, followed: false, platform: state.platform };
      state.sentLog.push(logEntry);
      await saveDMHistory(logEntry);

    } catch (err) {
      state.currentDMStep = 'error';
      broadcastDMProgress(user.username, 'error', `Error: ${err.message}`);
      const logEntry = { username: user.username, status: 'error', message: err.message, timestamp: Date.now(), viewed: true, followed: false, platform: state.platform };
      state.sentLog.push(logEntry);
      await saveDMHistory(logEntry);
    }

    state.currentIndex++;
    if (state.status === 'sending' && state.currentIndex < state.selectedUsers.length) {
      broadcastDMProgress('', 'waiting', `Waiting ${state.delaySeconds}s before next DM...`);
      await delay(state.delaySeconds * 1000, true, () => state.status !== 'sending');
    }
  }

  if (state.currentIndex >= state.selectedUsers.length) {
    state.status = 'done';
    const successCount = state.sentLog.filter(l => l.status === 'messaged').length;
    const followedCount = state.sentLog.filter(l => l.status === 'followed').length;
    let summary = `All done! ${successCount}/${state.selectedUsers.length} DMs sent.`;
    if (followedCount > 0) summary += ` ${followedCount} user(s) followed (pending DM).`;
    broadcastProgress({ step: 'dmDone', detail: summary, type: 'success' });
  }
}


// ════════════════════════════════════════════════════════════
//  BULK OUTREACH LOOP (multi-platform)
// ════════════════════════════════════════════════════════════

async function runBulkOutreachLoop() {
  const platform = boState.platform || 'instagram';
  const settings = boState.behaviorSettings || { alwaysFollow: true, dmAfterFollow: true, waitlistPrivate: true };

  if (!boState.tabId) {
    const tab = await getOrCreateTab(platformBaseUrl(platform), platform);
    boState.tabId = tab.id;
    await waitForTabLoad(tab.id);
    await delay(2000);
  }

  while (boState.status === 'sending' && boState.currentIndex < boState.outreachList.length) {
    const user = boState.outreachList[boState.currentIndex];
    const personalizedMsg = (user.dmTemplate || '').replace(/\{\{username\}\}/gi, user.username);

    try {
      // ── DEDUPLICATION CHECK: Skip if already messaged ──
      const alreadySent = await isAlreadyMessaged(user.username);
      if (alreadySent) {
        const skipMsg = `Skipped @${user.username} — already messaged previously`;
        broadcastBOProgress(user.username, 'done', skipMsg);
        boState.sentLog.push({ username: user.username, status: 'skipped-dup', message: skipMsg, timestamp: Date.now() });
        boState.currentIndex++;
        continue;
      }

      // Step 1: Navigate to profile on the selected platform
      broadcastBOProgress(user.username, 'checking', `Opening @${user.username}'s profile...`);
      const pUrl = profileUrl(user.username, platform);
      await chrome.tabs.update(boState.tabId, { url: pUrl });
      await waitForTabLoad(boState.tabId);
      await delay(3000);

      // Step 2: Inject platform-specific content script and check profile
      await injectContentScript(boState.tabId, platform);
      await delay(500);

      const profileCheck = await sendToTab(boState.tabId, { action: 'checkProfileActions' });

      // ── SKIP PRIVATE PROFILES: Detect private accounts before any action ──
      if (settings.skipPrivate && profileCheck && !profileCheck.hasMessage) {
        const privacyCheck = await sendToTab(boState.tabId, { action: 'checkIfPrivate' });
        if (privacyCheck && privacyCheck.isPrivate) {
          const skipMsg = `Skipped @${user.username} — private profile`;
          broadcastBOProgress(user.username, 'skipped', skipMsg);
          boState.sentLog.push({ username: user.username, status: 'skipped', message: skipMsg, timestamp: Date.now() });
          boState.currentIndex++;
          if (boState.status === 'sending' && boState.currentIndex < boState.outreachList.length) {
            broadcastBOProgress('', 'waiting', `Waiting ${boState.delaySeconds}s before next user...`);
            await delay(boState.delaySeconds * 1000, true, () => boState.status !== 'sending');
          }
          continue;
        }
      }

      if (profileCheck && profileCheck.hasMessage) {
        // ── Message button visible path ──
        let didFollow = false;

        // Setting: Always follow before sending DM (even when Message is already visible)
        if (settings.alwaysFollow && !profileCheck.isFollowing) {
          broadcastBOProgress(user.username, 'following', 'Following before sending DM...');
          const followResult = await sendToTab(boState.tabId, { action: 'clickFollowButton' });
          didFollow = followResult?.success || false;
          await delay(1500);
        }

        // For Threads: redirect to Instagram for DM since Threads has no web DMs
        if (platform === 'threads') {
          broadcastBOProgress(user.username, 'dm-direct', 'Message available — redirecting to Instagram for DM...');
          await chrome.tabs.update(boState.tabId, { url: dmProfileUrl(user.username) });
          await waitForTabLoad(boState.tabId);
          await delay(3000);
          await injectContentScript(boState.tabId, 'instagram');
          await delay(500);
          const igClickResult = await sendToTab(boState.tabId, { action: 'clickMessageButton' });
          if (igClickResult && igClickResult.error) throw new Error(igClickResult.error);
        } else {
          broadcastBOProgress(user.username, 'dm-direct', 'Message button found — clicking...');
          const clickResult = await sendToTab(boState.tabId, { action: 'clickMessageButton' });
          if (clickResult && clickResult.error) throw new Error(clickResult.error);
        }

        await delay(3000);
        await injectContentScript(boState.tabId, 'instagram'); // DM always on Instagram
        await delay(1000);

        broadcastBOProgress(user.username, 'typing', 'Typing message...');
        const typeResult = await sendToTab(boState.tabId, { action: 'typeAndSendDM', message: personalizedMsg });
        if (typeResult && typeResult.error) throw new Error(typeResult.error);

        // Check verification status from content script
        if (typeResult && typeResult.warning) {
          // Unverified send — possible silent block
          const warnMsg = didFollow ? 'Followed & DM sent (unverified ⚠️)' : 'DM sent (unverified ⚠️)';
          broadcastBOProgress(user.username, 'done-warning', warnMsg + ' — ' + typeResult.warning);
          boState.sentLog.push({ username: user.username, status: 'success', message: warnMsg, timestamp: Date.now() });
          // Unverified sends are likely successful — do NOT count as health failure
          // Only true send failures (error thrown) should affect health
        } else {
          const doneMsg = didFollow ? 'Followed & DM sent!' : 'DM sent!';
          broadcastBOProgress(user.username, 'done', doneMsg);
          boState.sentLog.push({ username: user.username, status: 'success', message: doneMsg, timestamp: Date.now() });
          recordHealthResult(true);
        }

        await saveDMHistory({
          username: user.username,
          status: 'messaged',
          message: `${didFollow ? 'Followed & ' : ''}DM sent (${user.templateName})`,
          templateName: user.templateName,
          timestamp: Date.now(),
          viewed: true,
          followed: didFollow,
          platform
        });

        // Schedule cadence follow-ups if configured
        if (boState.cadenceConfig && boState.cadenceConfig.intervals && boState.cadenceConfig.intervals.length > 0) {
          await scheduleCadenceFollowUps(user, boState.cadenceConfig);
        }

      } else if (profileCheck && profileCheck.isRequested) {
        // ── Already requested (private account from previous run) — skip gracefully ──
        if (settings.waitlistPrivate) {
          await saveToWaitlist({
            username: user.username,
            templateId: user.templateId,
            templateName: user.templateName,
            dmTemplate: user.dmTemplate,
            followStatus: 'Requested',
            alreadyFollowing: true,
            timestamp: new Date().toISOString(),
            platform
          });
          const statusMsg = `@${user.username} already requested (private) — added to waitlist`;
          broadcastBOProgress(user.username, 'waitlisted', statusMsg);
          boState.sentLog.push({ username: user.username, status: 'waitlisted', message: statusMsg, timestamp: Date.now() });
          await saveDMHistory({
            username: user.username, status: 'requested', message: statusMsg,
            templateName: user.templateName, timestamp: Date.now(),
            viewed: true, followed: true, platform
          });
        } else {
          const statusMsg = `@${user.username} already requested (private) — skipped`;
          broadcastBOProgress(user.username, 'skipped', statusMsg);
          boState.sentLog.push({ username: user.username, status: 'skipped', message: statusMsg, timestamp: Date.now() });
        }
        // Do NOT record as health failure — this is expected behavior

      } else {
        // ── No Message button — need to Follow first ──
        broadcastBOProgress(user.username, 'following', 'No Message button — following...');

        const followResult = await sendToTab(boState.tabId, { action: 'clickFollowButton' });

        // Handle follow button errors gracefully (private profile edge cases)
        if (followResult && followResult.error) {
          // No follow button found — likely a private profile with unusual layout
          // or already-requested state not detected by checkProfileActions
          const statusMsg = `@${user.username} — could not follow (${followResult.error}), added to waitlist`;
          broadcastBOProgress(user.username, 'waitlisted', statusMsg);
          boState.sentLog.push({ username: user.username, status: 'waitlisted', message: statusMsg, timestamp: Date.now() });
          await saveToWaitlist({
            username: user.username, templateId: user.templateId,
            templateName: user.templateName, dmTemplate: user.dmTemplate,
            followStatus: 'Unknown', alreadyFollowing: false,
            timestamp: new Date().toISOString(), platform
          });
          await saveDMHistory({
            username: user.username, status: 'error', message: statusMsg,
            templateName: user.templateName, timestamp: Date.now(),
            viewed: true, followed: false, platform
          });
          // Do NOT record as health failure — move to next user
          boState.currentIndex++;
          if (boState.status === 'sending' && boState.currentIndex < boState.outreachList.length) {
            broadcastBOProgress('', 'waiting', `Waiting ${boState.delaySeconds}s before next user...`);
            await delay(boState.delaySeconds * 1000, true, () => boState.status !== 'sending');
          }
          continue;
        }

        const followStatus = followResult?.status || 'unknown';
        const alreadyFollowing = followResult?.alreadyFollowing || false;

        if (followStatus === 'Requested') {
          // ── Private account, needs approval ──
          if (settings.waitlistPrivate) {
            // Setting: Waitlist private accounts
            await saveToWaitlist({
              username: user.username,
              templateId: user.templateId,
              templateName: user.templateName,
              dmTemplate: user.dmTemplate,
              followStatus: 'Requested',
              alreadyFollowing: false,
              timestamp: new Date().toISOString(),
              platform
            });

            const statusMsg = `Follow requested @${user.username} — added to waitlist (pending approval)`;
            broadcastBOProgress(user.username, 'waitlisted', statusMsg);
            boState.sentLog.push({ username: user.username, status: 'waitlisted', message: statusMsg, timestamp: Date.now() });

            await saveDMHistory({
              username: user.username,
              status: 'requested',
              message: statusMsg,
              templateName: user.templateName,
              timestamp: Date.now(),
              viewed: true,
              followed: true,
              platform
            });
          } else {
            // Setting: Skip private accounts entirely
            const statusMsg = `Follow requested @${user.username} — skipped (private account)`;
            broadcastBOProgress(user.username, 'skipped', statusMsg);
            boState.sentLog.push({ username: user.username, status: 'skipped', message: statusMsg, timestamp: Date.now() });

            await saveDMHistory({
              username: user.username,
              status: 'skipped',
              message: statusMsg,
              templateName: user.templateName,
              timestamp: Date.now(),
              viewed: true,
              followed: true,
              platform
            });
          }

        } else if (settings.dmAfterFollow) {
          // ── Following (public) or already following → DM immediately (setting enabled) ──
          broadcastBOProgress(user.username, 'checking', `Followed @${user.username} — checking for Message button...`);

          // For Threads: after follow, redirect to Instagram for DM
          if (platform === 'threads') {
            broadcastBOProgress(user.username, 'dm-direct', 'Followed on Threads — redirecting to Instagram for DM...');
            await chrome.tabs.update(boState.tabId, { url: dmProfileUrl(user.username) });
            await waitForTabLoad(boState.tabId);
            await delay(3000);
            await injectContentScript(boState.tabId, 'instagram');
            await delay(500);
          } else {
            await delay(2000);
            await injectContentScript(boState.tabId, platform);
            await delay(500);
          }

          const msgCheck = await sendToTab(boState.tabId, { action: 'checkForMessageButton' });

          if (msgCheck && msgCheck.found) {
            // Message button appeared → DM now
            broadcastBOProgress(user.username, 'dm-direct', 'Message button appeared — clicking...');
            const clickResult = await sendToTab(boState.tabId, { action: 'clickMessageButton' });
            if (clickResult && clickResult.error) throw new Error(clickResult.error);

            await delay(3000);
            await injectContentScript(boState.tabId, 'instagram');
            await delay(1000);

            broadcastBOProgress(user.username, 'typing', 'Typing message...');
            const typeResult = await sendToTab(boState.tabId, { action: 'typeAndSendDM', message: personalizedMsg });
            if (typeResult && typeResult.error) throw new Error(typeResult.error);

            // Check verification status
            if (typeResult && typeResult.warning) {
              broadcastBOProgress(user.username, 'done-warning', `Followed & DM sent (unverified ⚠️) — ${typeResult.warning}`);
              boState.sentLog.push({ username: user.username, status: 'success', message: 'Followed & DM sent (unverified)', timestamp: Date.now() });
              // Unverified sends are likely successful — do NOT count as health failure
            } else {
              broadcastBOProgress(user.username, 'done', `Followed & DM sent to @${user.username}!`);
              boState.sentLog.push({ username: user.username, status: 'success', message: 'Followed & DM sent', timestamp: Date.now() });
              recordHealthResult(true);
            }

            await saveDMHistory({
              username: user.username,
              status: 'messaged',
              message: `Followed & DM sent (${user.templateName})`,
              templateName: user.templateName,
              timestamp: Date.now(),
              viewed: true,
              followed: true,
              platform
            });

            if (boState.cadenceConfig && boState.cadenceConfig.intervals && boState.cadenceConfig.intervals.length > 0) {
              await scheduleCadenceFollowUps(user, boState.cadenceConfig);
            }

          } else {
            // Message button still not visible → Waitlist as fallback
            await saveToWaitlist({
              username: user.username,
              templateId: user.templateId,
              templateName: user.templateName,
              dmTemplate: user.dmTemplate,
              followStatus: alreadyFollowing ? 'AlreadyFollowing' : followStatus,
              alreadyFollowing,
              timestamp: new Date().toISOString(),
              platform
            });

            const statusMsg = `Followed @${user.username} but Message button not available — added to waitlist`;
            broadcastBOProgress(user.username, 'waitlisted', statusMsg);
            boState.sentLog.push({ username: user.username, status: 'waitlisted', message: statusMsg, timestamp: Date.now() });

            await saveDMHistory({
              username: user.username,
              status: 'followed',
              message: statusMsg,
              templateName: user.templateName,
              timestamp: Date.now(),
              viewed: true,
              followed: true,
              platform
            });
          }

        } else {
          // ── Setting: Don't DM after follow → add to waitlist for later ──
          await saveToWaitlist({
            username: user.username,
            templateId: user.templateId,
            templateName: user.templateName,
            dmTemplate: user.dmTemplate,
            followStatus: alreadyFollowing ? 'AlreadyFollowing' : followStatus,
            alreadyFollowing,
            timestamp: new Date().toISOString(),
            platform
          });

          const statusMsg = `Followed @${user.username} — added to waitlist (DM later)`;
          broadcastBOProgress(user.username, 'waitlisted', statusMsg);
          boState.sentLog.push({ username: user.username, status: 'waitlisted', message: statusMsg, timestamp: Date.now() });

          await saveDMHistory({
            username: user.username,
            status: 'followed',
            message: statusMsg,
            templateName: user.templateName,
            timestamp: Date.now(),
            viewed: true,
            followed: true,
            platform
          });
        }
      }

    } catch (err) {
      broadcastBOProgress(user.username, 'error', `Error: ${err.message}`);
      boState.sentLog.push({ username: user.username, status: 'error', message: err.message, timestamp: Date.now() });

      // Only count DM-related errors as health failures.
      // Profile/follow errors (e.g., private accounts, no follow button) should NOT
      // trigger auto-pause since they are expected for private profiles.
      const isDMError = err.message && (
        err.message.includes('message input') ||
        err.message.includes('Send button') ||
        err.message.includes('DM') ||
        err.message.includes('typing') ||
        err.message.includes('sendFailed')
      );
      if (isDMError) {
        recordHealthResult(false);
      }

      await saveDMHistory({
        username: user.username,
        status: 'error',
        message: err.message,
        templateName: user.templateName,
        timestamp: Date.now(),
        viewed: true,
        followed: false,
        platform
      });
    }

    boState.currentIndex++;

    // ── Session Health Check: Auto-pause if too many failures ──
    if (boState.status === 'sending') {
      const healthCheck = shouldAutoPause();
      if (healthCheck.pause) {
        boState.status = 'paused';
        const lastErrors = boState.sentLog.slice(-3).filter(l => l.status === 'error').map(l => l.message).join('; ');
        broadcastBOProgress('', 'health-pause', `⚠️ AUTO-PAUSED: ${healthCheck.reason}. Last errors: ${lastErrors || 'none logged'}. Session: ${sessionHealth.totalSent} sent, ${sessionHealth.totalFailed} failed. Resume to continue.`);
        broadcastProgress({ step: 'boHealthPause', detail: healthCheck.reason, type: 'warning' });
        return; // Exit loop — user must manually resume
      }
    }

    if (boState.status === 'sending' && boState.currentIndex < boState.outreachList.length) {
      // Apply adaptive delay: base delay + extra delay from health degradation
      const totalDelay = (boState.delaySeconds * 1000) + sessionHealth.adaptiveDelay;
      const adaptiveNote = sessionHealth.adaptiveDelay > 0
        ? ` (+${Math.round(sessionHealth.adaptiveDelay / 1000)}s adaptive)`
        : '';
      broadcastBOProgress('', 'waiting', `Waiting ${Math.round(totalDelay / 1000)}s before next user...${adaptiveNote}`);
      await delay(totalDelay, true, () => boState.status !== 'sending');
    }
  }

  if (boState.currentIndex >= boState.outreachList.length) {
    boState.status = 'done';
    const dmSent = boState.sentLog.filter(l => l.status === 'success').length;
    const waitlisted = boState.sentLog.filter(l => l.status === 'waitlisted').length;
    const failed = boState.sentLog.filter(l => l.status === 'error').length;
    let summary = `All done! ${dmSent} DMs sent.`;
    if (waitlisted > 0) summary += ` ${waitlisted} added to waitlist.`;
    if (failed > 0) summary += ` ${failed} failed.`;
    summary += ` (Health: ${sessionHealth.totalSent}/${sessionHealth.totalSent + sessionHealth.totalFailed} success rate)`;
    broadcastProgress({ step: 'boDone', detail: summary, type: 'success' });
  }
}


// ════════════════════════════════════════════════════════════
//  CADENCE FOLLOW-UP SCHEDULING
// ════════════════════════════════════════════════════════════

async function scheduleCadenceFollowUps(user, cadenceConfig) {
  const data = await chrome.storage.local.get('cadenceQueue');
  const queue = data.cadenceQueue || [];
  const now = Date.now();

  let followUpTemplate = user.dmTemplate;
  if (cadenceConfig.followUpTemplateId) {
    const tplData = await chrome.storage.local.get('boTemplates');
    const tpls = tplData.boTemplates || [];
    const tpl = tpls.find(t => t.id === cadenceConfig.followUpTemplateId);
    if (tpl) followUpTemplate = tpl.body;
  }

  for (const hours of cadenceConfig.intervals) {
    const sendAt = now + (hours * 3600000);
    const exists = queue.some(q => q.username === user.username && q.cadenceHours === hours);
    if (!exists) {
      queue.push({
        username: user.username,
        templateId: cadenceConfig.followUpTemplateId || user.templateId,
        templateName: user.templateName,
        dmTemplate: followUpTemplate,
        cadenceHours: hours,
        sendAt,
        status: 'pending',
        createdAt: now
      });
    }
  }

  await chrome.storage.local.set({ cadenceQueue: queue });
  broadcastCadenceUpdate();
}

function startCadenceProcessor() {
  if (cadenceTimerId) clearInterval(cadenceTimerId);
  cadenceTimerId = setInterval(processCadenceQueue, 120000);
  setTimeout(processCadenceQueue, 10000);
}

async function processCadenceQueue() {
  const data = await chrome.storage.local.get('cadenceQueue');
  const queue = data.cadenceQueue || [];
  const now = Date.now();

  const due = queue.filter(item => item.status === 'pending' && item.sendAt <= now);
  if (!due.length) return;

  if (boState.status === 'sending' || state.status === 'sending') return;

  let tab;
  try {
    tab = await getOrCreateTab('https://www.instagram.com/', 'instagram');
    await waitForTabLoad(tab.id);
    await delay(2000);
  } catch (e) { return; }

  for (const item of due) {
    const personalizedMsg = (item.dmTemplate || '').replace(/\{\{username\}\}/gi, item.username);

    try {
      // DEDUPLICATION: Check if this specific cadence step was already sent
      const alreadySentCadence = await isCadenceAlreadySent(item.username, item.cadenceHours);
      if (alreadySentCadence) {
        item.status = 'skipped-dup';
        continue;
      }

      // Cadence DMs always go through Instagram
      await chrome.tabs.update(tab.id, { url: dmProfileUrl(item.username) });
      await waitForTabLoad(tab.id);
      await delay(3000);
      await injectContentScript(tab.id, 'instagram');
      await delay(500);

      const profileCheck = await sendToTab(tab.id, { action: 'checkProfileActions' });

      if (profileCheck && profileCheck.hasMessage) {
        const clickResult = await sendToTab(tab.id, { action: 'clickMessageButton' });
        if (clickResult && clickResult.error) throw new Error(clickResult.error);

        await delay(3000);
        await injectContentScript(tab.id, 'instagram');
        await delay(1000);

        const typeResult = await sendToTab(tab.id, { action: 'typeAndSendDM', message: personalizedMsg });
        if (typeResult && typeResult.error) throw new Error(typeResult.error);

        item.status = 'sent';

        await saveDMHistory({
          username: item.username,
          status: 'messaged',
          message: `${item.cadenceHours}h follow-up sent`,
          templateName: item.templateName,
          cadenceStep: item.cadenceHours,
          timestamp: Date.now(),
          viewed: true,
          followed: false
        });

      } else {
        item.status = 'skipped';
      }

    } catch (err) {
      item.status = 'error';
      item.errorMessage = err.message;
    }

    await delay(5000);
  }

  const updatedQueue = queue.filter(item => item.status === 'pending');
  await chrome.storage.local.set({ cadenceQueue: updatedQueue });
  broadcastCadenceUpdate();
  broadcastHistoryUpdate();
}


// ════════════════════════════════════════════════════════════
//  WAITLIST RE-CHECK (multi-platform)
// ════════════════════════════════════════════════════════════

async function runWaitlistRecheck(waitlist, platform) {
  if (!boState.tabId) {
    const tab = await getOrCreateTab(platformBaseUrl('instagram'), 'instagram');
    boState.tabId = tab.id;
    await waitForTabLoad(tab.id);
    await delay(2000);
  }

  const results = [];
  const remaining = [];

  for (let i = 0; i < waitlist.length; i++) {
    const user = waitlist[i];
    const personalizedMsg = (user.dmTemplate || '').replace(/\{\{username\}\}/gi, user.username);
    const userPlatform = user.platform || 'instagram';

    try {
      broadcastWaitlistProgress(user.username, 'checking', `Checking @${user.username}...`, i, waitlist.length, results);

      // Always check on Instagram for DM availability
      await chrome.tabs.update(boState.tabId, { url: dmProfileUrl(user.username) });
      await waitForTabLoad(boState.tabId);
      await delay(3000);
      await injectContentScript(boState.tabId, 'instagram');
      await delay(500);

      const profileCheck = await sendToTab(boState.tabId, { action: 'checkProfileActions' });

      if (profileCheck && profileCheck.hasMessage) {
        // DEDUPLICATION: Check if already messaged before sending
        const alreadySent = await isAlreadyMessaged(user.username);
        if (alreadySent) {
          broadcastWaitlistProgress(user.username, 'dm-sent', `@${user.username} already messaged — skipping`, i, waitlist.length, results);
          results.push({ username: user.username, status: 'dm-sent' });
          // Remove from waitlist since already handled
        } else {
          broadcastWaitlistProgress(user.username, 'checking', `Message button found — sending DM...`, i, waitlist.length, results);

          const clickResult = await sendToTab(boState.tabId, { action: 'clickMessageButton' });
          if (clickResult && clickResult.error) throw new Error(clickResult.error);

          await delay(3000);
          await injectContentScript(boState.tabId, 'instagram');
          await delay(1000);

          const typeResult = await sendToTab(boState.tabId, { action: 'typeAndSendDM', message: personalizedMsg });
          if (typeResult && typeResult.error) throw new Error(typeResult.error);

          broadcastWaitlistProgress(user.username, 'dm-sent', `DM sent to @${user.username}!`, i, waitlist.length, results);
          results.push({ username: user.username, status: 'dm-sent' });

          await saveDMHistory({
            username: user.username,
            status: 'messaged',
            message: `DM sent (waitlist re-check, ${user.templateName})`,
            templateName: user.templateName,
            timestamp: Date.now(),
            viewed: true,
            followed: true,
            platform: userPlatform
          });
        }

      } else {
        broadcastWaitlistProgress(user.username, 'still-waiting', `@${user.username} — still no Message button`, i, waitlist.length, results);
        results.push({ username: user.username, status: 'still-waiting' });
        remaining.push(user);
      }

    } catch (err) {
      broadcastWaitlistProgress(user.username, 'error', `@${user.username}: ${err.message}`, i, waitlist.length, results);
      results.push({ username: user.username, status: 'error' });
      remaining.push(user);
    }

    if (i < waitlist.length - 1) await delay(5000);
  }

  await chrome.storage.local.set({ boWaitlist: remaining });
  broadcastWaitlistProgress('', 'done', 'Re-check complete', waitlist.length, waitlist.length, results);
}


// ════════════════════════════════════════════════════════════
//  HELPERS (multi-platform)
// ════════════════════════════════════════════════════════════

async function getOrCreateTab(url, platform) {
  const queryPattern = platformTabQuery(platform);
  const tabs = await chrome.tabs.query({ url: queryPattern });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true, url });
    return tabs[0];
  }
  return chrome.tabs.create({ url });
}

function waitForTabLoad(tabId, timeout = 20000) {
  return new Promise((resolve) => {
    const start = Date.now();
    function listener(tid, info) {
      if (tid === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, timeout);
  });
}

async function injectContentScript(tabId, platform) {
  const scriptFile = contentScriptFile(platform || 'instagram');
  try { await chrome.scripting.executeScript({ target: { tabId }, files: [scriptFile] }); } catch (e) { console.warn('Inject failed:', e.message); }
  try { await chrome.scripting.insertCSS({ target: { tabId }, files: ['css/overlay.css'] }); } catch (e) {}
}

async function sendToTab(tabId, msg, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e) {
      if (i < retries - 1) { await delay(1500); await injectContentScript(tabId); await delay(500); }
      else throw e;
    }
  }
}

function broadcastProgress(data) {
  chrome.runtime.sendMessage({ action: 'progressUpdate', ...data }).catch(() => {});
}

function broadcastDMProgress(username, substep, detail) {
  chrome.runtime.sendMessage({
    action: 'dmProgressUpdate', username, substep, detail,
    currentIndex: state.currentIndex, total: state.selectedUsers?.length || 0, sentLog: state.sentLog
  }).catch(() => {});
}

function broadcastBOProgress(username, substep, detail) {
  chrome.runtime.sendMessage({
    action: 'boProgressUpdate', username, substep, detail,
    currentIndex: boState.currentIndex, total: boState.outreachList?.length || 0, sentLog: boState.sentLog
  }).catch(() => {});
}

function broadcastWaitlistProgress(username, substep, detail, currentIndex, total, results) {
  chrome.runtime.sendMessage({
    action: 'waitlistCheckUpdate', username, substep, detail, currentIndex, total, results
  }).catch(() => {});
}

function broadcastCadenceUpdate() {
  chrome.runtime.sendMessage({ action: 'cadenceUpdate' }).catch(() => {});
}

function broadcastHistoryUpdate() {
  chrome.runtime.sendMessage({ action: 'historyUpdate' }).catch(() => {});
}

/** Cancellable delay — resolves early if shouldCancel returns true */
function delay(ms, checkCancel = false, shouldCancel = null) {
  if (!checkCancel || !shouldCancel) return new Promise(r => setTimeout(r, ms));
  return new Promise(async (resolve) => {
    const chunks = Math.ceil(ms / 500);
    for (let i = 0; i < chunks; i++) {
      await new Promise(r => setTimeout(r, Math.min(500, ms - i * 500)));
      if (shouldCancel()) { resolve(); return; }
    }
    resolve();
  });
}

async function saveDMHistory(entry) {
  const data = await chrome.storage.local.get('dmHistory');
  const history = data.dmHistory || [];

  const existingIdx = history.findIndex(h => h.username === entry.username && !h.cadenceStep);
  if (existingIdx >= 0 && !entry.cadenceStep) {
    const existing = history[existingIdx];
    history[existingIdx] = {
      ...existing,
      ...entry,
      viewed: existing.viewed || entry.viewed,
      followed: existing.followed || entry.followed,
      timestamp: entry.timestamp
    };
  } else {
    history.unshift(entry);
  }

  if (history.length > 500) history.length = 500;
  await chrome.storage.local.set({ dmHistory: history });
}

async function savePendingFollow(entry) {
  const data = await chrome.storage.local.get('pendingFollows');
  const pending = data.pendingFollows || [];
  if (!pending.some(p => p.username === entry.username)) {
    pending.push(entry);
    await chrome.storage.local.set({ pendingFollows: pending });
  }
}

async function saveToWaitlist(entry) {
  const data = await chrome.storage.local.get('boWaitlist');
  const waitlist = data.boWaitlist || [];
  if (!waitlist.some(w => w.username === entry.username)) {
    waitlist.push(entry);
    await chrome.storage.local.set({ boWaitlist: waitlist });
  }
}

/**
 * DEDUPLICATION: Check if a user has already been successfully messaged.
 * Returns true if dmHistory contains a 'messaged' entry for this username
 * (excluding cadence steps, which are separate follow-ups).
 */
async function isAlreadyMessaged(username) {
  const data = await chrome.storage.local.get('dmHistory');
  const history = data.dmHistory || [];
  return history.some(h =>
    h.username === username &&
    h.status === 'messaged' &&
    !h.cadenceStep
  );
}

/**
 * DEDUPLICATION: Check if a specific cadence step was already sent to a user.
 * Returns true if dmHistory contains a 'messaged' entry for this username
 * with the matching cadenceStep value.
 */
async function isCadenceAlreadySent(username, cadenceHours) {
  const data = await chrome.storage.local.get('dmHistory');
  const history = data.dmHistory || [];
  return history.some(h =>
    h.username === username &&
    h.status === 'messaged' &&
    h.cadenceStep === cadenceHours
  );
}
