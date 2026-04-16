/**
 * Background Service Worker (v3)
 *
 * THE ORCHESTRATOR — drives all navigation and content-script injection.
 *
 * Key architecture change from v2:
 *   The content script NEVER navigates. It only performs atomic actions on
 *   the current page. The background script uses chrome.tabs.update() to
 *   navigate, chrome.tabs.onUpdated to wait for load, and
 *   chrome.scripting.executeScript() to (re-)inject the content script
 *   before sending it a command.
 *
 * DM flow per user:
 *   1. background navigates tab → user's profile
 *   2. background injects content script
 *   3. content script clicks "Message" button → reports back
 *   4. background waits for DM page load
 *   5. background injects content script again
 *   6. content script types message + sends → reports back
 *   7. background logs result, waits delay, moves to next user
 */

// ─── State ───
let state = {
  status: 'idle',  // idle | scanning | reviewing | sending | paused | done
  postUrl: '',
  keywords: [],
  dmTemplate: '',
  delaySeconds: 30,
  matchedUsers: [],
  selectedUsers: [],
  sentLog: [],          // { username, status, message, timestamp }
  pendingFollow: [],    // users followed but not yet DM'd (Plan B)
  currentIndex: 0,
  tabId: null,
  // Granular per-user DM progress
  currentDMStep: '',    // navigating | clickingMessage | waitingDM | typing | sending | done | error | following
  currentDMUser: ''
};

// ─── Open side panel when extension icon is clicked ───
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Also allow side panel to open by default
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

  /* ═══ SCAN ═══ */

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

    // Navigate to the post
    broadcastProgress({ step: 'scan', detail: 'Navigating to post...' });

    const tab = await getOrCreateIGTab(msg.postUrl);
    state.tabId = tab.id;

    await waitForTabLoad(tab.id);
    await delay(4000);

    // Inject content script and scan
    await injectContentScript(tab.id);
    await delay(1000);

    broadcastProgress({ step: 'scan', detail: 'Scrolling comment area and extracting comments...' });

    try {
      const result = await sendToTab(tab.id, {
        action: 'scanComments',
        keywords: state.keywords
      });

      if (result && result.matchedUsers) {
        state.matchedUsers = result.matchedUsers;
      }
    } catch (e) {
      broadcastProgress({ step: 'scan', detail: 'Scan error: ' + e.message, type: 'error' });
    }

    state.status = 'reviewing';
    broadcastProgress({ step: 'scan', detail: `Scan complete! Found ${state.matchedUsers.length} matches.`, type: 'success' });

    return { success: true, matchedUsers: state.matchedUsers };
  },

  // Content script reports scan progress
  scanProgress: (msg) => {
    broadcastProgress({ step: 'scan', detail: msg.detail || `Scanned ${msg.scanned}/${msg.total} comments` });
    return { success: true };
  },

  // Content script reports scan results
  scanResults: (msg) => {
    state.matchedUsers = msg.matchedUsers || [];
    state.status = 'reviewing';
    return { success: true };
  },

  cancelScan: () => {
    state.status = 'idle';
    return { success: true };
  },

  /* ═══ DM SENDING ═══ */

  startSendingDMs: async (msg) => {
    state.selectedUsers = msg.selectedUsers;
    state.status = 'sending';
    state.currentIndex = 0;
    state.sentLog = [];

    // Start the DM loop (async, runs in background)
    runDMLoop();
    return { success: true };
  },

  pauseDMs: () => {
    state.status = 'paused';
    return { success: true };
  },

  resumeDMs: () => {
    state.status = 'sending';
    runDMLoop();
    return { success: true };
  },

  reset: () => {
    state.status = 'idle';
    state.matchedUsers = [];
    state.selectedUsers = [];
    state.sentLog = [];
    state.currentIndex = 0;
    state.currentDMStep = '';
    state.currentDMUser = '';
    return { success: true };
  },

  getHistory: async () => {
    const data = await chrome.storage.local.get('dmHistory');
    return { history: data.dmHistory || [] };
  },

  clearHistory: async () => {
    await chrome.storage.local.set({ dmHistory: [] });
    return { success: true };
  },

  getLastConfig: async () => {
    const data = await chrome.storage.local.get('lastConfig');
    return { config: data.lastConfig || null };
  },

  /* ═══ PENDING FOLLOW QUEUE (Plan B) ═══ */

  getPendingFollows: async () => {
    const data = await chrome.storage.local.get('pendingFollows');
    return { pendingFollows: data.pendingFollows || [] };
  },

  clearPendingFollows: async () => {
    await chrome.storage.local.set({ pendingFollows: [] });
    return { success: true };
  },

  retryPendingDMs: async (msg) => {
    const data = await chrome.storage.local.get('pendingFollows');
    const pending = data.pendingFollows || [];
    if (!pending.length) return { success: false, error: 'No pending follows' };

    // Use the stored DM template or the one provided
    state.dmTemplate = msg.dmTemplate || state.dmTemplate;
    state.delaySeconds = msg.delaySeconds || state.delaySeconds || 30;
    state.selectedUsers = pending.map(p => ({ username: p.username, comment: p.comment, matchedKeyword: p.matchedKeyword }));
    state.status = 'sending';
    state.currentIndex = 0;
    state.sentLog = [];
    state.pendingFollow = [];

    runDMLoop();
    return { success: true };
  }
};

// ════════════════════════════════════════════════════════════
//  DM LOOP — runs entirely in background
// ════════════════════════════════════════════════════════════

async function runDMLoop() {
  while (
    state.status === 'sending' &&
    state.currentIndex < state.selectedUsers.length
  ) {
    const user = state.selectedUsers[state.currentIndex];
    const personalizedMsg = state.dmTemplate.replace(/\{\{username\}\}/gi, user.username);
    state.currentDMUser = user.username;

    try {
      // ── Step 1: Navigate to user's profile ──
      state.currentDMStep = 'navigating';
      broadcastDMProgress(user.username, 'navigating', `Opening @${user.username}'s profile...`);

      await chrome.tabs.update(state.tabId, { url: `https://www.instagram.com/${user.username}/` });
      await waitForTabLoad(state.tabId);
      await delay(3000);

      // ── Step 2: Inject content script & click "Message" button ──
      state.currentDMStep = 'clickingMessage';
      broadcastDMProgress(user.username, 'clickingMessage', 'Finding and clicking "Message" button...');

      await injectContentScript(state.tabId);
      await delay(500);

      const clickResult = await sendToTab(state.tabId, { action: 'clickMessageButton' });

      if (clickResult && clickResult.error && clickResult.noMessage) {
        // ── Plan B: No Message button → Follow instead ──
        state.currentDMStep = 'following';
        broadcastDMProgress(user.username, 'following', 'No Message button — following user instead...');

        await delay(500);
        const followResult = await sendToTab(state.tabId, { action: 'clickFollowButton' });

        const followStatus = followResult?.status || 'unknown';
        const alreadyFollowing = followResult?.alreadyFollowing || false;

        // Save to pending follows queue
        await savePendingFollow({
          username: user.username,
          comment: user.comment || '',
          matchedKeyword: user.matchedKeyword || '',
          followStatus,
          alreadyFollowing,
          timestamp: new Date().toISOString()
        });

        state.currentDMStep = 'followed';
        const statusMsg = alreadyFollowing
          ? `Already following @${user.username} — saved to retry queue`
          : `Followed @${user.username} (${followStatus}) — saved to retry queue`;
        broadcastDMProgress(user.username, 'followed', statusMsg);

        const logEntry = {
          username: user.username,
          status: 'followed',
          message: statusMsg,
          timestamp: new Date().toISOString()
        };
        state.sentLog.push(logEntry);
        await saveDMHistory(logEntry);

        state.currentIndex++;
        if (state.status === 'sending' && state.currentIndex < state.selectedUsers.length) {
          broadcastDMProgress('', 'waiting', `Waiting ${state.delaySeconds}s before next user...`);
          await delay(state.delaySeconds * 1000);
        }
        continue;
      } else if (clickResult && clickResult.error) {
        throw new Error(clickResult.error);
      }

      // ── Step 3: Wait for DM page/modal to load ──
      state.currentDMStep = 'waitingDM';
      broadcastDMProgress(user.username, 'waitingDM', 'Waiting for DM conversation to open...');

      await delay(3000);

      // Re-inject in case we navigated to /direct/
      await injectContentScript(state.tabId);
      await delay(1000);

      // ── Step 4: Type the message ──
      state.currentDMStep = 'typing';
      broadcastDMProgress(user.username, 'typing', 'Typing message...');

      const typeResult = await sendToTab(state.tabId, {
        action: 'typeAndSendDM',
        message: personalizedMsg
      });

      if (typeResult && typeResult.error) {
        throw new Error(typeResult.error);
      }

      // ── Step 5: Done ──
      state.currentDMStep = 'done';
      broadcastDMProgress(user.username, 'done', 'DM sent successfully!');

      const logEntry = {
        username: user.username,
        status: 'success',
        message: 'DM sent successfully',
        timestamp: new Date().toISOString()
      };
      state.sentLog.push(logEntry);
      await saveDMHistory(logEntry);

    } catch (err) {
      state.currentDMStep = 'error';
      broadcastDMProgress(user.username, 'error', `Error: ${err.message}`);

      const logEntry = {
        username: user.username,
        status: 'error',
        message: err.message,
        timestamp: new Date().toISOString()
      };
      state.sentLog.push(logEntry);
      await saveDMHistory(logEntry);
    }

    state.currentIndex++;

    // Wait delay before next user (unless paused or done)
    if (state.status === 'sending' && state.currentIndex < state.selectedUsers.length) {
      broadcastDMProgress('', 'waiting', `Waiting ${state.delaySeconds}s before next DM...`);
      await delay(state.delaySeconds * 1000);
    }
  }

  if (state.currentIndex >= state.selectedUsers.length) {
    state.status = 'done';
    const successCount = state.sentLog.filter(l => l.status === 'success').length;
    const followedCount = state.sentLog.filter(l => l.status === 'followed').length;
    let summary = `All done! ${successCount}/${state.selectedUsers.length} DMs sent.`;
    if (followedCount > 0) {
      summary += ` ${followedCount} user(s) followed (pending DM).`;
    }
    broadcastProgress({
      step: 'dmDone',
      detail: summary,
      type: 'success'
    });
  }
}

// ════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════

/** Get an existing Instagram tab or create one */
async function getOrCreateIGTab(url) {
  const tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true, url });
    return tabs[0];
  }
  return chrome.tabs.create({ url });
}

/** Wait for a tab to finish loading */
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
    // Safety timeout
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeout);
  });
}

/** Inject the content script into a tab */
async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['js/content.js']
    });
  } catch (e) {
    console.warn('Content script injection failed:', e.message);
  }
  // Also inject CSS
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['css/overlay.css']
    });
  } catch (e) { /* ignore */ }
}

/** Send a message to a tab's content script with retry */
async function sendToTab(tabId, msg, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, msg);
      return response;
    } catch (e) {
      if (i < retries - 1) {
        await delay(1500);
        await injectContentScript(tabId);
        await delay(500);
      } else {
        throw e;
      }
    }
  }
}

/** Broadcast progress to the side panel */
function broadcastProgress(data) {
  chrome.runtime.sendMessage({ action: 'progressUpdate', ...data }).catch(() => {});
}

/** Broadcast per-user DM progress to the side panel */
function broadcastDMProgress(username, substep, detail) {
  chrome.runtime.sendMessage({
    action: 'dmProgressUpdate',
    username,
    substep,
    detail,
    currentIndex: state.currentIndex,
    total: state.selectedUsers?.length || 0,
    sentLog: state.sentLog
  }).catch(() => {});
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
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
  // Avoid duplicates
  if (!pending.some(p => p.username === entry.username)) {
    pending.push(entry);
    await chrome.storage.local.set({ pendingFollows: pending });
  }
}
