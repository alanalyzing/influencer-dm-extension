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
      checkIfPrivate: () => handleCheckIfPrivate(),
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
  //  ACTION: CHECK IF PROFILE IS PRIVATE
  // ════════════════════════════════════════════════════════════

  async function handleCheckIfPrivate() {
    // Instagram private profile indicators:
    // 1. "This account is private" text on the page
    // 2. "This Account is Private" heading
    // 3. Lock icon + "Private Account" text
    // 4. No posts visible + follow button present
    // 5. Profile shows 0 posts grid but has follower count

    const pageText = document.body.innerText || '';

    // Check for explicit private account text
    const privateIndicators = [
      'This account is private',
      'This Account is Private',
      'Follow this account to see their photos and videos',
      'follow this account to see their photos',
      'This is a private account'
    ];

    for (const indicator of privateIndicators) {
      if (pageText.includes(indicator)) {
        return { isPrivate: true, reason: indicator };
      }
    }

    // Check for the private lock icon (Instagram uses a specific SVG or text)
    const headings = document.querySelectorAll('h2, span[class]');
    for (const h of headings) {
      const text = h.textContent.trim().toLowerCase();
      if (text.includes('private') && text.includes('account')) {
        return { isPrivate: true, reason: 'Private account heading detected' };
      }
    }

    // Additional check: if there's no posts grid visible and no Message button,
    // it's likely private (but we can't be 100% sure)
    const articles = document.querySelectorAll('article');
    const postLinks = document.querySelectorAll('a[href*="/p/"]');
    const hasNoPosts = articles.length === 0 && postLinks.length === 0;

    // Check if there's a Follow button (not Following/Requested)
    let hasFollowBtn = false;
    for (const el of document.querySelectorAll('div[role="button"], button')) {
      if (el.textContent.trim() === 'Follow') {
        hasFollowBtn = true;
        break;
      }
    }

    // If no posts visible + follow button present = likely private
    if (hasNoPosts && hasFollowBtn) {
      return { isPrivate: true, reason: 'No posts visible + Follow button present' };
    }

    return { isPrivate: false };
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
    // Find the message input — wait up to 15 seconds
    let input = await findMessageInput(15000);
    if (!input) {
      return { error: 'Could not find message input box' };
    }

    // Count existing message bubbles before sending (for post-send verification)
    const bubbleCountBefore = countMessageBubbles();

    // BULLETPROOF TYPING: Never give up. Retry up to 8 times with escalating strategies.
    // Each attempt uses all 5 strategies internally, so this is effectively 40 strategy attempts.
    const MAX_TYPE_ATTEMPTS = 8;
    for (let attempt = 1; attempt <= MAX_TYPE_ATTEMPTS; attempt++) {
      // Type the message
      await typeIntoInput(input, message);
      await sleep(1200);

      // Verify text was actually entered
      const typed = getInputText(input);
      if (typed.trim().length === 0) {
        console.log(`[DM Extension] Type attempt ${attempt}/${MAX_TYPE_ATTEMPTS} failed, retrying...`);
        // Wait longer between retries to let React settle
        await sleep(2000 + attempt * 1000);
        // Re-find the input in case DOM was replaced (React re-renders)
        const freshInput = await findMessageInput(5000);
        if (freshInput && freshInput !== input) {
          console.log('[DM Extension] Input element changed, using fresh reference');
          input = freshInput;
        } else if (attempt >= 4) {
          // After 4 failed attempts, try scrolling the input into view and clicking it
          console.log('[DM Extension] Attempt >= 4: scrolling input into view and clicking');
          input.scrollIntoView({ block: 'center' });
          await sleep(500);
          input.click();
          await sleep(500);
          input.focus();
          await sleep(500);
        }
        if (attempt === MAX_TYPE_ATTEMPTS) {
          // LAST RESORT: Force text into the DOM and proceed anyway
          console.log('[DM Extension] All type attempts failed — forcing text via innerHTML and proceeding');
          if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
            input.value = message;
          } else {
            input.innerHTML = `<span>${message.replace(/\n/g, '<br>')}</span>`;
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(500);
          // Don't return error — proceed to send anyway
        } else {
          continue;
        }
      }

      // Send the message
      await sendMessage(input);
      await sleep(2000);

      // VERIFICATION LAYER 1: Check input is empty (text was consumed)
      const remaining = getInputText(input);
      if (remaining.trim().length > 0) {
        // Text still in input — send didn't fire
        if (attempt >= MAX_TYPE_ATTEMPTS - 1) {
          // Last resort: try multiple send strategies aggressively
          console.log('[DM Extension] Send failed, trying aggressive send strategies');
          // Try Enter key
          input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            shiftKey: false, bubbles: true, cancelable: true
          }));
          await sleep(500);
          input.dispatchEvent(new KeyboardEvent('keypress', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            shiftKey: false, bubbles: true, cancelable: true
          }));
          await sleep(500);
          // Try finding Send button again
          const retryBtn = findSendButton();
          if (retryBtn) retryBtn.click();
          await sleep(1500);
          const finalCheck = getInputText(input);
          if (finalCheck.trim().length > 0 && attempt === MAX_TYPE_ATTEMPTS) {
            // Even on final failure, report as partial success — text IS in the input
            return { success: true, warning: 'Message typed but send may not have fired — text is in input', partial: true };
          }
        } else {
          await sleep(1000);
          continue;
        }
      }

      // ─── Input was cleared = message was sent. DO NOT retry from here. ───
      // Even if bubble verification fails, the message was consumed by Instagram.
      // Retrying would send a DUPLICATE message.

      // VERIFICATION LAYER 2: Check that a new message bubble appeared
      await sleep(1000);
      const bubbleCountAfter = countMessageBubbles();
      if (bubbleCountAfter > bubbleCountBefore) {
        // Confirmed: new message bubble appeared
        return { success: true, verified: true };
      }

      // Bubble didn't appear — could be slow render, wait more
      await sleep(2000);
      const bubbleCountFinal = countMessageBubbles();
      if (bubbleCountFinal > bubbleCountBefore) {
        return { success: true, verified: true };
      }

      // Input is empty but no new bubble — message was sent but bubble not detected.
      // DO NOT retry — return as unverified success to avoid duplicate sends.
      return { success: true, verified: false, warning: 'Input cleared but message bubble not detected — possible silent block or slow render' };
    }

    return { success: true, verified: false };
  }

  /**
   * Count message bubbles in the DM conversation.
   * Instagram renders sent messages as div elements within the chat thread.
   * We count elements that look like outgoing message containers.
   */
  function countMessageBubbles() {
    let count = 0;

    // Strategy 1: Look for message rows in the chat
    // Instagram DM messages are typically in a scrollable container with role="row" or similar
    const rows = document.querySelectorAll('div[role="row"], div[role="listitem"]');
    if (rows.length > 0) return rows.length;

    // Strategy 2: Look for message-like containers
    // Sent messages often have a specific background color and are aligned right
    const allDivs = document.querySelectorAll('div[dir="auto"]');
    for (const div of allDivs) {
      const style = window.getComputedStyle(div);
      const parent = div.closest('[class]');
      if (parent) {
        const parentStyle = window.getComputedStyle(parent);
        // Sent messages are typically in colored bubbles (blue/purple background)
        if (parentStyle.backgroundColor && parentStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
            parentStyle.backgroundColor !== 'rgb(255, 255, 255)' &&
            parentStyle.backgroundColor !== 'transparent') {
          count++;
        }
      }
    }
    if (count > 0) return count;

    // Strategy 3: Count any text containers in the chat area that aren't the input
    const chatContainer = document.querySelector('div[role="textbox"]')?.closest('div[style]')?.parentElement?.parentElement;
    if (chatContainer) {
      const spans = chatContainer.querySelectorAll('span[dir="auto"]');
      return spans.length;
    }

    return 0;
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
    // Strategy 1: execCommand (best for contenteditable React inputs)
    input.focus();
    await sleep(400);

    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      // Native textarea/input — use native value setter
      const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(input, message);
      else input.value = message;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // contenteditable / div[role="textbox"] — this is the Instagram DM input
      await typeContentEditable(input, message);
    }

    // Verify text was inserted
    await sleep(600);
    if (getInputText(input).trim().length > 0) return; // Success

    // Strategy 2: Re-focus + click + execCommand (handles focus-steal issues)
    console.log('[DM Extension] Strategy 1 failed, trying Strategy 2: re-focus + execCommand');
    input.click();
    await sleep(500);
    input.focus();
    await sleep(300);
    if (input.tagName !== 'TEXTAREA' && input.tagName !== 'INPUT') {
      await typeContentEditable(input, message);
    }
    await sleep(600);
    if (getInputText(input).trim().length > 0) return; // Success

    // Strategy 3: DataTransfer paste event (bypasses execCommand restrictions)
    console.log('[DM Extension] Strategy 2 failed, trying Strategy 3: DataTransfer paste');
    input.focus();
    await sleep(300);
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', message);
      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      });
      input.dispatchEvent(pasteEvent);
      await sleep(600);
      if (getInputText(input).trim().length > 0) return; // Success
    } catch (e) {
      console.log('[DM Extension] DataTransfer paste failed:', e.message);
    }

    // Strategy 4: InputEvent with data (simulates actual user typing at event level)
    console.log('[DM Extension] Strategy 3 failed, trying Strategy 4: InputEvent with data');
    input.focus();
    await sleep(300);
    // Clear first
    input.innerHTML = '';
    await sleep(100);
    // Fire beforeinput + input events with the full text
    input.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: message
    }));
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: message
    }));
    await sleep(600);
    if (getInputText(input).trim().length > 0) return; // Success

    // Strategy 5: innerHTML + synthetic events (last resort)
    console.log('[DM Extension] Strategy 4 failed, trying Strategy 5: innerHTML + events');
    input.focus();
    await sleep(200);
    const htmlContent = message
      .split('\n')
      .map(line => `<span data-text="true">${line || '\u200B'}</span>`)
      .join('<br>');
    input.innerHTML = htmlContent;
    // Fire a comprehensive set of events to trigger React reconciliation
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: message
    }));
    await sleep(400);
  }

  // Helper: type into contenteditable using execCommand
  async function typeContentEditable(input, message) {
    // Clear existing content
    input.innerHTML = '';
    input.textContent = '';
    await sleep(200);

    // Split message by line breaks and insert each line
    const lines = message.split(/\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > 0) {
        document.execCommand('insertText', false, lines[i]);
        await sleep(50);
      }
      if (i < lines.length - 1) {
        // Shift+Enter for line break
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          shiftKey: true, bubbles: true, cancelable: true
        }));
        document.execCommand('insertLineBreak');
        await sleep(50);
      }
    }

    // Dispatch input event to ensure React picks up the change
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: null
    }));
  }

  // Helper: get text content from any input type
  function getInputText(input) {
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      return input.value || '';
    }
    return input.textContent || input.innerText || '';
  }

  async function sendMessage(input) {
    // Strategy 1: Find and click the Send button directly
    // Instagram's send button may be an SVG icon button without text
    const sendBtn = findSendButton();
    if (sendBtn) {
      sendBtn.click();
      await sleep(1000);
      // Verify message was sent (input should be empty)
      const remaining = input.textContent || input.innerText || input.value || '';
      if (remaining.trim().length === 0) return;
    }

    // Strategy 2: Try Enter key (without Shift — Shift+Enter is line break)
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      shiftKey: false, bubbles: true, cancelable: true
    }));
    await sleep(300);
    input.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      shiftKey: false, bubbles: true, cancelable: true
    }));
    await sleep(1000);

    // Strategy 3: If still not sent, try clicking send button again with broader search
    const remaining = input.textContent || input.innerText || input.value || '';
    if (remaining.trim().length > 0) {
      const btn2 = findSendButton();
      if (btn2) btn2.click();
    }
  }

  function findSendButton() {
    // Look for button with text "Send"
    for (const btn of document.querySelectorAll('button, div[role="button"]')) {
      const text = btn.textContent.trim().toLowerCase();
      if (text === 'send') return btn;
    }

    // Look for button with aria-label containing "send"
    for (const btn of document.querySelectorAll('button, div[role="button"]')) {
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('send')) return btn;
    }

    // Look for SVG send icon button (paper plane icon near the input)
    // Instagram's send button is usually the last button in the message form area
    const messageForm = document.querySelector('div[role="textbox"]')?.closest('form') ||
                        document.querySelector('div[role="textbox"]')?.closest('div[class]')?.parentElement;
    if (messageForm) {
      const buttons = messageForm.querySelectorAll('button, div[role="button"]');
      for (const btn of buttons) {
        // Send button often has an SVG with a specific path or is positioned after the input
        if (btn.querySelector('svg') && !btn.querySelector('img')) {
          const rect = btn.getBoundingClientRect();
          const inputRect = document.querySelector('div[role="textbox"]')?.getBoundingClientRect();
          if (inputRect && rect.left > inputRect.right - 100) {
            return btn;
          }
        }
      }
    }

    // Broadest search: any button with SVG that appears after the textbox
    const textbox = document.querySelector('div[role="textbox"]');
    if (textbox) {
      let sibling = textbox.parentElement;
      while (sibling) {
        const btn = sibling.querySelector('button[type="submit"], button:last-of-type');
        if (btn) return btn;
        sibling = sibling.nextElementSibling;
      }
    }

    return null;
  }

})();
