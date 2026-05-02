/**
 * Background Service Worker (v10) — Multi-Platform
 *
 * THE ORCHESTRATOR — drives all navigation and content-script injection.
 * Supports Instagram, Threads, LinkedIn, and X (Twitter).
 *
 * Two modes:
 *   1. Bulk Outreach (primary) — handle list, follow/DM, waitlist, cadence
 *   2. Keyword Scan — scan post comments, send DMs
 *
 * Platform routing:
 *   - Instagram: instagram.com profiles, DMs via Message button
 *   - Threads: threads.net profiles for follow, but DMs redirect to Instagram
 *   - LinkedIn: linkedin.com/in/ profiles, Connect + Message, connection note as DM
 *   - X (Twitter): x.com profiles, Follow + DM, tweet reply fallback for closed DMs
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
  behaviorSettings: {
    alwaysFollow: true,
    dmAfterFollow: true,
    waitlistPrivate: true,
    skipPrivate: false,
    xReplyFallback: true,
    linkedinConnectNote: true
  }
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
  switch (platform) {
    case 'threads': return `https://www.threads.net/@${username}`;
    case 'linkedin': return `https://www.linkedin.com/in/${username}/`;
    case 'x': return `https://x.com/${username}`;
    default: return `https://www.instagram.com/${username}/`;
  }
}

function platformBaseUrl(platform) {
  switch (platform) {
    case 'threads': return 'https://www.threads.net/';
    case 'linkedin': return 'https://www.linkedin.com/';
    case 'x': return 'https://x.com/';
    default: return 'https://www.instagram.com/';
  }
}

function platformTabQuery(platform) {
  switch (platform) {
    case 'threads': return 'https://www.threads.net/*';
    case 'linkedin': return 'https://www.linkedin.com/*';
    case 'x': return 'https://x.com/*';
    default: return 'https://www.instagram.com/*';
  }
}

function contentScriptFile(platform) {
  switch (platform) {
    case 'threads': return 'js/threads-content.js';
    case 'linkedin': return 'js/linkedin-content.js';
    case 'x': return 'js/x-content.js';
    default: return 'js/content.js';
  }
}

// For DMs: each platform uses its own messaging except Threads (redirects to Instagram)
function dmProfileUrl(username, platform) {
  switch (platform) {
    case 'linkedin': return `https://www.linkedin.com/in/${username}/`;
    case 'x': return `https://x.com/${username}`;
    default: return `https://www.instagram.com/${username}/`;
  }
}

// Platform-specific "connect" action name
function connectActionName(platform) {
  switch (platform) {
    case 'linkedin': return 'clickConnectButton';
    default: return 'clickFollowButton';
  }
}

// ─── LinkedIn: Get display name from profile page (with retry + fallbacks) ───
async function getLinkedInDisplayName(tabId, usernameSlug) {
  let displayName = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const profileInfo = await sendToTab(tabId, { action: 'getProfileInfo' });
    if (profileInfo?.fullName) {
      displayName = profileInfo.fullName;
      break;
    }
    // Re-inject content script and retry after a longer wait
    await delay(2000);
    await injectContentScript(tabId, 'linkedin');
    await delay(1000);
  }
  // Final fallback: derive from username/URL slug ("amanda-cua" → "Amanda Cua")
  if (!displayName && usernameSlug) {
    displayName = usernameSlug
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }
  return displayName;
}

// ─── LinkedIn: Send DM via compose page (bypasses unreliable overlay) ───
// Reusable helper used by runDMLoop, runBulkOutreachLoop, waitlist recheck, cadence
async function linkedinComposeDM(tabId, displayName, message, progressFn) {
  if (!displayName) throw new Error('No display name for LinkedIn compose DM');

  // Navigate to compose page
  if (progressFn) progressFn('Opening messaging compose page...');
  await chrome.tabs.update(tabId, { url: 'https://www.linkedin.com/messaging/thread/new/' });
  await waitForTabLoad(tabId);
  await delay(2000);
  await injectContentScript(tabId, 'linkedin');
  await delay(1000);

  // Search for the recipient by display name
  if (progressFn) progressFn(`Searching for ${displayName}...`);
  const searchResult = await sendToTab(tabId, { action: 'searchAndSelectRecipient', displayName });
  if (searchResult && searchResult.error) throw new Error(searchResult.error);

  // Type and send the message
  if (progressFn) progressFn('Typing message...');
  await delay(1000);
  const typeResult = await sendToTab(tabId, { action: 'typeAndSendDM', message });
  if (typeResult && typeResult.error) throw new Error(typeResult.error);
  return typeResult;
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
    else if (msg.postUrl.includes('linkedin.com')) state.platform = 'linkedin';
    else if (msg.postUrl.includes('x.com') || msg.postUrl.includes('twitter.com')) state.platform = 'x';

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

      // Navigate to profile for DMs on the appropriate platform
      const dmPlatform = (state.platform === 'threads') ? 'instagram' : state.platform;
      state.currentDMStep = 'navigating';
      broadcastDMProgress(user.username, 'navigating', `Opening @${user.username}'s profile...`);
      await chrome.tabs.update(state.tabId, { url: dmProfileUrl(user.username, dmPlatform) });
      await waitForTabLoad(state.tabId);
      await delay(3000);

      state.currentDMStep = 'clickingMessage';
      broadcastDMProgress(user.username, 'clickingMessage', 'Finding and clicking "Message" button...');
      await injectContentScript(state.tabId, dmPlatform);
      await delay(500);

      // X-specific: check DM availability first, fallback to reply
      if (dmPlatform === 'x') {
        const dmAvail = await sendToTab(state.tabId, { action: 'checkDMAvailability' });
        if (dmAvail && !dmAvail.canDM && settings.xReplyFallback !== false) {
          // DMs closed — use tweet reply as fallback (xReplyFallback enabled)
          // B1 FIX: Must navigate to user's latest tweet first (reply input only exists on tweet pages)
          state.currentDMStep = 'replying';
          broadcastDMProgress(user.username, 'replying', 'DMs closed — finding latest tweet for reply...');

          // Find the user's latest tweet URL from their profile
          const tweetUrlResult = await sendToTab(state.tabId, { action: 'findLatestTweetUrl' });
          if (!tweetUrlResult || !tweetUrlResult.url) {
            throw new Error('DMs closed and no tweets found to reply to');
          }

          // Navigate to the tweet page
          await chrome.tabs.update(state.tabId, { url: tweetUrlResult.url });
          await waitForTabLoad(state.tabId);
          await delay(3000);
          await injectContentScript(state.tabId, 'x');
          await delay(1000);

          broadcastDMProgress(user.username, 'replying', 'Sending tweet reply...');
          const replyResult = await sendToTab(state.tabId, { action: 'typeAndSendReply', message: personalizedMsg });
          if (replyResult && replyResult.error) throw new Error(replyResult.error);
          state.currentDMStep = 'done';
          broadcastDMProgress(user.username, 'done', 'Reply sent (DMs closed)!');
          const logEntry = { username: user.username, status: 'replied', message: 'Tweet reply sent (DMs closed)', timestamp: Date.now(), viewed: true, followed: false, platform: state.platform };
          state.sentLog.push(logEntry);
          await saveDMHistory(logEntry);
          state.currentIndex++;
          if (state.status === 'sending' && state.currentIndex < state.selectedUsers.length) {
            broadcastDMProgress('', 'waiting', `Waiting ${state.delaySeconds}s before next DM...`);
            await delay(state.delaySeconds * 1000, true, () => state.status !== 'sending');
          }
          continue;
        }
      }

      // ── LINKEDIN: Compose-page approach (bypasses unreliable overlay) ──
      if (dmPlatform === 'linkedin') {
        // Step 1: Get display name from profile page (with retry + fallbacks)
        broadcastDMProgress(user.username, 'clickingMessage', 'Reading profile name...');
        const displayName = await getLinkedInDisplayName(state.tabId, user.username);
        if (!displayName) {
          throw new Error('Could not read display name from LinkedIn profile');
        }

        // Step 2: Check if Message button exists (without clicking it)
        const profileCheck = await sendToTab(state.tabId, { action: 'checkProfileActions' });

        if (!profileCheck || !profileCheck.hasMessage) {
          // No Message button — fall back to Connect with note
          state.currentDMStep = 'following';
          broadcastDMProgress(user.username, 'following', 'No Message button — sending connection request with note...');
          await delay(500);
          const connectResult = await sendToTab(state.tabId, { action: 'clickConnectButton', note: personalizedMsg });
          if (connectResult && connectResult.error) {
            const statusMsg = `@${user.username} — could not connect: ${connectResult.error}`;
            broadcastDMProgress(user.username, 'error', statusMsg);
            const logEntry = { username: user.username, status: 'error', message: statusMsg, timestamp: Date.now(), viewed: true, followed: false, platform: state.platform };
            state.sentLog.push(logEntry);
            await saveDMHistory(logEntry);
            state.currentIndex++;
            if (state.status === 'sending' && state.currentIndex < state.selectedUsers.length) {
              broadcastDMProgress('', 'waiting', `Waiting ${state.delaySeconds}s before next user...`);
              await delay(state.delaySeconds * 1000, true, () => state.status !== 'sending');
            }
            continue;
          }
          const statusMsg = connectResult?.status === 'Pending'
            ? `Connection request sent to @${user.username} with personalized note`
            : `Connected with @${user.username} — note sent`;
          broadcastDMProgress(user.username, 'done', statusMsg);
          const logEntry = { username: user.username, status: 'messaged', message: statusMsg, timestamp: Date.now(), viewed: true, followed: true, platform: state.platform };
          state.sentLog.push(logEntry);
          await saveDMHistory(logEntry);
          state.currentIndex++;
          if (state.status === 'sending' && state.currentIndex < state.selectedUsers.length) {
            broadcastDMProgress('', 'waiting', `Waiting ${state.delaySeconds}s before next user...`);
            await delay(state.delaySeconds * 1000, true, () => state.status !== 'sending');
          }
          continue;
        }

        // Step 3: Message button exists — use compose page approach
        state.currentDMStep = 'waitingDM';
        await linkedinComposeDM(state.tabId, displayName, personalizedMsg, (msg) => {
          broadcastDMProgress(user.username, 'waitingDM', msg);
        });
        state.currentDMStep = 'typing';

      } else {
        // ── NON-LINKEDIN: Original overlay approach ──
        const clickResult = await sendToTab(state.tabId, { action: 'clickMessageButton' });

        if (clickResult && clickResult.error && clickResult.noMessage) {
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
        await injectContentScript(state.tabId, dmPlatform);
        await delay(1000);

        state.currentDMStep = 'typing';
        broadcastDMProgress(user.username, 'typing', 'Typing message...');
        const typeResult = await sendToTab(state.tabId, { action: 'typeAndSendDM', message: personalizedMsg });
        if (typeResult && typeResult.error) throw new Error(typeResult.error);
      }

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

        // X-specific: even if Message button is visible, verify DM is actually open
        if (platform === 'x') {
          const dmAvailCheck = await sendToTab(boState.tabId, { action: 'checkDMAvailability' });
          if (dmAvailCheck && !dmAvailCheck.canDM && settings.xReplyFallback !== false) {
            // DMs closed despite button presence — use tweet reply fallback (xReplyFallback enabled)
            // B1 FIX: Navigate to user's latest tweet first
            broadcastBOProgress(user.username, 'replying', 'DMs closed — finding latest tweet for reply...');
            const tweetUrlResult = await sendToTab(boState.tabId, { action: 'findLatestTweetUrl' });
            if (!tweetUrlResult || !tweetUrlResult.url) {
              throw new Error('DMs closed and no tweets found to reply to');
            }
            await chrome.tabs.update(boState.tabId, { url: tweetUrlResult.url });
            await waitForTabLoad(boState.tabId);
            await delay(3000);
            await injectContentScript(boState.tabId, 'x');
            await delay(1000);
            broadcastBOProgress(user.username, 'replying', 'Sending tweet reply...');
            const replyResult = await sendToTab(boState.tabId, { action: 'typeAndSendReply', message: personalizedMsg });
            if (replyResult && replyResult.error) throw new Error(replyResult.error);
            const doneMsg = didFollow ? 'Followed & reply sent (DMs closed)!' : 'Reply sent (DMs closed)!';
            broadcastBOProgress(user.username, 'done', doneMsg);
            boState.sentLog.push({ username: user.username, status: 'success', message: doneMsg, timestamp: Date.now() });
            await saveDMHistory({
              username: user.username, status: 'replied',
              message: `${didFollow ? 'Followed & ' : ''}Reply sent (DMs closed) (${user.templateName})`,
              templateName: user.templateName, timestamp: Date.now(), viewed: true, followed: didFollow, platform
            });
            if (boState.cadenceConfig && boState.cadenceConfig.intervals && boState.cadenceConfig.intervals.length > 0) {
              await scheduleCadenceFollowUps(user, boState.cadenceConfig);
            }
            boState.currentIndex++;
            if (boState.status === 'sending' && boState.currentIndex < boState.outreachList.length) {
              broadcastBOProgress('', 'waiting', `Waiting ${boState.delaySeconds}s before next user...`);
              await delay(boState.delaySeconds * 1000, true, () => boState.status !== 'sending');
            }
            continue;
          }
        }

        // Platform-specific DM routing
        const dmPlatformBO = (platform === 'threads') ? 'instagram' : platform;
        let typeResult;
        if (platform === 'linkedin') {
          // LinkedIn: compose-page approach (bypasses unreliable overlay)
          broadcastBOProgress(user.username, 'dm-direct', 'Reading profile name...');
          const displayName = await getLinkedInDisplayName(boState.tabId, user.username);
          if (!displayName) throw new Error('Could not read display name from LinkedIn profile');

          typeResult = await linkedinComposeDM(boState.tabId, displayName, personalizedMsg, (msg) => {
            broadcastBOProgress(user.username, 'dm-direct', msg);
          });
        } else if (platform === 'threads') {
          broadcastBOProgress(user.username, 'dm-direct', 'Message available — redirecting to Instagram for DM...');
          await chrome.tabs.update(boState.tabId, { url: dmProfileUrl(user.username, 'instagram') });
          await waitForTabLoad(boState.tabId);
          await delay(3000);
          await injectContentScript(boState.tabId, 'instagram');
          await delay(500);
          const igClickResult = await sendToTab(boState.tabId, { action: 'clickMessageButton' });
          if (igClickResult && igClickResult.error) throw new Error(igClickResult.error);

          await delay(3000);
          await injectContentScript(boState.tabId, 'instagram');
          await delay(1000);
          broadcastBOProgress(user.username, 'typing', 'Typing message...');
          typeResult = await sendToTab(boState.tabId, { action: 'typeAndSendDM', message: personalizedMsg });
          if (typeResult && typeResult.error) throw new Error(typeResult.error);
        } else {
          broadcastBOProgress(user.username, 'dm-direct', 'Message button found — clicking...');
          const clickResult = await sendToTab(boState.tabId, { action: 'clickMessageButton' });
          if (clickResult && clickResult.error) throw new Error(clickResult.error);

          await delay(3000);
          await injectContentScript(boState.tabId, dmPlatformBO);
          await delay(1000);
          broadcastBOProgress(user.username, 'typing', 'Typing message...');
          typeResult = await sendToTab(boState.tabId, { action: 'typeAndSendDM', message: personalizedMsg });
          if (typeResult && typeResult.error) throw new Error(typeResult.error);
        }

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
        // ── No Message button — need to Follow/Connect first ──
        const connectAction = connectActionName(platform);
        const actionLabel = platform === 'linkedin' ? 'Connecting' : 'Following';
        broadcastBOProgress(user.username, 'following', `No Message button — ${actionLabel.toLowerCase()}...`);

        // For LinkedIn: send connection request with note (the DM message as connection note)
        const connectPayload = platform === 'linkedin'
          ? { action: connectAction, note: personalizedMsg }
          : { action: connectAction };
        const followResult = await sendToTab(boState.tabId, connectPayload);

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

        if (followStatus === 'Requested' || followStatus === 'Pending') {
          // ── Private account or pending connection ──
          const actionWord = platform === 'linkedin' ? 'Connection' : 'Follow';
          if (settings.waitlistPrivate) {
            // Setting: Waitlist private/pending accounts
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

            const statusMsg = `${actionWord} requested @${user.username} — added to waitlist (pending approval)`;
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

          // Platform-specific DM routing after follow
          const dmPlatAfterFollow = (platform === 'threads') ? 'instagram' : platform;
          if (platform === 'threads') {
            broadcastBOProgress(user.username, 'dm-direct', 'Followed on Threads — redirecting to Instagram for DM...');
            await chrome.tabs.update(boState.tabId, { url: dmProfileUrl(user.username, 'instagram') });
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
            if (platform === 'linkedin') {
              // LinkedIn: use compose-page approach
              const displayName = await getLinkedInDisplayName(boState.tabId, user.username);
              if (!displayName) throw new Error('Could not read display name from LinkedIn profile');
              const typeResult = await linkedinComposeDM(boState.tabId, displayName, personalizedMsg, (msg) => {
                broadcastBOProgress(user.username, 'dm-direct', msg);
              });
              if (typeResult && typeResult.warning) {
                broadcastBOProgress(user.username, 'done-warning', `Followed & DM sent (unverified) — ${typeResult.warning}`);
                boState.sentLog.push({ username: user.username, status: 'success', message: 'Followed & DM sent (unverified)', timestamp: Date.now() });
              } else {
                broadcastBOProgress(user.username, 'done', `Followed & DM sent to @${user.username}!`);
                boState.sentLog.push({ username: user.username, status: 'success', message: 'Followed & DM sent', timestamp: Date.now() });
                recordHealthResult(true);
              }
            } else {
              broadcastBOProgress(user.username, 'dm-direct', 'Message button appeared — clicking...');
              const clickResult = await sendToTab(boState.tabId, { action: 'clickMessageButton' });
              if (clickResult && clickResult.error) throw new Error(clickResult.error);

              await delay(3000);
              await injectContentScript(boState.tabId, dmPlatAfterFollow);
              await delay(1000);

              // X-specific: if DMs closed after following, try tweet reply
              if (platform === 'x') {
                const dmAvailAfterFollow = await sendToTab(boState.tabId, { action: 'checkDMAvailability' });
                if (dmAvailAfterFollow && !dmAvailAfterFollow.canDM && settings.xReplyFallback !== false) {
                  broadcastBOProgress(user.username, 'replying', 'DMs closed — finding latest tweet for reply...');
                  const tweetUrlResult2 = await sendToTab(boState.tabId, { action: 'findLatestTweetUrl' });
                  if (!tweetUrlResult2 || !tweetUrlResult2.url) {
                    throw new Error('DMs closed and no tweets found to reply to');
                  }
                  await chrome.tabs.update(boState.tabId, { url: tweetUrlResult2.url });
                  await waitForTabLoad(boState.tabId);
                  await delay(3000);
                  await injectContentScript(boState.tabId, 'x');
                  await delay(1000);
                  broadcastBOProgress(user.username, 'replying', 'Sending tweet reply...');
                  const replyResult = await sendToTab(boState.tabId, { action: 'typeAndSendReply', message: personalizedMsg });
                  if (replyResult && replyResult.error) throw new Error(replyResult.error);
                  broadcastBOProgress(user.username, 'done', 'Followed & reply sent (DMs closed)!');
                  boState.sentLog.push({ username: user.username, status: 'success', message: 'Followed & reply sent (DMs closed)', timestamp: Date.now() });
                  await saveDMHistory({
                    username: user.username, status: 'replied', message: `Followed & reply sent (DMs closed) (${user.templateName})`,
                    templateName: user.templateName, timestamp: Date.now(), viewed: true, followed: true, platform
                  });
                  if (boState.cadenceConfig && boState.cadenceConfig.intervals && boState.cadenceConfig.intervals.length > 0) {
                    await scheduleCadenceFollowUps(user, boState.cadenceConfig);
                  }
                  boState.currentIndex++;
                  if (boState.status === 'sending' && boState.currentIndex < boState.outreachList.length) {
                    broadcastBOProgress('', 'waiting', `Waiting ${boState.delaySeconds}s before next user...`);
                    await delay(boState.delaySeconds * 1000, true, () => boState.status !== 'sending');
                  }
                  continue;
                }
              }

              broadcastBOProgress(user.username, 'typing', 'Typing message...');
              const typeResult = await sendToTab(boState.tabId, { action: 'typeAndSendDM', message: personalizedMsg });
              if (typeResult && typeResult.error) throw new Error(typeResult.error);

              if (typeResult && typeResult.warning) {
                broadcastBOProgress(user.username, 'done-warning', `Followed & DM sent (unverified) — ${typeResult.warning}`);
                boState.sentLog.push({ username: user.username, status: 'success', message: 'Followed & DM sent (unverified)', timestamp: Date.now() });
              } else {
                broadcastBOProgress(user.username, 'done', `Followed & DM sent to @${user.username}!`);
                boState.sentLog.push({ username: user.username, status: 'success', message: 'Followed & DM sent', timestamp: Date.now() });
                recordHealthResult(true);
              }
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
      // On any error: skip this user, add to waitlist, continue to next
      const errMsg = `Error with @${user.username}: ${err.message} — skipped, added to waitlist`;
      broadcastBOProgress(user.username, 'error', errMsg);
      boState.sentLog.push({ username: user.username, status: 'error', message: err.message, timestamp: Date.now() });

      // Add failed user to waitlist so they can be retried later
      await saveToWaitlist({
        username: user.username,
        templateId: user.templateId,
        templateName: user.templateName,
        dmTemplate: user.dmTemplate,
        followStatus: 'Error',
        alreadyFollowing: false,
        timestamp: new Date().toISOString(),
        platform
      });

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

    // No auto-pause — always continue to next user

    if (boState.status === 'sending' && boState.currentIndex < boState.outreachList.length) {
      const totalDelay = boState.delaySeconds * 1000;
      broadcastBOProgress('', 'waiting', `Waiting ${boState.delaySeconds}s before next user...`);
      await delay(totalDelay, true, () => boState.status !== 'sending');
    }
  }

  if (boState.currentIndex >= boState.outreachList.length) {
    boState.status = 'done';
    const dmSent = boState.sentLog.filter(l => l.status === 'success').length;
    const waitlisted = boState.sentLog.filter(l => l.status === 'waitlisted').length;
    const failed = boState.sentLog.filter(l => l.status === 'error').length;
    const skipped = boState.sentLog.filter(l => l.status === 'skipped' || l.status === 'skipped-dup').length;
    let summary = `All done! ${dmSent} DMs sent.`;
    if (waitlisted > 0) summary += ` ${waitlisted} waitlisted.`;
    if (failed > 0) summary += ` ${failed} failed (added to waitlist for retry).`;
    if (skipped > 0) summary += ` ${skipped} skipped.`;
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
        createdAt: now,
        platform: boState.platform || 'instagram'
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

  // Determine platform from the first due item (cadence items store platform)
  const cadencePlatform = due[0]?.platform || boState.platform || 'instagram';
  const cadenceDMPlat = (cadencePlatform === 'threads') ? 'instagram' : cadencePlatform;

  let tab;
  try {
    tab = await getOrCreateTab(platformBaseUrl(cadenceDMPlat), cadenceDMPlat);
    await waitForTabLoad(tab.id);
    await delay(2000);
  } catch (e) { return; }

  for (const item of due) {
    const personalizedMsg = (item.dmTemplate || '').replace(/\{\{username\}\}/gi, item.username);
    const itemPlatform = item.platform || cadenceDMPlat;
    const itemDMPlat = (itemPlatform === 'threads') ? 'instagram' : itemPlatform;

    try {
      // DEDUPLICATION: Check if this specific cadence step was already sent
      const alreadySentCadence = await isCadenceAlreadySent(item.username, item.cadenceHours);
      if (alreadySentCadence) {
        item.status = 'skipped-dup';
        continue;
      }

      // Navigate to profile on the appropriate platform
      await chrome.tabs.update(tab.id, { url: dmProfileUrl(item.username, itemDMPlat) });
      await waitForTabLoad(tab.id);
      await delay(3000);
      await injectContentScript(tab.id, itemDMPlat);
      await delay(500);

      const profileCheck = await sendToTab(tab.id, { action: 'checkProfileActions' });

      if (profileCheck && profileCheck.hasMessage) {
        if (itemDMPlat === 'linkedin') {
          // LinkedIn: compose-page approach
          const displayName = await getLinkedInDisplayName(tab.id, item.username);
          if (!displayName) throw new Error('Could not read display name from LinkedIn profile');
          await linkedinComposeDM(tab.id, displayName, personalizedMsg);
        } else {
          const clickResult = await sendToTab(tab.id, { action: 'clickMessageButton' });
          if (clickResult && clickResult.error) throw new Error(clickResult.error);

          await delay(3000);
          await injectContentScript(tab.id, itemDMPlat);
          await delay(1000);

          const typeResult = await sendToTab(tab.id, { action: 'typeAndSendDM', message: personalizedMsg });
          if (typeResult && typeResult.error) throw new Error(typeResult.error);
        }

        item.status = 'sent';

        await saveDMHistory({
          username: item.username,
          status: 'messaged',
          message: `${item.cadenceHours}h follow-up sent`,
          templateName: item.templateName,
          cadenceStep: item.cadenceHours,
          timestamp: Date.now(),
          viewed: true,
          followed: false,
          platform: itemPlatform
        });

      } else if (itemDMPlat === 'linkedin') {
        // LinkedIn cadence: try Connect with note if not connected
        const connectResult = await sendToTab(tab.id, { action: 'clickConnectButton', note: personalizedMsg });
        if (connectResult && !connectResult.error) {
          item.status = 'sent';
          await saveDMHistory({
            username: item.username, status: 'messaged',
            message: `${item.cadenceHours}h follow-up (connection note)`,
            templateName: item.templateName, cadenceStep: item.cadenceHours,
            timestamp: Date.now(), viewed: true, followed: true, platform: itemPlatform
          });
        } else {
          item.status = 'skipped';
        }
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
    const tab = await getOrCreateTab(platformBaseUrl(platform), platform);
    boState.tabId = tab.id;
    await waitForTabLoad(tab.id);
    await delay(2000);
  }

  const results = [];
  const remaining = [];

  for (let i = 0; i < waitlist.length; i++) {
    const user = waitlist[i];
    const personalizedMsg = (user.dmTemplate || '').replace(/\{\{username\}\}/gi, user.username);
    const userPlatform = user.platform || platform || 'instagram';
    // For Threads, DMs go through Instagram
    const dmPlat = (userPlatform === 'threads') ? 'instagram' : userPlatform;

    try {
      broadcastWaitlistProgress(user.username, 'checking', `Checking @${user.username}...`, i, waitlist.length, results);

      // Navigate to user's profile on their platform
      await chrome.tabs.update(boState.tabId, { url: dmProfileUrl(user.username, dmPlat) });
      await waitForTabLoad(boState.tabId);
      await delay(3000);
      await injectContentScript(boState.tabId, dmPlat);
      await delay(500);

      const profileCheck = await sendToTab(boState.tabId, { action: 'checkProfileActions' });

      if (profileCheck && profileCheck.hasMessage) {
        // DEDUPLICATION: Check if already messaged before sending
        const alreadySent = await isAlreadyMessaged(user.username);
        if (alreadySent) {
          broadcastWaitlistProgress(user.username, 'dm-sent', `@${user.username} already messaged — skipping`, i, waitlist.length, results);
          results.push({ username: user.username, status: 'dm-sent' });
        } else {
          broadcastWaitlistProgress(user.username, 'checking', `Message button found — sending DM...`, i, waitlist.length, results);

          if (dmPlat === 'linkedin') {
            // LinkedIn: compose-page approach
            const displayName = await getLinkedInDisplayName(boState.tabId, user.username);
            if (!displayName) throw new Error('Could not read display name from LinkedIn profile');
            await linkedinComposeDM(boState.tabId, displayName, personalizedMsg);
          } else {
            const clickResult = await sendToTab(boState.tabId, { action: 'clickMessageButton' });
            if (clickResult && clickResult.error) throw new Error(clickResult.error);

            await delay(3000);
            await injectContentScript(boState.tabId, dmPlat);
            await delay(1000);

            const typeResult = await sendToTab(boState.tabId, { action: 'typeAndSendDM', message: personalizedMsg });
            if (typeResult && typeResult.error) throw new Error(typeResult.error);
          }

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

      } else if (dmPlat === 'linkedin' && profileCheck && !profileCheck.isConnected) {
        // LinkedIn: if not connected yet, try Connect with note
        broadcastWaitlistProgress(user.username, 'checking', `Not connected — sending connection request...`, i, waitlist.length, results);
        const connectResult = await sendToTab(boState.tabId, { action: 'clickConnectButton', note: personalizedMsg });
        if (connectResult && !connectResult.error) {
          broadcastWaitlistProgress(user.username, 'dm-sent', `Connection request sent to @${user.username}!`, i, waitlist.length, results);
          results.push({ username: user.username, status: 'dm-sent' });
          await saveDMHistory({
            username: user.username, status: 'messaged',
            message: `Connection request with note (waitlist re-check, ${user.templateName})`,
            templateName: user.templateName, timestamp: Date.now(),
            viewed: true, followed: true, platform: userPlatform
          });
        } else {
          broadcastWaitlistProgress(user.username, 'still-waiting', `@${user.username} — could not connect`, i, waitlist.length, results);
          results.push({ username: user.username, status: 'still-waiting' });
          remaining.push(user);
        }

      } else if (dmPlat === 'x') {
        // X: check DM availability, fallback to tweet reply
        const dmAvail = await sendToTab(boState.tabId, { action: 'checkDMAvailability' });
        if (dmAvail && dmAvail.canDM) {
          broadcastWaitlistProgress(user.username, 'checking', `DMs open — sending DM...`, i, waitlist.length, results);
          const clickResult = await sendToTab(boState.tabId, { action: 'clickMessageButton' });
          if (clickResult && clickResult.error) throw new Error(clickResult.error);
          await delay(3000);
          await injectContentScript(boState.tabId, 'x');
          await delay(1000);
          const typeResult = await sendToTab(boState.tabId, { action: 'typeAndSendDM', message: personalizedMsg });
          if (typeResult && typeResult.error) throw new Error(typeResult.error);
          broadcastWaitlistProgress(user.username, 'dm-sent', `DM sent to @${user.username}!`, i, waitlist.length, results);
          results.push({ username: user.username, status: 'dm-sent' });
          await saveDMHistory({
            username: user.username, status: 'messaged',
            message: `DM sent (waitlist re-check, ${user.templateName})`,
            templateName: user.templateName, timestamp: Date.now(),
            viewed: true, followed: true, platform: userPlatform
          });
        } else {
          // Try tweet reply fallback
          const tweetUrlResult = await sendToTab(boState.tabId, { action: 'findLatestTweetUrl' });
          if (tweetUrlResult && tweetUrlResult.url) {
            await chrome.tabs.update(boState.tabId, { url: tweetUrlResult.url });
            await waitForTabLoad(boState.tabId);
            await delay(3000);
            await injectContentScript(boState.tabId, 'x');
            await delay(1000);
            const replyResult = await sendToTab(boState.tabId, { action: 'typeAndSendReply', message: personalizedMsg });
            if (replyResult && !replyResult.error) {
              broadcastWaitlistProgress(user.username, 'dm-sent', `Reply sent to @${user.username} (DMs closed)!`, i, waitlist.length, results);
              results.push({ username: user.username, status: 'dm-sent' });
              await saveDMHistory({
                username: user.username, status: 'replied',
                message: `Tweet reply sent (waitlist re-check, ${user.templateName})`,
                templateName: user.templateName, timestamp: Date.now(),
                viewed: true, followed: true, platform: userPlatform
              });
            } else {
              remaining.push(user);
              results.push({ username: user.username, status: 'still-waiting' });
            }
          } else {
            broadcastWaitlistProgress(user.username, 'still-waiting', `@${user.username} — DMs closed, no tweets to reply`, i, waitlist.length, results);
            results.push({ username: user.username, status: 'still-waiting' });
            remaining.push(user);
          }
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
      if (i < retries - 1) {
        await delay(1500);
        // Detect platform from tab URL so we inject the correct content script
        let retryPlatform = 'instagram';
        try {
          const tab = await chrome.tabs.get(tabId);
          const url = tab.url || '';
          if (url.includes('linkedin.com')) retryPlatform = 'linkedin';
          else if (url.includes('x.com') || url.includes('twitter.com')) retryPlatform = 'x';
          else if (url.includes('threads.net')) retryPlatform = 'threads';
        } catch (_) {}
        await injectContentScript(tabId, retryPlatform);
        await delay(500);
      }
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
