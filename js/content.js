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
    // Find the message input — wait up to 15 seconds
    const input = await findMessageInput(15000);
    if (!input) {
      return { error: 'Could not find message input box' };
    }

    // Count existing message bubbles before sending (for post-send verification)
    const bubbleCountBefore = countMessageBubbles();

    // Attempt up to 2 tries to type and send
    for (let attempt = 1; attempt <= 2; attempt++) {
      // Type the message
      await typeIntoInput(input, message);
      await sleep(1000);

      // Verify text was actually entered
      const typed = input.textContent || input.innerText || input.value || '';
      if (typed.trim().length === 0) {
        if (attempt === 2) return { error: 'Failed to type message into input (text not registered)' };
        await sleep(1000);
        continue;
      }

      // Send the message
      await sendMessage(input);
      await sleep(2000);

      // VERIFICATION LAYER 1: Check input is empty (text was consumed)
      const remaining = input.textContent || input.innerText || input.value || '';
      if (remaining.trim().length > 0) {
        // Text still in input — send didn't fire
        if (attempt === 2) {
          // Last resort: try one more Enter key press
          input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            shiftKey: false, bubbles: true, cancelable: true
          }));
          await sleep(1500);
          const finalCheck = input.textContent || input.innerText || input.value || '';
          if (finalCheck.trim().length > 0) {
            return { error: 'Message typed but Send button did not respond', sendFailed: true };
          }
        } else {
          await sleep(1000);
          continue;
        }
      }

      // VERIFICATION LAYER 2: Check that a new message bubble appeared
      await sleep(1000);
      const bubbleCountAfter = countMessageBubbles();
      if (bubbleCountAfter > bubbleCountBefore) {
        // Confirmed: new message bubble appeared
        return { success: true, verified: true };
      }

      // Bubble didn't appear — could be a silent failure or slow render
      // Wait a bit more and check again
      await sleep(2000);
      const bubbleCountFinal = countMessageBubbles();
      if (bubbleCountFinal > bubbleCountBefore) {
        return { success: true, verified: true };
      }

      // Input is empty but no new bubble — possible silent block
      if (attempt === 2) {
        return { success: true, verified: false, warning: 'Input cleared but message bubble not detected — possible silent block' };
      }

      await sleep(1000);
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
    input.focus();
    await sleep(300);

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
      // Clear existing content
      input.focus();
      input.innerHTML = '';
      input.textContent = '';
      await sleep(200);

      // Split message by line breaks and insert each line with Shift+Enter between them
      const lines = message.split(/\n/);

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > 0) {
          // Use execCommand to insert text — this triggers React's synthetic event system
          document.execCommand('insertText', false, lines[i]);
          await sleep(50);
        }

        // Insert line break between lines (not after the last line)
        if (i < lines.length - 1) {
          // Simulate Shift+Enter to create a line break in Instagram's input
          input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            shiftKey: true, bubbles: true, cancelable: true
          }));
          // Also try inserting a <br> via execCommand as fallback
          document.execCommand('insertLineBreak');
          await sleep(50);
        }
      }

      // Dispatch input event to ensure React picks up the change
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: null
      }));
    }

    // Wait and verify text was inserted
    await sleep(500);
    const content = input.textContent || input.innerText || input.value || '';
    if (content.trim().length === 0) {
      // Retry with clipboard paste approach
      await retryWithClipboard(input, message);
    }
  }

  async function retryWithClipboard(input, message) {
    // Fallback: use clipboard API to paste the message
    input.focus();
    input.innerHTML = '';
    await sleep(200);

    try {
      // Convert line breaks to actual line breaks for clipboard
      const clipText = message;
      await navigator.clipboard.writeText(clipText);
      // Simulate Ctrl+V / Cmd+V paste
      document.execCommand('paste');
      await sleep(300);

      // If paste didn't work, try DataTransfer approach
      const content = input.textContent || input.innerText || '';
      if (content.trim().length === 0) {
        const dt = new DataTransfer();
        dt.setData('text/plain', message);
        input.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true
        }));
        await sleep(300);
      }
    } catch (e) {
      // Final fallback: set innerHTML directly with <br> for line breaks
      const htmlContent = message
        .split('\n')
        .map(line => `<span>${line || '<br>'}</span>`)
        .join('<br>');
      input.innerHTML = htmlContent;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
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
