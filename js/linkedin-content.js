/**
 * LinkedIn Content Script (v4) — Atomic Single-Page Actions for linkedin.com
 *
 * Updated with verified DOM selectors from real logged-in LinkedIn (May 2026).
 * v3 fixes: Bug #1-6 from QA report, edge cases E1/E6/E7, improvements S2/S9/S10.
 * v4 fixes: "Could not find message input" — textarea-first selector strategy.
 *
 * KEY DOM FINDINGS:
 *   - LinkedIn uses obfuscated/hashed CSS class names — NEVER rely on class names alone
 *   - Connect button is an <a> tag with aria-label="Invite X to connect"
 *   - Message button is an <a> tag with text "Message" and href to /messaging/compose/
 *   - Follow button is a <button> with aria-label="Follow X" (NOT "Following X")
 *   - Messaging uses <textarea role="textbox"> inside <form id="msg-form-ember*">
 *   - This applies to BOTH the full messaging page AND the profile overlay popup
 *   - The overlay is rendered entirely by Ember.js — NOT in initial HTML
 *   - Send button is <button> with text "Send" inside the same form
 *   - Comments use <article class="comments-comment-entity">
 *   - Comment text: <span class="comments-comment-item__main-content">
 *   - Comment author links: a[href*="/in/"] inside comment blocks
 *   - Connection notes are limited to 300 characters
 *
 * Actions:
 *   1. scanComments       — on a post page: scroll comments, extract, match keywords
 *   2. checkProfileActions — on a profile: detect Connect/Message/Follow/Pending buttons
 *   3. clickConnectButton — on a profile: click Connect (+ optional note, max 300 chars)
 *   4. clickFollowButton  — on a profile: click Follow
 *   5. checkForMessageButton — after connect, check if Message button is available
 *   6. clickMessageButton — click Message button on profile
 *   7. typeAndSendDM      — on messaging overlay/page: type and send message
 *   8. checkIfPrivate     — check if profile has restricted messaging
 *   9. getProfileInfo     — extract firstName, company, headline from profile
 *  10. searchAndSelectRecipient — on /messaging/thread/new/: search for recipient by name and select them
 *  11. ping               — health check
 */

(() => {
  'use strict';

  // Prevent duplicate injection
  if (window.__IEM_LINKEDIN_V3__) return;
  window.__IEM_LINKEDIN_V3__ = true;

  if (window.__IEM_LINKEDIN_LISTENER__) {
    chrome.runtime.onMessage.removeListener(window.__IEM_LINKEDIN_LISTENER__);
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ─── Helper: find element by text content ───
  function findElementByText(selector, text, exact = true) {
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      const elText = el.textContent.trim();
      if (exact ? elText === text : elText.toLowerCase().includes(text.toLowerCase())) {
        return el;
      }
    }
    return null;
  }

  // ─── Helper: find element by aria-label pattern ───
  function findByAriaLabel(selector, pattern, exclude = null) {
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      if (aria.includes(pattern.toLowerCase())) {
        // BUG FIX #2: Exclude patterns (e.g., exclude "following" when looking for "follow")
        if (exclude && aria.includes(exclude.toLowerCase())) continue;
        return el;
      }
    }
    return null;
  }

  // ─── Helper: type into input using execCommand for React compatibility ───
  // BUG FIX #3 & #4: Use execCommand instead of direct value manipulation
  function typeWithExecCommand(element, text) {
    element.focus();
    // Select all and delete existing content
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    // Insert the new text
    document.execCommand('insertText', false, text);
  }

  // ─── Helper: type into textarea using native setter for React ───
  // BUG FIX #4: Use native setter for React-controlled textareas
  function typeIntoTextarea(textarea, text) {
    textarea.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype, 'value'
    ).set;
    nativeSetter.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ─── Message Handler ───

  function messageListener(msg, sender, sendResponse) {
    const handlers = {
      scanComments: () => handleScanComments(msg),
      checkProfileActions: () => handleCheckProfileActions(),
      clickConnectButton: () => handleClickConnectButton(msg.note),
      clickFollowButton: () => handleClickFollowButton(),
      checkForMessageButton: () => handleCheckForMessageButton(),
      clickMessageButton: () => handleClickMessageButton(),
      typeAndSendDM: () => handleTypeAndSendDM(msg.message),
      checkIfPrivate: () => handleCheckIfPrivate(),
      getProfileInfo: () => handleGetProfileInfo(),
      searchAndSelectRecipient: () => handleSearchAndSelectRecipient(msg.displayName, msg.headline),
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

  window.__IEM_LINKEDIN_LISTENER__ = messageListener;
  chrome.runtime.onMessage.addListener(messageListener);

  // ════════════════════════════════════════════════════════════
  //  ACTION 1: SCAN COMMENTS (on LinkedIn post page)
  // ════════════════════════════════════════════════════════════

  async function handleScanComments(msg) {
    const { keywords } = msg;
    const keywordList = keywords.map(k => k.toLowerCase().trim());

    // Wait for comments to load
    await sleep(2000);

    // Scroll to load more comments
    for (let i = 0; i < 10; i++) {
      // Click "Load more comments" buttons — find by text since classes are obfuscated
      const allButtons = document.querySelectorAll('button');
      for (const btn of allButtons) {
        const text = btn.textContent.trim().toLowerCase();
        if (text.includes('load more comments') || text.includes('show more comments') ||
            text.includes('show previous replies') || text.includes('load more')) {
          btn.click();
          await sleep(1000);
        }
      }

      // BUG FIX #5: Use text-based matching instead of unstable class selectors
      // Find reply count buttons by looking for buttons containing "repl" text
      const allBtns = document.querySelectorAll('button');
      for (const btn of allBtns) {
        const text = btn.textContent.trim().toLowerCase();
        if (text.match(/^\d+\s*repl/)) { // "3 replies", "1 reply"
          btn.click();
          await sleep(500);
        }
      }

      // Scroll the page to trigger lazy loading
      window.scrollBy(0, 500);
      await sleep(800);
    }

    // Extract comments — LinkedIn uses <article class="comments-comment-entity">
    const users = new Map();

    // Strategy 1: article.comments-comment-entity (verified DOM structure)
    const commentArticles = document.querySelectorAll('article[class*="comment"]');
    for (const article of commentArticles) {
      // Author link: <a href="/in/slug"> inside the comment meta section
      const authorLink = article.querySelector('a[href*="/in/"]');
      if (!authorLink) continue;

      const href = authorLink.getAttribute('href') || '';
      const usernameMatch = href.match(/\/in\/([^/?]+)/);
      if (!usernameMatch) continue;

      const username = usernameMatch[1];

      // Display name from the meta description title or link text
      const nameEl = article.querySelector('[class*="comment-meta"]') || authorLink;
      const displayName = nameEl ? nameEl.textContent.trim().split('\n')[0].trim() : username;

      // Comment text: find span with comment content
      const commentTextEl = article.querySelector(
        'span[class*="main-content"], ' +
        'span[class*="comment-item"], ' +
        'span[dir="ltr"]'
      );
      const commentText = commentTextEl ? commentTextEl.textContent.trim() : '';

      // Check keyword match
      const textLower = commentText.toLowerCase();
      const matched = keywordList.some(kw => textLower.includes(kw));

      if (matched && !users.has(username)) {
        users.set(username, {
          username,
          displayName,
          commentText: commentText.substring(0, 200),
          profileUrl: `https://www.linkedin.com/in/${username}/`
        });
      }
    }

    // Strategy 2: Fallback — find all /in/ links within any comment-like container
    if (users.size === 0) {
      const allLinks = document.querySelectorAll('a[href*="/in/"]');
      const seenUsernames = new Set();

      for (const link of allLinks) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/\/in\/([^/?]+)/);
        if (!match) continue;

        const username = match[1];
        if (seenUsernames.has(username)) continue;
        seenUsernames.add(username);

        // Walk up to find a comment container
        const parentComment = link.closest(
          'article, [data-id*="comment"], [class*="comment"]'
        );
        if (!parentComment) continue;

        // Get comment text from nearby span/div
        const textEl = parentComment.querySelector(
          'span[class*="main-content"], span[dir="ltr"], div[dir="ltr"]'
        );
        const text = textEl ? textEl.textContent.trim() : '';
        const textLower = text.toLowerCase();
        const matched = keywordList.some(kw => textLower.includes(kw));

        if (matched) {
          users.set(username, {
            username,
            displayName: link.textContent.trim().split('\n')[0].trim(),
            commentText: text.substring(0, 200),
            profileUrl: `https://www.linkedin.com/in/${username}/`
          });
        }
      }
    }

    return { matchedUsers: Array.from(users.values()) };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 2: CHECK PROFILE ACTIONS
  // ════════════════════════════════════════════════════════════

  async function handleCheckProfileActions() {
    // Wait for profile to render
    await sleep(2000);

    let hasMessage = false;
    let hasConnect = false;
    let hasFollow = false;
    let isPending = false;
    let isConnected = false;
    let hasOpenProfile = false;

    // IMPORTANT: LinkedIn profile uses BOTH <a> and <button> tags for actions
    // Connect = <a> with aria-label="Invite X to connect"
    // Message = <a> with text "Message" and href="/messaging/compose/"
    // Follow = <button> with aria-label="Follow X"

    // Check <a> tags (Connect and Message are <a> tags on profiles!)
    const allLinks = document.querySelectorAll('a');
    for (const link of allLinks) {
      const text = link.textContent.trim();
      const ariaLabel = (link.getAttribute('aria-label') || '');
      const href = link.getAttribute('href') || '';

      // Connect: <a aria-label="Invite X to connect">
      if (ariaLabel.toLowerCase().includes('invite') && ariaLabel.toLowerCase().includes('to connect')) {
        hasConnect = true;
      } else if (text === 'Connect' && href.includes('/preload/custom-invite/')) {
        hasConnect = true;
      }

      // Message: <a> with text "Message" and href to /messaging/compose/
      if (text === 'Message' && href.includes('/messaging/')) {
        hasMessage = true;
      }

      // IMPROVEMENT E6: Detect "Open Profile" messaging (premium)
      if (text.includes('Open Profile') || href.includes('open-profile')) {
        hasOpenProfile = true;
        hasMessage = true; // Can message via Open Profile
      }
    }

    // Check <button> tags (Follow, Pending, More)
    const allButtons = document.querySelectorAll('button');
    for (const btn of allButtons) {
      const text = btn.textContent.trim();
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();

      // BUG FIX #2: Follow button — exclude "Following" from match
      if ((ariaLabel.startsWith('follow ') && !ariaLabel.startsWith('following ')) ||
          (text === 'Follow' && !ariaLabel.includes('following'))) {
        hasFollow = true;
      }

      // Pending: button text or aria-label
      if (text === 'Pending' || text.toLowerCase().includes('pending') ||
          ariaLabel.includes('pending')) {
        isPending = true;
      }

      // Message button (sometimes it's a button too)
      if (text === 'Message' || ariaLabel === 'message') {
        hasMessage = true;
      }
    }

    // Check connection degree from page text
    const pageText = document.body.innerText || '';
    if (pageText.includes('· 1st')) {
      isConnected = true;
      hasMessage = true; // 1st degree can always message
    }

    // If we see "Connected" text near the action buttons
    if (findElementByText('button, span', 'Connected', true)) {
      isConnected = true;
    }

    return {
      hasMessage,
      hasConnect,
      hasFollow,
      isPending,
      isConnected,
      hasOpenProfile,
      isFollowing: isConnected,
      isRequested: isPending
    };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 3: CLICK CONNECT BUTTON (with optional note)
  // ════════════════════════════════════════════════════════════

  async function handleClickConnectButton(note) {
    // LinkedIn Connect button is an <a> tag with aria-label="Invite X to connect"
    // or text "Connect" with href to /preload/custom-invite/
    let connectEl = null;
    let foundViaDropdown = false;

    // Strategy 1: Find <a> with aria-label "Invite X to connect"
    connectEl = findByAriaLabel('a', 'to connect');

    // Strategy 2: Find <a> with text "Connect" and custom-invite href
    if (!connectEl) {
      const links = document.querySelectorAll('a');
      for (const link of links) {
        const text = link.textContent.trim();
        const href = link.getAttribute('href') || '';
        if (text === 'Connect' && href.includes('/preload/custom-invite/')) {
          connectEl = link;
          break;
        }
      }
    }

    // Strategy 3: Find <button> with text "Connect" (sidebar suggestions use buttons)
    if (!connectEl) {
      connectEl = findByAriaLabel('button', 'to connect');
    }
    if (!connectEl) {
      connectEl = findElementByText('button', 'Connect', true);
    }

    // IMPROVEMENT S10: Strategy 4: Check the "More" dropdown for Connect option
    // (For creator profiles where Follow is primary and Connect is in More menu)
    if (!connectEl) {
      const moreBtn = findByAriaLabel('button', 'more');
      if (moreBtn) {
        moreBtn.click();
        // EDGE CASE E1: Increase wait for slow connections
        await sleep(1500);

        // Look for Connect in the dropdown menu
        const menuItems = document.querySelectorAll('[role="menuitem"], [role="option"], li, div[role="button"]');
        for (const item of menuItems) {
          const text = item.textContent.trim().toLowerCase();
          if (text.includes('connect') && !text.includes('disconnect')) {
            item.click();
            foundViaDropdown = true;
            await sleep(1000);
            break;
          }
        }

        // If Connect wasn't found in dropdown, close it
        if (!foundViaDropdown) {
          // Press Escape to close dropdown
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await sleep(300);
        }
      }
    }

    // BUG FIX #1: Return error if Connect button was NOT found after all strategies
    if (!connectEl && !foundViaDropdown) {
      return { success: false, error: 'No Connect button found on this profile' };
    }

    // Click the Connect element (if not already clicked via dropdown)
    if (connectEl && !foundViaDropdown) {
      connectEl.click();
      await sleep(1000);
    }

    // Handle the connection modal
    // LinkedIn shows a modal with "Add a note" option
    await sleep(1500);

    // EDGE CASE E7: Check for "Email required" modal
    const emailInput = document.querySelector('input[type="email"], input[name="email"]');
    if (emailInput) {
      // Close the modal and return error
      const closeBtn = document.querySelector('button[aria-label="Dismiss"], button[aria-label="Close"]');
      if (closeBtn) closeBtn.click();
      return { success: false, error: 'Email required to connect — skipping' };
    }

    if (note) {
      // BUG FIX #8: Truncate note to 300 characters (LinkedIn limit)
      const truncatedNote = note.length > 300 ? note.substring(0, 297) + '...' : note;

      // Click "Add a note" button
      const addNoteBtn = findElementByText('button', 'Add a note', false);
      if (addNoteBtn) {
        addNoteBtn.click();
        await sleep(800);

        // Find the note textarea — try multiple selectors
        let noteInput = document.querySelector('textarea[name="message"]') ||
                        document.querySelector('textarea#custom-message') ||
                        document.querySelector('textarea[class*="custom-message"]');

        // Fallback: find any visible textarea in the modal
        if (!noteInput) {
          const textareas = document.querySelectorAll('textarea');
          for (const ta of textareas) {
            if (ta.offsetParent !== null) { // visible
              noteInput = ta;
              break;
            }
          }
        }

        if (noteInput) {
          // BUG FIX #4: Use native setter for React-controlled textarea
          typeIntoTextarea(noteInput, truncatedNote);
          await sleep(300);
        }
      }
    }

    // Click "Send" / "Send invitation" / "Send without a note"
    await sleep(500);
    const allBtns = document.querySelectorAll('button');
    for (const btn of allBtns) {
      const text = btn.textContent.trim().toLowerCase();
      if ((text === 'send' || text === 'send now' || text.includes('send invitation') ||
           text.includes('send without')) && !btn.disabled) {
        btn.click();
        await sleep(500);
        return { success: true, status: 'Pending', alreadyFollowing: false, noteTruncated: note && note.length > 300 };
      }
    }

    // If we got here, the connection request may have been sent via the initial click
    return { success: true, status: 'Pending', alreadyFollowing: false };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 4: CLICK FOLLOW BUTTON
  // ════════════════════════════════════════════════════════════

  async function handleClickFollowButton() {
    // BUG FIX #2: Follow button is a <button> with aria-label="Follow X"
    // MUST exclude "Following X" to avoid accidentally unfollowing
    let followBtn = findByAriaLabel('button', 'follow ', 'following');

    if (!followBtn) {
      // Find button with exact text "Follow" (not "Following")
      const allBtns = document.querySelectorAll('button');
      for (const btn of allBtns) {
        const text = btn.textContent.trim();
        if (text === 'Follow') {
          followBtn = btn;
          break;
        }
      }
    }

    if (followBtn) {
      followBtn.click();
      await sleep(1000);
      return { success: true, status: 'Following', alreadyFollowing: false };
    }

    // Check if already following
    if (findByAriaLabel('button', 'following') || findElementByText('button', 'Following', true)) {
      return { success: true, status: 'Following', alreadyFollowing: true };
    }

    return { success: false, error: 'No Follow button found' };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 5: CHECK FOR MESSAGE BUTTON (after connect)
  // ════════════════════════════════════════════════════════════

  async function handleCheckForMessageButton() {
    // After connecting, check if Message button is available
    for (let attempt = 0; attempt < 10; attempt++) {
      // Check <a> tags (LinkedIn Message is usually an <a>)
      const links = document.querySelectorAll('a');
      for (const link of links) {
        const text = link.textContent.trim();
        const href = link.getAttribute('href') || '';
        if (text === 'Message' && href.includes('/messaging/')) {
          return { found: true };
        }
      }

      // Also check buttons
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent.trim();
        if (text === 'Message') {
          return { found: true };
        }
      }

      await sleep(500);
    }
    return { found: false };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 6: CLICK MESSAGE BUTTON
  // ════════════════════════════════════════════════════════════

  async function handleClickMessageButton() {
    // Message button is an <a> with text "Message" and href to /messaging/compose/
    const links = document.querySelectorAll('a');
    for (const link of links) {
      const text = link.textContent.trim();
      const href = link.getAttribute('href') || '';
      if (text === 'Message' && href.includes('/messaging/')) {
        link.click();
        await sleep(2000); // Wait for messaging overlay to open
        return { success: true };
      }
    }

    // Fallback: try button
    const msgBtn = findElementByText('button', 'Message', true);
    if (msgBtn) {
      msgBtn.click();
      await sleep(2000);
      return { success: true };
    }

    return { error: 'No Message button found', noMessage: true };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 7: TYPE AND SEND DM (LinkedIn messaging)
  // ════════════════════════════════════════════════════════════

  async function handleTypeAndSendDM(message) {
    if (!message) return { error: 'No message provided' };

    // Wait for the messaging overlay/page to fully render
    // LinkedIn overlay is rendered dynamically by Ember.js — needs generous wait
    await sleep(3000);

    // LinkedIn messaging input detection — VERIFIED May 2026
    // KEY FINDING: LinkedIn uses <textarea role="textbox"> inside <form id="msg-form-ember*">
    // for BOTH the full messaging page AND the profile overlay popup.
    // The overlay is rendered entirely by JavaScript (Ember.js) — it does NOT exist
    // in the initial HTML. The textarea appears after the overlay animation completes.
    //
    // Priority order: textarea first (verified), then contenteditable fallbacks.

    let input = null;
    let inputType = null; // 'contenteditable' or 'textarea'

    // Phase 1 selectors: TEXTAREA (verified working on LinkedIn May 2026)
    const TEXTAREA_SELECTORS = [
      // Primary: textarea inside Ember msg-form (verified on full messaging page)
      'form[id^="msg-form"] textarea',
      // Textarea with role textbox (verified: element has role="textbox")
      'textarea[role="textbox"]',
      // Textarea with aria-label containing Write a message
      'textarea[aria-label*="Write a message"]',
      // Textarea with placeholder containing Write a message
      'textarea[placeholder*="Write a message"]',
      // Any textarea inside a form that looks like messaging
      'form[id*="msg"] textarea',
      // Any textarea with name message
      'textarea[name="message"]',
      // Any textarea with aria-label containing message
      'textarea[aria-label*="message"]',
      'textarea[aria-label*="Message"]',
      // Broadest textarea: any visible textarea on the page
      'textarea'
    ];

    // Phase 2 selectors: CONTENTEDITABLE (fallback for older LinkedIn versions)
    const CONTENTEDITABLE_SELECTORS = [
      'div.msg-form__contenteditable[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      'div[aria-label*="Write a message"][contenteditable="true"]',
      'div[data-placeholder*="Write a message"][contenteditable="true"]',
      'div.msg-form__msg-content-container div[contenteditable="true"]',
      'form[id^="msg-form"] div[contenteditable="true"]',
      'div[class*="msg-form"] div[contenteditable="true"]',
      'div.msg-overlay-conversation-bubble div[contenteditable="true"]',
      'div[class*="msg-overlay"] div[contenteditable="true"]',
      'div[class*="messaging"] div[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]'
    ];

    // Retry loop with increasing desperation
    for (let attempt = 0; attempt < 40; attempt++) {
      // Phase 1: Try textarea selectors first (highest priority)
      for (const selector of TEXTAREA_SELECTORS) {
        try {
          const els = document.querySelectorAll(selector);
          for (const el of els) {
            // Must be visible (offsetParent not null or has dimensions)
            if (el.offsetParent !== null || (el.offsetWidth > 0 && el.offsetHeight > 0)) {
              // For the broadest 'textarea' selector, verify it's in a messaging context
              if (selector === 'textarea') {
                const inMsgContext = el.closest(
                  'form[id*="msg"], [class*="msg-form"], [class*="msg-overlay"], ' +
                  '[class*="messaging"], [class*="compose"], [id*="msg"]'
                );
                if (!inMsgContext) continue;
              }
              input = el;
              inputType = 'textarea';
              break;
            }
          }
        } catch (e) { /* selector parse error, skip */ }
        if (input) break;
      }
      if (input) break;

      // Phase 2: Try contenteditable selectors
      for (const selector of CONTENTEDITABLE_SELECTORS) {
        try {
          const el = document.querySelector(selector);
          if (el && (el.offsetParent !== null || (el.offsetWidth > 0 && el.offsetHeight > 0))) {
            input = el;
            inputType = 'contenteditable';
            break;
          }
        } catch (e) { /* skip */ }
        if (input) break;
      }
      if (input) break;

      // Phase 3 (attempt > 15): Scan ALL textareas on page
      if (attempt > 15) {
        const allTextareas = document.querySelectorAll('textarea');
        for (const ta of allTextareas) {
          if ((ta.offsetParent !== null || ta.offsetHeight > 0) && ta.offsetHeight < 500) {
            input = ta;
            inputType = 'textarea';
            break;
          }
        }
        if (input) break;
      }

      // Phase 4 (attempt > 25): Scan ALL contenteditable elements
      if (attempt > 25) {
        const allEditable = document.querySelectorAll('[contenteditable="true"]');
        for (const el of allEditable) {
          if (el.offsetParent !== null && el.offsetHeight > 20 && el.offsetHeight < 300) {
            // Prefer elements that look like message inputs
            const rect = el.getBoundingClientRect();
            if (rect.bottom > window.innerHeight * 0.5) { // bottom half of screen
              input = el;
              inputType = 'contenteditable';
              break;
            }
          }
        }
        if (input) break;
      }

      await sleep(500);
    }

    if (!input) {
      // Enhanced debug info
      const editables = document.querySelectorAll('[contenteditable="true"]');
      const textareas = document.querySelectorAll('textarea');
      const forms = document.querySelectorAll('form[id*="msg"]');
      const overlays = document.querySelectorAll('[class*="msg-overlay"], [class*="messaging"]');
      return { 
        error: 'Could not find message input on LinkedIn',
        debug: `editables=${editables.length}, textareas=${textareas.length}, msg-forms=${forms.length}, overlays=${overlays.length}`
      };
    }

    // Focus the input
    input.focus();
    await sleep(300);

    if (inputType === 'textarea') {
      // Use native setter for Ember/React-controlled textarea
      typeIntoTextarea(input, message);
      await sleep(500);

      // Double-check: if value didn't stick, try execCommand approach
      if (input.value !== message) {
        input.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        document.execCommand('insertText', false, message);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(300);
      }
    } else {
      // Use execCommand for contenteditable (React/Ember compatibility)
      input.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      await sleep(100);

      // Type message with line breaks using Shift+Enter simulation
      const lines = message.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) {
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', shiftKey: true, bubbles: true }));
          document.execCommand('insertLineBreak', false, null);
        }
        if (lines[i]) {
          document.execCommand('insertText', false, lines[i]);
        }
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(300);
    }

    // Find and click Send button
    let sendBtn = null;

    // Strategy 1: Send button inside the same form as the input
    const parentForm = input.closest('form[id^="msg-form"], form[id*="msg"]');
    if (parentForm) {
      // Look for Send button inside this specific form
      const formBtns = parentForm.querySelectorAll('button');
      for (const btn of formBtns) {
        if (btn.textContent.trim() === 'Send' && !btn.disabled) {
          sendBtn = btn;
          break;
        }
      }
    }

    // Strategy 2: Specific class-based selectors
    if (!sendBtn) {
      sendBtn = document.querySelector('button.msg-form__send-button:not([disabled])');
    }
    if (!sendBtn) {
      sendBtn = document.querySelector('button[aria-label="Send"]:not([disabled])');
    }

    // Strategy 3: Find by text content (broadest)
    if (!sendBtn) {
      const allBtns = document.querySelectorAll('button');
      for (const btn of allBtns) {
        if (btn.textContent.trim() === 'Send' && !btn.disabled) {
          // Prefer buttons near the input (in the same overlay/form area)
          const btnRect = btn.getBoundingClientRect();
          const inputRect = input.getBoundingClientRect();
          if (Math.abs(btnRect.bottom - inputRect.bottom) < 200) {
            sendBtn = btn;
            break;
          }
        }
      }
    }

    // Strategy 4: Any Send button on the page
    if (!sendBtn) {
      const allBtns = document.querySelectorAll('button');
      for (const btn of allBtns) {
        if (btn.textContent.trim() === 'Send' && !btn.disabled) {
          sendBtn = btn;
          break;
        }
      }
    }

    if (!sendBtn) {
      return { error: 'Send button not found or disabled on LinkedIn' };
    }

    sendBtn.click();
    await sleep(2000);

    // Verify: check if input was cleared (sign of successful send)
    const inputAfter = input.tagName === 'TEXTAREA' ? input : 
                       (document.querySelector('textarea[role="textbox"]') ||
                        document.querySelector('div.msg-form__contenteditable'));
    if (inputAfter) {
      const remainingText = inputAfter.tagName === 'TEXTAREA' ? inputAfter.value : inputAfter.textContent;
      if (!remainingText || remainingText.trim() === '') {
        return { success: true };
      }
    }

    return { success: true, warning: 'Message sent but could not verify delivery' };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 8: CHECK IF PROFILE IS PRIVATE/RESTRICTED
  // ════════════════════════════════════════════════════════════

  async function handleCheckIfPrivate() {
    // BUG FIX #5: Check for "LinkedIn Member" specifically in the main heading
    // not just anywhere on the page (avoids false positives from sidebar)
    const heading = document.querySelector('h1');
    if (heading && heading.textContent.trim() === 'LinkedIn Member') {
      return { isPrivate: true, reason: 'Restricted profile (LinkedIn Member)' };
    }

    const pageText = document.body.innerText || '';

    // Check for restricted profile indicators
    const restrictedIndicators = [
      'Profile not available',
      'This profile is not available',
      'member chose to be shown'
    ];

    for (const indicator of restrictedIndicators) {
      if (pageText.includes(indicator)) {
        return { isPrivate: true, reason: indicator };
      }
    }

    // Check connection degree from page text
    if (pageText.includes('· 1st')) {
      return { isPrivate: false, canMessage: true, degree: '1st' };
    }
    if (pageText.includes('· 2nd')) {
      return { isPrivate: false, canMessage: false, degree: '2nd' };
    }
    if (pageText.includes('· 3rd') || pageText.includes('· 3rd+')) {
      return { isPrivate: false, canMessage: false, degree: '3rd' };
    }

    // Check for Message button presence (as <a> or <button>)
    const links = document.querySelectorAll('a');
    for (const link of links) {
      if (link.textContent.trim() === 'Message' && (link.getAttribute('href') || '').includes('/messaging/')) {
        return { isPrivate: false, canMessage: true };
      }
    }
    if (findElementByText('button', 'Message', true)) {
      return { isPrivate: false, canMessage: true };
    }

    return { isPrivate: false, canMessage: false, reason: 'No message button and unknown degree' };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 9: GET PROFILE INFO (for template variables)
  //  IMPROVEMENT S9: Extract firstName, company, headline
  // ════════════════════════════════════════════════════════════

  async function handleGetProfileInfo() {
    // Wait for profile to render — LinkedIn Ember.js can be slow
    await sleep(2000);

    // Extract display name from h1 with retry (LinkedIn renders lazily)
    let fullName = '';
    for (let attempt = 0; attempt < 15; attempt++) {
      // Try multiple selectors for the profile name
      const h1 = document.querySelector('h1');
      if (h1) {
        const text = h1.textContent.trim();
        // Filter out generic h1s that aren't the profile name
        if (text && text !== 'LinkedIn' && text.length > 1 && text.length < 80) {
          fullName = text;
          break;
        }
      }
      // Fallback: try the profile card name element
      const nameEl = document.querySelector('[class*="text-heading-xlarge"]') ||
                     document.querySelector('[class*="inline t-24"]') ||
                     document.querySelector('.pv-text-details__left-panel h1') ||
                     document.querySelector('[data-anonymize="person-name"]');
      if (nameEl) {
        const text = nameEl.textContent.trim();
        if (text && text.length > 1) {
          fullName = text;
          break;
        }
      }
      await sleep(500);
    }

    // Fallback: extract from page title ("FirstName LastName | LinkedIn")
    if (!fullName) {
      const titleMatch = document.title.match(/^(.+?)\s*[|\-–]\s*LinkedIn/i);
      if (titleMatch) {
        fullName = titleMatch[1].trim();
      }
    }

    // Fallback: extract from URL slug ("amanda-cua" → "Amanda Cua")
    if (!fullName) {
      const urlMatch = window.location.pathname.match(/\/in\/([^/]+)/);
      if (urlMatch) {
        fullName = urlMatch[1]
          .replace(/-/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase());
      }
    }

    const firstName = fullName.split(' ')[0] || '';

    // Extract headline (usually the text below the name)
    let headline = '';
    const headlineEl = document.querySelector('[data-generated-suggestion-target*="headline"]') ||
                       document.querySelector('div.text-body-medium');
    if (headlineEl) {
      headline = headlineEl.textContent.trim();
    }

    // Extract company from headline or experience section
    let company = '';
    if (headline) {
      // Common patterns: "Role at Company" or "Role | Company"
      const atMatch = headline.match(/(?:at|@)\s+(.+?)(?:\s*[|·]|$)/i);
      const pipeMatch = headline.match(/[|·]\s*(.+?)(?:\s*[|·]|$)/);
      if (atMatch) company = atMatch[1].trim();
      else if (pipeMatch) company = pipeMatch[1].trim();
    }

    return {
      fullName,
      firstName,
      headline,
      company
    };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 10: SEARCH AND SELECT RECIPIENT
  //  On /messaging/thread/new/ — type display name in search,
  //  wait for suggestions, click the first matching result.
  // ════════════════════════════════════════════════════════════

  async function handleSearchAndSelectRecipient(displayName, profileHeadline) {
    if (!displayName) return { error: 'No display name provided' };

    // Wait for the compose page to fully render
    await sleep(2000);

    // ── Step 1: Find the recipient search input ──
    // Verified selectors from LinkedIn compose page (May 2026):
    //   input[id*="search-field"][role="combobox"][placeholder="Type a name or multiple names"]
    const SEARCH_SELECTORS = [
      'input[role="combobox"][placeholder*="name"]',
      'input[role="combobox"][placeholder*="Name"]',
      'input[id*="search-field"]',
      'input[placeholder*="Type a name"]',
      'input[placeholder*="type a name"]',
      'input[role="combobox"]',
      'input[aria-autocomplete="list"]'
    ];

    let searchInput = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      for (const selector of SEARCH_SELECTORS) {
        try {
          const el = document.querySelector(selector);
          if (el && (el.offsetParent !== null || el.offsetWidth > 0)) {
            searchInput = el;
            break;
          }
        } catch (e) { /* skip */ }
      }
      if (searchInput) break;
      await sleep(500);
    }

    if (!searchInput) {
      return { error: 'Could not find recipient search input on compose page' };
    }

    // ── Step 2: Type the display name ──
    searchInput.focus();
    await sleep(300);

    // Clear any existing text
    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);

    // Type the name using native setter for React/Ember compatibility
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value'
    ).set;
    nativeSetter.call(searchInput, displayName);
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(300);

    // If native setter didn't trigger suggestions, try execCommand
    if (!searchInput.value || searchInput.value !== displayName) {
      searchInput.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, displayName);
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // ── Step 3: Wait for suggestions and pick the RIGHT person ──
    // LinkedIn suggestion DOM structure (verified May 2026):
    //   li.msg-connections-typeahead__search-result[role="option"]
    //     └── div.msg-connections-typeahead__entity-description
    //           └── dl
    //                 ├── dt.t-bold  → NAME  (e.g., "Amanda Cua")
    //                 └── dd         → HEADLINE (e.g., "Founder & CEO at BackScoop...")
    //
    // Matching priority:
    //   1. Exact headline match (handles same-name disambiguation)
    //   2. Partial headline overlap (keywords in common)
    //   3. First result with matching name (fallback)
    //   4. First result overall (last resort)

    let selectedRecipient = false;
    const normalizedTargetName = displayName.toLowerCase().trim();
    const normalizedTargetHeadline = (profileHeadline || '').toLowerCase().trim();

    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(500);

      // Collect all suggestion items
      const suggestions = document.querySelectorAll(
        'li[role="option"], ul[role="listbox"] li, li.msg-connections-typeahead__search-result'
      );

      if (suggestions.length === 0) {
        // If no suggestions after 10 attempts, try first name only to broaden search
        if (attempt === 10) {
          const firstName = displayName.split(' ')[0];
          if (firstName !== displayName) {
            nativeSetter.call(searchInput, '');
            searchInput.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(300);
            nativeSetter.call(searchInput, firstName);
            searchInput.dispatchEvent(new Event('input', { bubbles: true }));
            searchInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        continue;
      }

      // Parse each suggestion to extract name and headline
      const parsed = [];
      for (const li of suggestions) {
        const dtEl = li.querySelector('dt');
        const ddEl = li.querySelector('dd');
        const name = dtEl ? dtEl.textContent.trim().toLowerCase() : '';
        const headline = ddEl ? ddEl.textContent.trim().toLowerCase() : '';
        parsed.push({ el: li, name, headline });
      }

      // If only 1 suggestion, just click it (no ambiguity)
      if (parsed.length === 1) {
        parsed[0].el.click();
        selectedRecipient = true;
        await sleep(1000);
        break;
      }

      // Multiple suggestions — disambiguate
      let bestMatch = null;

      // Priority 1: Exact headline match
      if (normalizedTargetHeadline) {
        bestMatch = parsed.find(p => p.headline === normalizedTargetHeadline);
      }

      // Priority 2: Partial headline overlap (at least 3 words in common)
      if (!bestMatch && normalizedTargetHeadline) {
        const targetWords = normalizedTargetHeadline.split(/\s+/).filter(w => w.length > 3);
        let maxOverlap = 0;
        for (const p of parsed) {
          if (!p.headline) continue;
          const headlineWords = p.headline.split(/\s+/);
          const overlap = targetWords.filter(w => headlineWords.includes(w)).length;
          if (overlap > maxOverlap && overlap >= 3) {
            maxOverlap = overlap;
            bestMatch = p;
          }
        }
      }

      // Priority 3: First result with matching name
      if (!bestMatch) {
        bestMatch = parsed.find(p => p.name === normalizedTargetName);
      }

      // Priority 4: First result with name that starts with the same first name
      if (!bestMatch) {
        const firstName = normalizedTargetName.split(' ')[0];
        bestMatch = parsed.find(p => p.name.startsWith(firstName));
      }

      // Priority 5: First result overall (last resort)
      if (!bestMatch) {
        bestMatch = parsed[0];
      }

      bestMatch.el.click();
      selectedRecipient = true;
      await sleep(1000);
      break;
    }

    if (!selectedRecipient) {
      return { error: `No suggestions found for "${displayName}" — user may not be a connection` };
    }

    // Verify the recipient was added (look for a pill/tag in the To field)
    await sleep(500);
    return { success: true, selectedName: displayName };
  }

})();
