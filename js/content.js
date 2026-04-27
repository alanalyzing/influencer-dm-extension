/**
 * Content Script (v3) — Atomic Single-Page Actions
 *
 * This script NEVER navigates. It only performs actions on the current page.
 * The background service worker handles all navigation.
 *
 * Three actions:
 *   1. scanComments   — on a post page: scroll comments, extract, match keywords
 *   2. clickMessageButton — on a profile page: find and click "Message" button
 *   3. typeAndSendDM  — on a DM page: find input, type message, send
 */

(() => {
  'use strict';

  // Prevent duplicate injection — critical for avoiding double-typed messages.
  // The content script can be loaded both by manifest content_scripts AND by
  // chrome.scripting.executeScript() from the background worker. Without this
  // guard, two message listeners would fire for the same action.
  if (window.__IEM_CONTENT_V3__) return;
  window.__IEM_CONTENT_V3__ = true;

  // Also remove any previously registered listener (belt-and-suspenders)
  if (window.__IEM_LISTENER__) {
    chrome.runtime.onMessage.removeListener(window.__IEM_LISTENER__);
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ─── Message Handler ───

  function messageListener(msg, sender, sendResponse) {
    const handlers = {
      scanComments: () => handleScanComments(msg),
      clickMessageButton: () => handleClickMessageButton(),
      clickFollowButton: () => handleClickFollowButton(),
      checkProfileActions: () => handleCheckProfileActions(),
      checkForMessageButton: () => handleCheckForMessageButton(),
      typeAndSendDM: () => handleTypeAndSendDM(msg.message),
      ping: () => Promise.resolve({ pong: true })
    };

    const handler = handlers[msg.action];
    if (handler) {
      handler()
        .then(r => sendResponse(r))
        .catch(e => sendResponse({ error: e.message }));
      return true; // async
    }
  }

  window.__IEM_LISTENER__ = messageListener;
  chrome.runtime.onMessage.addListener(messageListener);

  // ════════════════════════════════════════════════════════════
  //  ACTION 1: SCAN COMMENTS (on post page)
  // ════════════════════════════════════════════════════════════

  async function handleScanComments(msg) {
    const keywords = (msg.keywords || []).map(k => k.trim().toLowerCase());
    // Report progress
    const report = (detail) => {
      chrome.runtime.sendMessage({ action: 'scanProgress', detail }).catch(() => {});
    };

    // 1. Wait for page render
    await sleep(2000);

    // 2. Click "View all N comments" if present
    report('Looking for "View all comments" link...');
    const allClickables = document.querySelectorAll('a, span[role="link"], div[role="button"], button');
    for (const el of allClickables) {
      const t = el.textContent.trim();
      if (/^View all \d+ comments$/i.test(t)) {
        el.click();
        report('Loading all comments...');
        await sleep(3000);
        break;
      }
    }

    // 3. Find scrollable comment area and scroll
    report('Finding comment area...');
    const scrollContainer = findScrollableCommentArea();
    if (scrollContainer) {
      report('Scrolling to load all comments...');
      let prevHeight = 0, stableCount = 0;
      for (let i = 0; i < 50; i++) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        await sleep(1500);
        await expandReplies();
        if (scrollContainer.scrollHeight === prevHeight) {
          stableCount++;
          if (stableCount >= 3) break;
        } else {
          stableCount = 0;
          report(`Scrolling... loaded ${scrollContainer.scrollHeight}px of comments`);
        }
        prevHeight = scrollContainer.scrollHeight;
      }
      scrollContainer.scrollTop = 0;
    } else {
      report('Comment area not found — extracting visible comments.');
    }

    // 4. Extract comments
    report('Extracting comments...');
    const comments = extractAllComments();
    report(`Found ${comments.length} comments. Matching keywords...`);

    // 5. Match keywords
    const matchedUsers = [];
    const seen = new Set();

    for (const { username, text } of comments) {
      if (seen.has(username)) continue;
      const textLower = text.toLowerCase().trim();

      for (const kw of keywords) {
        const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`\\b${escaped}s?\\b`, 'i');
        if (re.test(textLower) || textLower === kw || textLower === kw + 's') {
          seen.add(username);
          matchedUsers.push({ username, comment: text, matchedKeyword: kw });
          break;
        }
      }
    }

    report(`Scan complete! ${matchedUsers.length} matches from ${comments.length} comments.`);

    // Also send results via the dedicated channel
    chrome.runtime.sendMessage({ action: 'scanResults', matchedUsers }).catch(() => {});

    return { success: true, matchedUsers };
  }

  // ─── Scroll helpers ───

  function findScrollableCommentArea() {
    const candidates = document.querySelectorAll('div, section');
    let best = null, bestScore = 0;

    for (const el of candidates) {
      const style = window.getComputedStyle(el);
      if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 100) continue;
      if (rect.left < window.innerWidth * 0.3) continue;

      const userLinks = el.querySelectorAll('a[role="link"]');
      let count = 0;
      for (const link of userLinks) {
        const href = link.getAttribute('href') || '';
        if (/^\/[a-zA-Z0-9._]+\/$/.test(href) && !link.querySelector('img')) count++;
      }
      if (count < 1) continue;

      const score = count * 10 + rect.height;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  async function expandReplies() {
    for (const btn of document.querySelectorAll('button, div[role="button"], span[role="button"]')) {
      const t = btn.textContent.trim().toLowerCase();
      if (/view replies|view \d+ more repl|load more comments|view more comments/i.test(t)) {
        btn.click();
        await sleep(1000);
      }
    }
  }

  // ─── Comment extraction ───

  function extractAllComments() {
    const comments = [];
    const seen = new Set();
    const skipNames = new Set(['explore','reels','direct','accounts','about','p','stories','tags','reel']);

    for (const link of document.querySelectorAll('a[role="link"]')) {
      const href = link.getAttribute('href') || '';
      if (!/^\/[a-zA-Z0-9._]+\/$/.test(href)) continue;
      if (link.querySelector('img')) continue;

      const username = href.replace(/\//g, '');
      if (!username || skipNames.has(username)) continue;
      if (link.textContent.trim() !== username) continue;

      const commentItem = findCommentItemAncestor(link);
      if (!commentItem) continue;

      const commentText = extractCommentText(commentItem, username);
      if (!commentText) continue;

      const key = `${username}::${commentText}`;
      if (seen.has(key)) continue;
      seen.add(key);

      comments.push({ username, text: commentText });
    }
    return comments;
  }

  function findCommentItemAncestor(link) {
    let el = link;
    for (let d = 0; d < 15; d++) {
      el = el.parentElement;
      if (!el) return null;
      const parent = el.parentElement;
      if (!parent) continue;
      const siblings = Array.from(parent.children);
      if (siblings.length < 2) continue;

      let sibCount = 0;
      for (const sib of siblings) {
        if (sib === el) continue;
        for (const sl of sib.querySelectorAll('a[role="link"]')) {
          const h = sl.getAttribute('href') || '';
          if (/^\/[a-zA-Z0-9._]+\/$/.test(h) && !sl.querySelector('img') && sl.textContent.trim() === h.replace(/\//g, '')) {
            sibCount++;
            break;
          }
        }
      }
      if (sibCount >= 1) return el;
    }
    return null;
  }

  function extractCommentText(commentItem, username) {
    const skipPatterns = [
      /^Reply$/i, /^Like$/i, /^Liked$/i, /^See translation$/i,
      /^\d+\s*likes?$/i, /^\d+[wdhms]$/, /^\d+ (weeks?|days?|hours?|minutes?|seconds?) ago$/i,
      /^View \d+ repl/i, /^View all/i, /^Load more/i, /^Verified$/i
    ];

    for (const span of commentItem.querySelectorAll('span')) {
      const t = span.textContent.trim();
      if (!t || t === username || t.length > 500) continue;
      if (skipPatterns.some(p => p.test(t))) continue;

      const childLink = span.querySelector('a');
      if (childLink && childLink.textContent.trim() === username) {
        const part = span.textContent.trim().replace(username, '').trim();
        if (part) return part;
        continue;
      }
      return t;
    }
    return '';
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 2: CLICK "MESSAGE" BUTTON (on profile page)
  // ════════════════════════════════════════════════════════════

  async function handleClickMessageButton() {
    // Wait for profile to render
    for (let attempt = 0; attempt < 20; attempt++) {
      // Look for a button/div with exact text "Message"
      for (const el of document.querySelectorAll('div[role="button"], button')) {
        const text = el.textContent.trim();
        if (text === 'Message') {
          el.click();
          await sleep(1000);
          return { success: true };
        }
      }
      await sleep(500);
    }

    return { error: 'No "Message" button found on this profile', noMessage: true };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION: CHECK PROFILE ACTIONS (detect Message vs Follow)
  // ════════════════════════════════════════════════════════════

  async function handleCheckProfileActions() {
    // Wait for profile to render
    for (let attempt = 0; attempt < 20; attempt++) {
      const buttons = document.querySelectorAll('div[role="button"], button');
      let hasMessage = false;
      let hasFollow = false;
      let isFollowing = false;
      let isRequested = false;

      for (const el of buttons) {
        const text = el.textContent.trim();
        if (text === 'Message') hasMessage = true;
        if (text === 'Follow') hasFollow = true;
        if (text === 'Following') isFollowing = true;
        if (text === 'Requested') isRequested = true;
      }

      // If we found at least one relevant button, return the result
      if (hasMessage || hasFollow || isFollowing || isRequested) {
        return {
          hasMessage,
          hasFollow,
          isFollowing,
          isRequested
        };
      }

      await sleep(500);
    }

    // Fallback: couldn't determine
    return { hasMessage: false, hasFollow: false, isFollowing: false, isRequested: false };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION: CHECK FOR MESSAGE BUTTON (after follow, on same page)
  // ════════════════════════════════════════════════════════════

  async function handleCheckForMessageButton() {
    // After following, wait up to 8 seconds for a Message button to appear
    for (let attempt = 0; attempt < 16; attempt++) {
      for (const el of document.querySelectorAll('div[role="button"], button')) {
        const text = el.textContent.trim();
        if (text === 'Message') {
          return { found: true };
        }
      }
      await sleep(500);
    }
    return { found: false };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 2B: CLICK "FOLLOW" BUTTON (Plan B fallback)
  // ════════════════════════════════════════════════════════════

  async function handleClickFollowButton() {
    // Wait for profile to render
    for (let attempt = 0; attempt < 20; attempt++) {
      for (const el of document.querySelectorAll('div[role="button"], button')) {
        const text = el.textContent.trim();
        if (text === 'Follow') {
          el.click();
          await sleep(1500);
          // Verify it changed to Following/Requested
          const newText = el.textContent.trim();
          if (newText === 'Following' || newText === 'Requested' || newText !== 'Follow') {
            return { success: true, status: newText };
          }
          return { success: true, status: 'clicked' };
        }
        // Already following
        if (text === 'Following' || text === 'Requested') {
          return { success: true, status: text, alreadyFollowing: true };
        }
      }
      await sleep(500);
    }
    return { error: 'No Follow button found on this profile' };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 3: TYPE AND SEND DM (on DM conversation page)
  // ════════════════════════════════════════════════════════════

  async function handleTypeAndSendDM(message) {
    // Find the message input
    const input = await findMessageInput(12000);
    if (!input) {
      return { error: 'Could not find message input box' };
    }

    // Type the message
    await typeIntoInput(input, message);
    await sleep(800);

    // Send the message
    await sendMessage(input);
    await sleep(1500);

    return { success: true };
  }

  async function findMessageInput(timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      // Try textarea
      const textarea = document.querySelector(
        'textarea[placeholder*="Message"], textarea[placeholder*="message"]'
      );
      if (textarea) return textarea;

      // Try contenteditable / textbox
      for (const el of document.querySelectorAll('div[contenteditable="true"], div[role="textbox"]')) {
        const rect = el.getBoundingClientRect();
        if (rect.height > 0 && rect.width > 50) return el;
      }

      // Try paragraph inside textbox
      const p = document.querySelector('div[role="textbox"] p');
      if (p) return p.closest('div[role="textbox"]') || p;

      await sleep(500);
    }
    return null;
  }

  async function typeIntoInput(input, message) {
    input.focus();
    await sleep(200);

    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const setter =
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set ||
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(input, message);
      else input.value = message;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // contenteditable / div[role="textbox"]
      // First clear any existing content
      input.focus();
      input.textContent = '';
      await sleep(100);

      // Use execCommand which triggers React's synthetic event system.
      // Do NOT dispatch an additional InputEvent — that causes double insertion.
      document.execCommand('insertText', false, message);
    }
  }

  async function sendMessage(input) {
    // Try Enter key
    for (const eventType of ['keydown', 'keypress', 'keyup']) {
      input.dispatchEvent(new KeyboardEvent(eventType, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true
      }));
    }
    await sleep(800);

    // Also try clicking Send button
    for (const btn of document.querySelectorAll('button, div[role="button"]')) {
      const text = btn.textContent.trim().toLowerCase();
      if (text === 'send') { btn.click(); return; }
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('send')) { btn.click(); return; }
    }
  }

})();
