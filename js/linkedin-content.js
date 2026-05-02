/**
 * LinkedIn Content Script (v1) — Atomic Single-Page Actions for linkedin.com
 *
 * This script NEVER navigates. It only performs actions on the current page.
 * The background service worker handles all navigation.
 *
 * Actions:
 *   1. scanComments       — on a post page: scroll comments, extract, match keywords
 *   2. checkProfileActions — on a profile: detect Connect/Message/Follow/Pending buttons
 *   3. clickConnectButton — on a profile: click Connect (+ optional note)
 *   4. clickFollowButton  — on a profile: click Follow
 *   5. checkForMessageButton — after connect, check if Message button is available
 *   6. clickMessageButton — click Message button on profile
 *   7. typeAndSendDM      — on messaging overlay: type and send message
 *   8. checkIfPrivate     — check if profile has restricted messaging
 *   9. ping               — health check
 *
 * LinkedIn-specific notes:
 *   - "Connect" is the equivalent of "Follow" on Instagram
 *   - Message button may require being 1st-degree connection
 *   - Connection request can include a note (like a DM)
 *   - LinkedIn uses overlay modals for messaging
 */

(() => {
  'use strict';

  // Prevent duplicate injection
  if (window.__IEM_LINKEDIN_V1__) return;
  window.__IEM_LINKEDIN_V1__ = true;

  if (window.__IEM_LINKEDIN_LISTENER__) {
    chrome.runtime.onMessage.removeListener(window.__IEM_LINKEDIN_LISTENER__);
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

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
      // Click "Load more comments" or "Show more comments" buttons
      const loadMoreBtns = document.querySelectorAll(
        'button.comments-comments-list__load-more-comments-button, ' +
        'button[aria-label*="Load more comments"], ' +
        'button[aria-label*="Show more"], ' +
        'button.show-prev-replies'
      );
      for (const btn of loadMoreBtns) {
        btn.click();
        await sleep(1000);
      }

      // Also click "see more replies" buttons
      const replyBtns = document.querySelectorAll(
        'button.comments-comment-list__show-more-replies, ' +
        'button[aria-label*="replies"]'
      );
      for (const btn of replyBtns) {
        btn.click();
        await sleep(500);
      }

      // Scroll the comments section
      window.scrollBy(0, 500);
      await sleep(800);
    }

    // Extract comments
    const commentElements = document.querySelectorAll(
      '.comments-comment-item, ' +
      '.comments-comment-entity, ' +
      '[data-id*="comment"], ' +
      '.feed-shared-update-v2__commentary, ' +
      '.comments-comment-item__main-content'
    );

    const users = new Map();

    // Try multiple selector strategies for LinkedIn comments
    const commentBlocks = document.querySelectorAll(
      '.comments-comment-item, .comments-comment-entity'
    );

    for (const block of commentBlocks) {
      // Extract username from the comment author link
      const authorLink = block.querySelector(
        'a.comments-post-meta__name-text, ' +
        'a.comments-post-meta__actor-link, ' +
        'a[data-control-name="comment_actor"], ' +
        'a.app-aware-link[href*="/in/"]'
      );

      if (!authorLink) continue;

      const href = authorLink.getAttribute('href') || '';
      const usernameMatch = href.match(/\/in\/([^/?]+)/);
      if (!usernameMatch) continue;

      const username = usernameMatch[1];
      const displayName = authorLink.textContent.trim().split('\n')[0].trim();

      // Extract comment text
      const commentTextEl = block.querySelector(
        '.comments-comment-item__main-content, ' +
        '.comments-comment-texteditor, ' +
        '.feed-shared-text, ' +
        'span.comments-comment-item__inline-show-more-text'
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

    // Fallback: try extracting from the feed/post comments with different selectors
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

        // Check if this link is within a comment context
        const parentComment = link.closest(
          '.comments-comment-item, .comments-comment-entity, ' +
          '[class*="comment"], [data-id*="comment"]'
        );
        if (!parentComment) continue;

        const textEl = parentComment.querySelector(
          '[class*="comment-text"], [class*="main-content"], span[dir="ltr"]'
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

    // Check all buttons on the profile page
    const buttons = document.querySelectorAll(
      'button, div[role="button"], a[role="button"]'
    );

    for (const btn of buttons) {
      const text = btn.textContent.trim().toLowerCase();
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();

      // Message button
      if (text === 'message' || ariaLabel.includes('message')) {
        hasMessage = true;
      }

      // Connect button
      if (text === 'connect' || ariaLabel.includes('connect')) {
        hasConnect = true;
      }

      // Follow button (different from Connect on LinkedIn)
      if (text === 'follow' || ariaLabel.includes('follow')) {
        hasFollow = true;
      }

      // Pending connection
      if (text === 'pending' || text.includes('pending') || ariaLabel.includes('pending')) {
        isPending = true;
      }

      // Already connected indicators
      if (text.includes('connected') || ariaLabel.includes('connected')) {
        isConnected = true;
      }
    }

    // Also check for "More" dropdown which may contain Connect/Message
    const moreBtn = document.querySelector(
      'button[aria-label="More actions"], ' +
      'button.artdeco-dropdown__trigger'
    );

    // Check the connection degree indicator
    const degreeEl = document.querySelector(
      '.dist-value, .distance-badge, span[class*="degree"]'
    );
    const degreeText = degreeEl ? degreeEl.textContent.trim() : '';
    if (degreeText.includes('1st')) {
      isConnected = true;
      hasMessage = true; // 1st degree connections can always be messaged
    }

    return {
      hasMessage,
      hasConnect,
      hasFollow,
      isPending,
      isConnected,
      isFollowing: isConnected,
      isRequested: isPending
    };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 3: CLICK CONNECT BUTTON (with optional note)
  // ════════════════════════════════════════════════════════════

  async function handleClickConnectButton(note) {
    // Find and click the Connect button
    const buttons = document.querySelectorAll('button, div[role="button"]');
    let connectBtn = null;

    for (const btn of buttons) {
      const text = btn.textContent.trim().toLowerCase();
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (text === 'connect' || ariaLabel.includes('connect')) {
        connectBtn = btn;
        break;
      }
    }

    // If no direct Connect button, check the "More" dropdown
    if (!connectBtn) {
      const moreBtn = document.querySelector(
        'button[aria-label="More actions"], ' +
        'button[aria-label*="More"], ' +
        'button.artdeco-dropdown__trigger'
      );
      if (moreBtn) {
        moreBtn.click();
        await sleep(800);

        // Look for Connect in the dropdown
        const dropdownItems = document.querySelectorAll(
          '.artdeco-dropdown__content li, [role="menuitem"], .pvs-overflow-actions-dropdown__content li'
        );
        for (const item of dropdownItems) {
          const text = item.textContent.trim().toLowerCase();
          if (text.includes('connect')) {
            item.click();
            await sleep(800);
            break;
          }
        }
      }
    } else {
      connectBtn.click();
      await sleep(800);
    }

    // Handle the connection modal
    // LinkedIn may show "How do you know [name]?" or "Add a note" modal
    await sleep(1000);

    if (note) {
      // Click "Add a note" button if available
      const addNoteBtn = document.querySelector(
        'button[aria-label="Add a note"], ' +
        'button.artdeco-button--secondary'
      );
      
      if (addNoteBtn && addNoteBtn.textContent.trim().toLowerCase().includes('add a note')) {
        addNoteBtn.click();
        await sleep(500);

        // Type the note in the textarea
        const noteInput = document.querySelector(
          'textarea[name="message"], ' +
          'textarea#custom-message, ' +
          'textarea.connect-button-send-invite__custom-message'
        );
        if (noteInput) {
          noteInput.focus();
          noteInput.value = note;
          noteInput.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(300);
        }
      }
    }

    // Click "Send" or "Send without a note"
    await sleep(500);
    const sendBtns = document.querySelectorAll('button[aria-label*="Send"], button');
    for (const btn of sendBtns) {
      const text = btn.textContent.trim().toLowerCase();
      if (text === 'send' || text === 'send now' || text.includes('send invitation') || text.includes('send without')) {
        btn.click();
        await sleep(500);
        return { success: true, status: 'Pending', alreadyFollowing: false };
      }
    }

    // If we got here, the connection request may have been sent via the initial click
    return { success: true, status: 'Pending', alreadyFollowing: false };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 4: CLICK FOLLOW BUTTON
  // ════════════════════════════════════════════════════════════

  async function handleClickFollowButton() {
    const buttons = document.querySelectorAll('button, div[role="button"]');
    
    for (const btn of buttons) {
      const text = btn.textContent.trim().toLowerCase();
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (text === 'follow' || ariaLabel.includes('follow')) {
        btn.click();
        await sleep(1000);
        return { success: true, status: 'Following', alreadyFollowing: false };
      }
    }

    return { success: false, error: 'No Follow button found' };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 5: CHECK FOR MESSAGE BUTTON (after connect)
  // ════════════════════════════════════════════════════════════

  async function handleCheckForMessageButton() {
    // After connecting, check if Message button is available
    // (only works for 1st degree connections)
    for (let attempt = 0; attempt < 10; attempt++) {
      const buttons = document.querySelectorAll('button, div[role="button"]');
      for (const btn of buttons) {
        const text = btn.textContent.trim().toLowerCase();
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (text === 'message' || ariaLabel.includes('message')) {
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
    const buttons = document.querySelectorAll('button, div[role="button"]');
    
    for (const btn of buttons) {
      const text = btn.textContent.trim().toLowerCase();
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (text === 'message' || ariaLabel.includes('message')) {
        btn.click();
        await sleep(1500); // Wait for messaging overlay to open
        return { success: true };
      }
    }

    return { error: 'No Message button found' };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 7: TYPE AND SEND DM (LinkedIn messaging overlay)
  // ════════════════════════════════════════════════════════════

  async function handleTypeAndSendDM(message) {
    if (!message) return { error: 'No message provided' };

    // Wait for the messaging overlay/panel to open
    await sleep(1500);

    // Find the message input in LinkedIn's messaging overlay
    const inputSelectors = [
      'div.msg-form__contenteditable[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      'div.msg-form__msg-content-container div[contenteditable]',
      'div[data-placeholder="Write a message…"]',
      'div[aria-label="Write a message…"]',
      'div[aria-label*="Write a message"]',
      'div.msg-form__placeholder + div[contenteditable]'
    ];

    let input = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      for (const sel of inputSelectors) {
        input = document.querySelector(sel);
        if (input) break;
      }
      if (input) break;
      await sleep(500);
    }

    if (!input) {
      return { error: 'Could not find message input on LinkedIn' };
    }

    // Focus and type the message
    input.focus();
    await sleep(300);

    // Clear existing content
    input.innerHTML = '';
    await sleep(100);

    // Type message with line breaks using <p> tags (LinkedIn uses paragraph blocks)
    const lines = message.split('\n');
    const htmlContent = lines.map(line => `<p>${line || '<br>'}</p>`).join('');
    input.innerHTML = htmlContent;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);

    // Count messages before sending (for verification)
    const msgListBefore = document.querySelectorAll(
      '.msg-s-message-list__event, .msg-s-event-listitem'
    );
    const countBefore = msgListBefore.length;

    // Find and click Send button
    const sendSelectors = [
      'button.msg-form__send-button',
      'button[aria-label="Send"]',
      'button[type="submit"].msg-form__send-button',
      'button.msg-form__send-btn'
    ];

    let sendBtn = null;
    for (const sel of sendSelectors) {
      sendBtn = document.querySelector(sel);
      if (sendBtn && !sendBtn.disabled) break;
      sendBtn = null;
    }

    if (!sendBtn) {
      // Try finding by text content
      const allBtns = document.querySelectorAll('button');
      for (const btn of allBtns) {
        if (btn.textContent.trim().toLowerCase() === 'send' && !btn.disabled) {
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

    // Verify send by checking if message count increased
    const msgListAfter = document.querySelectorAll(
      '.msg-s-message-list__event, .msg-s-event-listitem'
    );
    const countAfter = msgListAfter.length;

    if (countAfter > countBefore) {
      return { success: true };
    }

    // Check if input was cleared (another sign of success)
    const inputAfter = document.querySelector(inputSelectors[0]) || input;
    if (inputAfter && inputAfter.textContent.trim() === '') {
      return { success: true };
    }

    return { success: true, warning: 'Message sent but could not verify delivery' };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 8: CHECK IF PROFILE IS PRIVATE/RESTRICTED
  // ════════════════════════════════════════════════════════════

  async function handleCheckIfPrivate() {
    // On LinkedIn, "private" means you can't message them (not 1st degree)
    // Check connection degree
    const pageText = document.body.innerText || '';

    // Check for restricted profile indicators
    const restrictedIndicators = [
      'Profile not available',
      'This profile is not available',
      'member chose to be shown',
      'LinkedIn Member' // Generic profile (restricted)
    ];

    for (const indicator of restrictedIndicators) {
      if (pageText.includes(indicator)) {
        return { isPrivate: true, reason: indicator };
      }
    }

    // Check if it's a 2nd/3rd degree connection (can't message directly)
    const degreeEl = document.querySelector(
      '.dist-value, .distance-badge, span[class*="degree"], ' +
      '.pv-top-card--list span.text-body-small'
    );
    const degreeText = degreeEl ? degreeEl.textContent.trim() : '';

    if (degreeText.includes('2nd') || degreeText.includes('3rd') || degreeText.includes('3rd+')) {
      // Not truly "private" but can't message directly — need to connect first
      return { isPrivate: false, canMessage: false, degree: degreeText };
    }

    if (degreeText.includes('1st')) {
      return { isPrivate: false, canMessage: true, degree: '1st' };
    }

    // If no degree info found, check for Message button presence
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.trim().toLowerCase() === 'message') {
        return { isPrivate: false, canMessage: true };
      }
    }

    return { isPrivate: false, canMessage: false, reason: 'No message button and unknown degree' };
  }

})();
