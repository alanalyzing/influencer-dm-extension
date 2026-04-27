/**
 * Threads Content Script (v1) — Atomic Single-Page Actions for threads.net
 *
 * This script NEVER navigates. It only performs actions on the current page.
 * The background service worker handles all navigation.
 *
 * Actions:
 *   1. scanComments    — on a Threads post page: scroll replies, extract, match keywords
 *   2. checkProfileActions — on a Threads profile: detect Follow/Following/Message buttons
 *   3. clickFollowButton  — on a Threads profile: click Follow
 *   4. checkForMessageButton — after follow, check if Message button appeared
 *   5. clickMessageButton — click Message button on profile
 *   6. typeAndSendDM     — on DM page: type and send (Threads DMs on web when available)
 *   7. ping              — health check
 *
 * NOTE: Threads DMs are currently mobile-only (as of April 2026). For DMs, the
 * background worker will redirect to the user's Instagram profile instead.
 * This script handles Threads-specific scanning and following.
 */

(() => {
  'use strict';

  // Prevent duplicate injection
  if (window.__IEM_THREADS_V1__) return;
  window.__IEM_THREADS_V1__ = true;

  if (window.__IEM_THREADS_LISTENER__) {
    chrome.runtime.onMessage.removeListener(window.__IEM_THREADS_LISTENER__);
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ─── Message Handler ───

  function messageListener(msg, sender, sendResponse) {
    const handlers = {
      scanComments: () => handleScanComments(msg),
      checkProfileActions: () => handleCheckProfileActions(),
      clickFollowButton: () => handleClickFollowButton(),
      checkForMessageButton: () => handleCheckForMessageButton(),
      clickMessageButton: () => handleClickMessageButton(),
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

  window.__IEM_THREADS_LISTENER__ = messageListener;
  chrome.runtime.onMessage.addListener(messageListener);

  // ════════════════════════════════════════════════════════════
  //  ACTION 1: SCAN COMMENTS / REPLIES (on Threads post page)
  // ════════════════════════════════════════════════════════════

  async function handleScanComments(msg) {
    const keywords = (msg.keywords || []).map(k => k.trim().toLowerCase());
    const report = (detail) => {
      chrome.runtime.sendMessage({ action: 'scanProgress', detail }).catch(() => {});
    };

    // 1. Wait for page render
    await sleep(2500);
    report('Threads post loaded. Looking for replies...');

    // 2. Scroll the page to load all replies
    // Threads post pages show replies below the main post in a single-column layout
    report('Scrolling to load all replies...');
    let prevHeight = 0, stableCount = 0;
    for (let i = 0; i < 60; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(1500);

      // Click any "Show more replies" or "View more" buttons
      await expandThreadsReplies();

      if (document.body.scrollHeight === prevHeight) {
        stableCount++;
        if (stableCount >= 3) break;
      } else {
        stableCount = 0;
        report(`Scrolling... ${document.body.scrollHeight}px loaded`);
      }
      prevHeight = document.body.scrollHeight;
    }

    // Scroll back to top
    window.scrollTo(0, 0);
    await sleep(500);

    // 3. Extract replies
    report('Extracting replies...');
    const comments = extractThreadsReplies();
    report(`Found ${comments.length} replies. Matching keywords...`);

    // 4. Match keywords
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

    report(`Scan complete! ${matchedUsers.length} matches from ${comments.length} replies.`);
    chrome.runtime.sendMessage({ action: 'scanResults', matchedUsers }).catch(() => {});

    return { success: true, matchedUsers };
  }

  async function expandThreadsReplies() {
    const clickables = document.querySelectorAll(
      'div[role="button"], span[role="button"], button'
    );
    for (const el of clickables) {
      const t = el.textContent.trim().toLowerCase();
      if (
        /show more|view more|view repl|load more|see more repl/i.test(t) ||
        /\d+ more repl/i.test(t) ||
        /view \d+ more/i.test(t)
      ) {
        el.click();
        await sleep(1000);
      }
    }
  }

  function extractThreadsReplies() {
    const comments = [];
    const seen = new Set();

    // Threads uses links like /@username for profiles
    // Find all profile links in the reply section
    const allLinks = document.querySelectorAll('a[href^="/@"], a[href*="threads.net/@"]');

    for (const link of allLinks) {
      let href = link.getAttribute('href') || '';

      // Extract username from href
      let username = '';
      if (href.startsWith('/@')) {
        username = href.slice(2).replace(/\/$/, '');
      } else {
        const match = href.match(/threads\.(?:net|com)\/@([a-zA-Z0-9._]+)/);
        if (match) username = match[1];
      }

      if (!username) continue;
      // Skip if this link contains an image (profile pic, not username text)
      if (link.querySelector('img')) continue;

      // The link text should be the username or @username
      const linkText = link.textContent.trim().replace(/^@/, '');
      if (linkText !== username) continue;

      // Find the reply container — walk up to find the reply block
      const replyBlock = findThreadsReplyBlock(link);
      if (!replyBlock) continue;

      // Extract the reply text
      const replyText = extractThreadsReplyText(replyBlock, username);
      if (!replyText) continue;

      const key = `${username}::${replyText}`;
      if (seen.has(key)) continue;
      seen.add(key);

      comments.push({ username, text: replyText });
    }

    return comments;
  }

  function findThreadsReplyBlock(link) {
    // Walk up the DOM to find the reply container
    // Threads wraps each reply in a div that contains the username link and reply text
    let el = link;
    for (let d = 0; d < 15; d++) {
      el = el.parentElement;
      if (!el) return null;

      // Check if this element or its parent has siblings that also contain username links
      const parent = el.parentElement;
      if (!parent) continue;

      const siblings = Array.from(parent.children);
      if (siblings.length < 2) continue;

      // Check if siblings also have profile links (indicating a list of replies)
      let sibCount = 0;
      for (const sib of siblings) {
        if (sib === el) continue;
        const sibLinks = sib.querySelectorAll('a[href^="/@"], a[href*="threads.net/@"]');
        for (const sl of sibLinks) {
          if (!sl.querySelector('img')) {
            sibCount++;
            break;
          }
        }
      }
      if (sibCount >= 1) return el;
    }

    // Fallback: just use the closest reasonable ancestor
    let fallback = link;
    for (let d = 0; d < 8; d++) {
      fallback = fallback.parentElement;
      if (!fallback) return null;
      const rect = fallback.getBoundingClientRect();
      if (rect.height > 40 && rect.width > 200) return fallback;
    }
    return null;
  }

  function extractThreadsReplyText(replyBlock, username) {
    const skipPatterns = [
      /^Reply$/i, /^Like$/i, /^Liked$/i, /^See translation$/i,
      /^\d+\s*likes?$/i, /^\d+[wdhms]$/, /^\d+ (weeks?|days?|hours?|minutes?|seconds?) ago$/i,
      /^View \d+ repl/i, /^View all/i, /^Load more/i, /^Verified$/i,
      /^Repost$/i, /^Share$/i, /^Comment$/i, /^More$/i, /^Quote$/i,
      /^\d+$/, /^@/
    ];

    // Look through spans and divs for the reply text
    const textElements = replyBlock.querySelectorAll('span, div[dir="auto"]');
    for (const span of textElements) {
      const t = span.textContent.trim();
      if (!t || t === username || t === `@${username}` || t.length > 500) continue;
      if (skipPatterns.some(p => p.test(t))) continue;

      // Skip if this span is inside a link (it's a username, not reply text)
      if (span.closest('a[href^="/@"]') || span.closest('a[href*="threads.net/@"]')) continue;

      // Skip very short text that's likely UI elements
      if (t.length < 2) continue;

      return t;
    }
    return '';
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION: CHECK PROFILE ACTIONS (detect Message vs Follow)
  // ════════════════════════════════════════════════════════════

  async function handleCheckProfileActions() {
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

      if (hasMessage || hasFollow || isFollowing || isRequested) {
        return { hasMessage, hasFollow, isFollowing, isRequested };
      }

      await sleep(500);
    }

    return { hasMessage: false, hasFollow: false, isFollowing: false, isRequested: false };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION: CLICK FOLLOW BUTTON
  // ════════════════════════════════════════════════════════════

  async function handleClickFollowButton() {
    for (let attempt = 0; attempt < 20; attempt++) {
      for (const el of document.querySelectorAll('div[role="button"], button')) {
        const text = el.textContent.trim();
        if (text === 'Follow') {
          el.click();
          await sleep(1500);
          const newText = el.textContent.trim();
          if (newText === 'Following' || newText === 'Requested' || newText !== 'Follow') {
            return { success: true, status: newText };
          }
          return { success: true, status: 'clicked' };
        }
        if (text === 'Following' || text === 'Requested') {
          return { success: true, status: text, alreadyFollowing: true };
        }
      }
      await sleep(500);
    }
    return { error: 'No Follow button found on this profile' };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION: CHECK FOR MESSAGE BUTTON (after follow)
  // ════════════════════════════════════════════════════════════

  async function handleCheckForMessageButton() {
    for (let attempt = 0; attempt < 16; attempt++) {
      for (const el of document.querySelectorAll('div[role="button"], button')) {
        if (el.textContent.trim() === 'Message') {
          return { found: true };
        }
      }
      await sleep(500);
    }
    return { found: false };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION: CLICK MESSAGE BUTTON
  // ════════════════════════════════════════════════════════════

  async function handleClickMessageButton() {
    for (let attempt = 0; attempt < 20; attempt++) {
      for (const el of document.querySelectorAll('div[role="button"], button')) {
        if (el.textContent.trim() === 'Message') {
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
  //  ACTION: TYPE AND SEND DM (for when Threads web DMs are available)
  // ════════════════════════════════════════════════════════════

  async function handleTypeAndSendDM(message) {
    // Find the message input
    const input = await findMessageInput(12000);
    if (!input) {
      return { error: 'Could not find message input box' };
    }

    await typeIntoInput(input, message);
    await sleep(800);
    await sendMessage(input);
    await sleep(1500);

    return { success: true };
  }

  async function findMessageInput(timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const textarea = document.querySelector(
        'textarea[placeholder*="Message"], textarea[placeholder*="message"]'
      );
      if (textarea) return textarea;

      for (const el of document.querySelectorAll('div[contenteditable="true"], div[role="textbox"]')) {
        const rect = el.getBoundingClientRect();
        if (rect.height > 0 && rect.width > 50) return el;
      }

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
      input.focus();
      input.textContent = '';
      await sleep(100);
      document.execCommand('insertText', false, message);
    }
  }

  async function sendMessage(input) {
    for (const eventType of ['keydown', 'keypress', 'keyup']) {
      input.dispatchEvent(new KeyboardEvent(eventType, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true
      }));
    }
    await sleep(800);

    for (const btn of document.querySelectorAll('button, div[role="button"]')) {
      const text = btn.textContent.trim().toLowerCase();
      if (text === 'send') { btn.click(); return; }
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('send')) { btn.click(); return; }
    }
  }

})();
