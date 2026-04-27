/**
 * Background Service Worker (v4)
 *
 * THE ORCHESTRATOR — drives all navigation and content-script injection.
 *
 * Two modes:
 *   1. Keyword Scan — scan post comments, send DMs
 *   2. Bulk Outreach — handle list, follow/DM, waitlist
 */

// ─── State: Keyword Scan ───
let state = {
  status: 'idle',  // idle | scanning | reviewing | sending | paused | done
  postUrl: '',
  keywords: [],
  dmTemplate: '',
  delaySeconds: 30,
  matchedUsers: [],
  selectedUsers: [],
  sentLog: [],
  pendingFollow: [],
  currentIndex: 0,
  tabId: null,
  currentDMStep: '',
  currentDMUser: ''
};

// ─── State: Bulk Outreach ───
let boState = {
  status: 'idle',  // idle | sending | paused | done
  outreachList: [],  // { username, templateId, templateName, dmTemplate }
  delaySeconds: 30,
  sentLog: [],       // { username, status, message, timestamp }
  currentIndex: 0,
  tabId: null
};

// ─── Open side panel when extension icon is clicked ───
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

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
    state.delaySeconds = msg.delaySeconds || 30;
    state.status = 'scanning';
    state.matchedUsers = [];
    state.sentLog = [];
    state.currentIndex = 0;

    await chrome.storage.local.set({ lastConfig: {
      postUrl: msg.postUrl, keywords: msg.keywords,
      dmTemplate: msg.dmTemplate, delaySeconds: msg.delaySeconds,
      autoSend: msg.autoSend || false
    }});

    broadcastProgress({ step: 'scan', detail: 'Navigating to post...' });
    const tab = await getOrCreateIGTab(msg.postUrl);
    state.tabId = tab.id;
    await waitForTabLoad(tab.id);
    await delay(4000);
    await injectContentScript(tab.id);
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
  resumeDMs: () => { state.status = 'sending'; runDMLoop(); return { success: true }; },

  reset: () => {
    state.status = 'idle'; state.matchedUsers = []; state.selectedUsers = [];
    state.sentLog = []; state.currentIndex = 0; state.currentDMStep = ''; state.currentDMUser = '';
    return { success: true };
  },

  getHistory: async () => { const data = await chrome.storage.local.get('dmHistory'); return { history: data.dmHistory || [] }; },
  clearHistory: async () => { await chrome.storage.local.set({ dmHistory: [] }); return { success: true }; },
  getLastConfig: async () => { const data = await chrome.storage.local.get('lastConfig'); return { config: data.lastConfig || null }; },

  // Pending Follows (Keyword Scan Plan B)
  getPendingFollows: async () => { const data = await chrome.storage.local.get('pendingFollows'); return { pendingFollows: data.pendingFollows || [] }; },
  clearPendingFollows: async () => { await chrome.storage.local.set({ pendingFollows: [] }); return { success: true }; },

  // ═══════════════════════════════════════════
  //  BULK OUTREACH
  // ═══════════════════════════════════════════

  getBOState: () => ({ ...boState }),

  startBulkOutreach: async (msg) => {
    boState.outreachList = msg.outreachList;
    boState.delaySeconds = msg.delaySeconds || 30;
    boState.status = 'sending';
    boState.currentIndex = 0;
    boState.sentLog = [];
    runBulkOutreachLoop();
    return { success: true };
  },

  pauseBO: () => { boState.status = 'paused'; return { success: true }; },
  resumeBO: () => { boState.status = 'sending'; runBulkOutreachLoop(); return { success: true }; },

  resetBO: () => {
    boState.status = 'idle'; boState.outreachList = []; boState.sentLog = [];
    boState.currentIndex = 0;
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

  recheckWaitlist: async () => {
    const data = await chrome.storage.local.get('boWaitlist');
    const waitlist = data.boWaitlist || [];
    if (!waitlist.length) return { success: false, error: 'Waitlist empty' };
    runWaitlistRecheck(waitlist);
    return { success: true };
  }
};


// ════════════════════════════════════════════════════════════
//  KEYWORD SCAN: DM LOOP
// ════════════════════════════════════════════════════════════

async function runDMLoop() {
  while (state.status === 'sending' && state.currentIndex < state.selectedUsers.length) {
    const user = state.selectedUsers[state.currentIndex];
    const personalizedMsg = state.dmTemplate.replace(/\{\{username\}\}/gi, user.username);
    state.currentDMUser = user.username;

    try {
      // Step 1: Navigate to profile
      state.currentDMStep = 'navigating';
      broadcastDMProgress(user.username, 'navigating', `Opening @${user.username}'s profile...`);
      await chrome.tabs.update(state.tabId, { url: `https://www.instagram.com/${user.username}/` });
      await waitForTabLoad(state.tabId);
      await delay(3000);

      // Step 2: Click Message button
      state.currentDMStep = 'clickingMessage';
      broadcastDMProgress(user.username, 'clickingMessage', 'Finding and clicking "Message" button...');
      await injectContentScript(state.tabId);
      await delay(500);
      const clickResult = await sendToTab(state.tabId, { action: 'clickMessageButton' });

      if (clickResult && clickResult.error && clickResult.noMessage) {
        // Plan B: Follow
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
        const logEntry = { username: user.username, status: 'followed', message: statusMsg, timestamp: new Date().toISOString() };
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

      // Step 3: Wait for DM
      state.currentDMStep = 'waitingDM';
      broadcastDMProgress(user.username, 'waitingDM', 'Waiting for DM conversation to open...');
      await delay(3000);
      await injectContentScript(state.tabId);
      await delay(1000);

      // Step 4: Type & send
      state.currentDMStep = 'typing';
      broadcastDMProgress(user.username, 'typing', 'Typing message...');
      const typeResult = await sendToTab(state.tabId, { action: 'typeAndSendDM', message: personalizedMsg });
      if (typeResult && typeResult.error) throw new Error(typeResult.error);

      // Step 5: Done
      state.currentDMStep = 'done';
      broadcastDMProgress(user.username, 'done', 'DM sent successfully!');
      const logEntry = { username: user.username, status: 'success', message: 'DM sent successfully', timestamp: new Date().toISOString() };
      state.sentLog.push(logEntry);
      await saveDMHistory(logEntry);

    } catch (err) {
      state.currentDMStep = 'error';
      broadcastDMProgress(user.username, 'error', `Error: ${err.message}`);
      const logEntry = { username: user.username, status: 'error', message: err.message, timestamp: new Date().toISOString() };
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
    const successCount = state.sentLog.filter(l => l.status === 'success').length;
    const followedCount = state.sentLog.filter(l => l.status === 'followed').length;
    let summary = `All done! ${successCount}/${state.selectedUsers.length} DMs sent.`;
    if (followedCount > 0) summary += ` ${followedCount} user(s) followed (pending DM).`;
    broadcastProgress({ step: 'dmDone', detail: summary, type: 'success' });
  }
}


// ════════════════════════════════════════════════════════════
//  BULK OUTREACH LOOP
// ════════════════════════════════════════════════════════════

async function runBulkOutreachLoop() {
  // Get or create a tab
  if (!boState.tabId) {
    const tab = await getOrCreateIGTab('https://www.instagram.com/');
    boState.tabId = tab.id;
    await waitForTabLoad(tab.id);
    await delay(2000);
  }

  while (boState.status === 'sending' && boState.currentIndex < boState.outreachList.length) {
    const user = boState.outreachList[boState.currentIndex];
    const personalizedMsg = (user.dmTemplate || '').replace(/\{\{username\}\}/gi, user.username);

    try {
      // Step 1: Navigate to profile
      broadcastBOProgress(user.username, 'checking', `Opening @${user.username}'s profile...`);
      await chrome.tabs.update(boState.tabId, { url: `https://www.instagram.com/${user.username}/` });
      await waitForTabLoad(boState.tabId);
      await delay(3000);

      // Step 2: Inject and check profile
      await injectContentScript(boState.tabId);
      await delay(500);

      const profileCheck = await sendToTab(boState.tabId, { action: 'checkProfileActions' });

      if (profileCheck && profileCheck.hasMessage) {
        // ── Direct DM path ──
        broadcastBOProgress(user.username, 'dm-direct', 'Message button found — clicking...');

        const clickResult = await sendToTab(boState.tabId, { action: 'clickMessageButton' });
        if (clickResult && clickResult.error) throw new Error(clickResult.error);

        // Wait for DM to open
        await delay(3000);
        await injectContentScript(boState.tabId);
        await delay(1000);

        // Type and send
        broadcastBOProgress(user.username, 'typing', 'Typing message...');
        const typeResult = await sendToTab(boState.tabId, { action: 'typeAndSendDM', message: personalizedMsg });
        if (typeResult && typeResult.error) throw new Error(typeResult.error);

        broadcastBOProgress(user.username, 'done', 'DM sent!');
        boState.sentLog.push({ username: user.username, status: 'success', message: 'DM sent', timestamp: new Date().toISOString() });
        await saveDMHistory({ username: user.username, status: 'success', message: `DM sent (${user.templateName})`, timestamp: new Date().toISOString() });

      } else {
        // ── Follow path → Waitlist ──
        broadcastBOProgress(user.username, 'following', 'No Message button — following...');

        const followResult = await sendToTab(boState.tabId, { action: 'clickFollowButton' });
        const followStatus = followResult?.status || 'unknown';
        const alreadyFollowing = followResult?.alreadyFollowing || false;

        // Add to waitlist
        await saveToWaitlist({
          username: user.username,
          templateId: user.templateId,
          templateName: user.templateName,
          dmTemplate: user.dmTemplate,
          followStatus,
          alreadyFollowing,
          timestamp: new Date().toISOString()
        });

        const statusMsg = alreadyFollowing
          ? `Already following @${user.username} — added to waitlist`
          : `Followed @${user.username} — added to waitlist`;
        broadcastBOProgress(user.username, 'waitlisted', statusMsg);
        boState.sentLog.push({ username: user.username, status: 'waitlisted', message: statusMsg, timestamp: new Date().toISOString() });
      }

    } catch (err) {
      broadcastBOProgress(user.username, 'error', `Error: ${err.message}`);
      boState.sentLog.push({ username: user.username, status: 'error', message: err.message, timestamp: new Date().toISOString() });
    }

    boState.currentIndex++;

    if (boState.status === 'sending' && boState.currentIndex < boState.outreachList.length) {
      broadcastBOProgress('', 'waiting', `Waiting ${boState.delaySeconds}s before next user...`);
      await delay(boState.delaySeconds * 1000, true, () => boState.status !== 'sending');
    }
  }

  if (boState.currentIndex >= boState.outreachList.length) {
    boState.status = 'done';
    const dmSent = boState.sentLog.filter(l => l.status === 'success').length;
    const waitlisted = boState.sentLog.filter(l => l.status === 'waitlisted').length;
    let summary = `All done! ${dmSent} DMs sent.`;
    if (waitlisted > 0) summary += ` ${waitlisted} added to waitlist.`;
    broadcastProgress({ step: 'boDone', detail: summary, type: 'success' });
  }
}


// ════════════════════════════════════════════════════════════
//  WAITLIST RE-CHECK
// ════════════════════════════════════════════════════════════

async function runWaitlistRecheck(waitlist) {
  if (!boState.tabId) {
    const tab = await getOrCreateIGTab('https://www.instagram.com/');
    boState.tabId = tab.id;
    await waitForTabLoad(tab.id);
    await delay(2000);
  }

  const results = [];
  const remaining = [];

  for (let i = 0; i < waitlist.length; i++) {
    const user = waitlist[i];
    const personalizedMsg = (user.dmTemplate || '').replace(/\{\{username\}\}/gi, user.username);

    try {
      broadcastWaitlistProgress(user.username, 'checking', `Checking @${user.username}...`, i, waitlist.length, results);

      await chrome.tabs.update(boState.tabId, { url: `https://www.instagram.com/${user.username}/` });
      await waitForTabLoad(boState.tabId);
      await delay(3000);
      await injectContentScript(boState.tabId);
      await delay(500);

      const profileCheck = await sendToTab(boState.tabId, { action: 'checkProfileActions' });

      if (profileCheck && profileCheck.hasMessage) {
        // They accepted! Send DM
        broadcastWaitlistProgress(user.username, 'checking', `Message button found — sending DM...`, i, waitlist.length, results);

        const clickResult = await sendToTab(boState.tabId, { action: 'clickMessageButton' });
        if (clickResult && clickResult.error) throw new Error(clickResult.error);

        await delay(3000);
        await injectContentScript(boState.tabId);
        await delay(1000);

        const typeResult = await sendToTab(boState.tabId, { action: 'typeAndSendDM', message: personalizedMsg });
        if (typeResult && typeResult.error) throw new Error(typeResult.error);

        broadcastWaitlistProgress(user.username, 'dm-sent', `DM sent to @${user.username}!`, i, waitlist.length, results);
        results.push({ username: user.username, status: 'dm-sent' });
        await saveDMHistory({ username: user.username, status: 'success', message: `DM sent (waitlist re-check, ${user.templateName})`, timestamp: new Date().toISOString() });
      } else {
        // Still no Message button
        broadcastWaitlistProgress(user.username, 'still-waiting', `@${user.username} — still no Message button`, i, waitlist.length, results);
        results.push({ username: user.username, status: 'still-waiting' });
        remaining.push(user);
      }

    } catch (err) {
      broadcastWaitlistProgress(user.username, 'error', `@${user.username}: ${err.message}`, i, waitlist.length, results);
      results.push({ username: user.username, status: 'error' });
      remaining.push(user);
    }

    // Short delay between checks
    if (i < waitlist.length - 1) await delay(5000);
  }

  // Update waitlist with only remaining users
  await chrome.storage.local.set({ boWaitlist: remaining });

  // Final broadcast
  broadcastWaitlistProgress('', 'done', 'Re-check complete', waitlist.length, waitlist.length, results);
}


// ════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════

async function getOrCreateIGTab(url) {
  const tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
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

async function injectContentScript(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ['js/content.js'] }); } catch (e) { console.warn('Inject failed:', e.message); }
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
  history.unshift(entry);
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
