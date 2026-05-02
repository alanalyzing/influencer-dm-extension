/**
 * X (Twitter) Content Script (v1) — Atomic Single-Page Actions for x.com
 *
 * This script NEVER navigates. It only performs actions on the current page.
 * The background service worker handles all navigation.
 *
 * Actions:
 *   1. scanComments        — on a tweet page: scroll replies, extract, match keywords
 *   2. checkProfileActions — on a profile: detect Follow/Following/Message buttons
 *   3. clickFollowButton   — on a profile: click Follow
 *   4. checkForMessageButton — check if DM button is available
 *   5. clickMessageButton  — click Message/DM button on profile
 *   6. typeAndSendDM       — in DM conversation: type and send message
 *   7. typeAndSendReply    — on a tweet: compose and send a reply (fallback when DMs closed)
 *   8. checkIfPrivate      — check if profile is protected/locked
 *   9. checkDMAvailability — check if user accepts DMs
 *  10. ping                — health check
 *
 * X-specific notes:
 *   - DMs are limited: user must follow you back OR have open DMs
 *   - If DMs are closed, the extension can reply to their tweet instead
 *   - Protected accounts can't have their tweets seen unless you follow them
 *   - X uses data-testid attributes extensively for element identification
 */

(() => {
  'use strict';

  // Prevent duplicate injection
  if (window.__IEM_X_V1__) return;
  window.__IEM_X_V1__ = true;

  if (window.__IEM_X_LISTENER__) {
    chrome.runtime.onMessage.removeListener(window.__IEM_X_LISTENER__);
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
      typeAndSendReply: () => handleTypeAndSendReply(msg.message, msg.tweetUrl),
      checkIfPrivate: () => handleCheckIfPrivate(),
      checkDMAvailability: () => handleCheckDMAvailability(),
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

  window.__IEM_X_LISTENER__ = messageListener;
  chrome.runtime.onMessage.addListener(messageListener);

  // ════════════════════════════════════════════════════════════
  //  ACTION 1: SCAN COMMENTS / REPLIES (on tweet page)
  // ════════════════════════════════════════════════════════════

  async function handleScanComments(msg) {
    const { keywords } = msg;
    const keywordList = keywords.map(k => k.toLowerCase().trim());

    // Wait for replies to load
    await sleep(2000);

    // Scroll to load more replies
    for (let i = 0; i < 15; i++) {
      window.scrollBy(0, 800);
      await sleep(1000);

      // Click "Show more replies" or "Show" buttons
      const showMoreBtns = document.querySelectorAll(
        '[data-testid="tweet"] button[role="button"], ' +
        'div[role="button"][tabindex="0"]'
      );
      for (const btn of showMoreBtns) {
        const text = btn.textContent.trim().toLowerCase();
        if (text.includes('show') && (text.includes('replies') || text.includes('more'))) {
          btn.click();
          await sleep(800);
        }
      }
    }

    // Extract replies
    const users = new Map();
    const tweetArticles = document.querySelectorAll('article[data-testid="tweet"]');

    // Skip the first article (it's the original tweet)
    const replies = Array.from(tweetArticles).slice(1);

    for (const article of replies) {
      // Extract username from the reply
      const usernameLink = article.querySelector(
        'a[href*="/"] div[dir="ltr"] > span'
      );
      
      // Try to find @username
      const allLinks = article.querySelectorAll('a[role="link"]');
      let username = '';
      let displayName = '';

      for (const link of allLinks) {
        const href = link.getAttribute('href') || '';
        if (href.match(/^\/[A-Za-z0-9_]+$/) && !href.includes('/status/')) {
          username = href.replace('/', '');
          displayName = link.textContent.trim();
          break;
        }
      }

      if (!username) {
        // Fallback: look for @handle text
        const spans = article.querySelectorAll('span');
        for (const span of spans) {
          const text = span.textContent.trim();
          if (text.startsWith('@')) {
            username = text.replace('@', '');
            break;
          }
        }
      }

      if (!username) continue;

      // Extract reply text
      const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
      const replyText = tweetTextEl ? tweetTextEl.textContent.trim() : '';

      // Check keyword match
      const textLower = replyText.toLowerCase();
      const matched = keywordList.some(kw => textLower.includes(kw));

      if (matched && !users.has(username)) {
        users.set(username, {
          username,
          displayName: displayName || username,
          commentText: replyText.substring(0, 200),
          profileUrl: `https://x.com/${username}`
        });
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
    let hasFollow = false;
    let isFollowing = false;
    let isProtected = false;
    let isRequested = false;

    // Check for the DM/Message icon button (envelope icon on profile)
    const dmBtn = document.querySelector(
      '[data-testid="sendDMFromProfile"], ' +
      'button[aria-label*="Message"], ' +
      'a[href*="/messages/compose"]'
    );
    if (dmBtn) {
      hasMessage = true;
    }

    // Check Follow/Following status
    const followBtn = document.querySelector(
      '[data-testid*="follow"], ' +
      '[data-testid*="Follow"]'
    );

    if (followBtn) {
      const testId = followBtn.getAttribute('data-testid') || '';
      const text = followBtn.textContent.trim().toLowerCase();
      const ariaLabel = (followBtn.getAttribute('aria-label') || '').toLowerCase();

      if (testId.includes('unfollow') || text.includes('following') || ariaLabel.includes('unfollow')) {
        isFollowing = true;
      } else if (text === 'follow' || testId.includes('follow')) {
        hasFollow = true;
      } else if (text === 'pending' || text.includes('pending')) {
        isRequested = true;
      }
    }

    // Check for protected account indicator
    const protectedIcon = document.querySelector(
      'svg[data-testid="icon-lock"], ' +
      '[data-testid="UserProfileHeader_Items"] svg[aria-label*="Protected"]'
    );
    if (protectedIcon) {
      isProtected = true;
    }

    // Also check page text for protected indicator
    const pageText = document.body.innerText || '';
    if (pageText.includes('These Tweets are protected') || pageText.includes('These posts are protected')) {
      isProtected = true;
    }

    return {
      hasMessage,
      hasFollow,
      hasConnect: false,
      isFollowing,
      isRequested,
      isPending: isRequested,
      isProtected,
      isConnected: isFollowing
    };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 3: CLICK FOLLOW BUTTON
  // ════════════════════════════════════════════════════════════

  async function handleClickFollowButton() {
    // Find the Follow button
    const followBtn = document.querySelector(
      '[data-testid*="follow"]:not([data-testid*="unfollow"])'
    );

    if (!followBtn) {
      // Fallback: find by text
      const buttons = document.querySelectorAll('button[role="button"], div[role="button"]');
      for (const btn of buttons) {
        const text = btn.textContent.trim().toLowerCase();
        if (text === 'follow') {
          btn.click();
          await sleep(1000);
          return { success: true, status: 'Following', alreadyFollowing: false };
        }
      }
      return { success: false, error: 'No Follow button found' };
    }

    const text = followBtn.textContent.trim().toLowerCase();
    if (text === 'following' || text === 'pending') {
      return { success: true, status: text === 'pending' ? 'Requested' : 'Following', alreadyFollowing: true };
    }

    followBtn.click();
    await sleep(1000);

    // Check if it changed to Following or Pending
    const updatedBtn = document.querySelector('[data-testid*="follow"]');
    if (updatedBtn) {
      const newText = updatedBtn.textContent.trim().toLowerCase();
      if (newText.includes('following')) {
        return { success: true, status: 'Following', alreadyFollowing: false };
      }
      if (newText.includes('pending')) {
        return { success: true, status: 'Requested', alreadyFollowing: false };
      }
    }

    return { success: true, status: 'Following', alreadyFollowing: false };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 4: CHECK FOR MESSAGE BUTTON
  // ════════════════════════════════════════════════════════════

  async function handleCheckForMessageButton() {
    for (let attempt = 0; attempt < 10; attempt++) {
      const dmBtn = document.querySelector(
        '[data-testid="sendDMFromProfile"], ' +
        'button[aria-label*="Message"], ' +
        'a[href*="/messages/compose"]'
      );
      if (dmBtn) {
        return { found: true };
      }
      await sleep(500);
    }
    return { found: false };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 5: CLICK MESSAGE BUTTON (opens DM compose)
  // ════════════════════════════════════════════════════════════

  async function handleClickMessageButton() {
    const dmBtn = document.querySelector(
      '[data-testid="sendDMFromProfile"], ' +
      'button[aria-label*="Message"]'
    );

    if (dmBtn) {
      dmBtn.click();
      await sleep(2000); // Wait for DM compose to open
      return { success: true };
    }

    // Try the compose link
    const composeLink = document.querySelector('a[href*="/messages/compose"]');
    if (composeLink) {
      composeLink.click();
      await sleep(2000);
      return { success: true };
    }

    return { error: 'No Message/DM button found on X profile' };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 6: TYPE AND SEND DM (in X DM conversation)
  // ════════════════════════════════════════════════════════════

  async function handleTypeAndSendDM(message) {
    if (!message) return { error: 'No message provided' };

    // Wait for DM input to appear
    await sleep(1500);

    // Find the DM input
    const inputSelectors = [
      '[data-testid="dmComposerTextInput"]',
      'div[data-testid="dmComposerTextInput"] [contenteditable="true"]',
      'div[role="textbox"][data-testid="dmComposerTextInput"]',
      'div[data-testid="DmScrollerContainer"] div[contenteditable="true"]',
      'div[aria-label*="Start a new message"] div[contenteditable="true"]',
      'div[data-testid="messageEntry"] div[contenteditable="true"]',
      'div[role="textbox"][aria-label*="message"]'
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
      return { error: 'Could not find DM input on X' };
    }

    // Focus and type
    input.focus();
    await sleep(300);

    // Clear existing content
    input.textContent = '';
    await sleep(100);

    // Type message line by line with Enter for line breaks
    const lines = message.split('\n');
    for (let i = 0; i < lines.length; i++) {
      // Use execCommand for contenteditable
      document.execCommand('insertText', false, lines[i]);
      if (i < lines.length - 1) {
        // Shift+Enter for line break within DM
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
        document.execCommand('insertLineBreak');
      }
      await sleep(50);
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(500);

    // Find and click Send button
    const sendBtn = document.querySelector(
      '[data-testid="dmComposerSendButton"], ' +
      'button[aria-label="Send"], ' +
      'div[role="button"][data-testid="dmComposerSendButton"]'
    );

    if (!sendBtn) {
      return { error: 'Send button not found in X DM' };
    }

    sendBtn.click();
    await sleep(2000);

    // Verify: check if input was cleared
    const inputAfter = document.querySelector(inputSelectors[0]) || input;
    if (inputAfter && inputAfter.textContent.trim() === '') {
      return { success: true };
    }

    return { success: true, warning: 'DM sent but could not verify delivery on X' };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 7: TYPE AND SEND REPLY (fallback when DMs closed)
  // ════════════════════════════════════════════════════════════

  async function handleTypeAndSendReply(message, tweetUrl) {
    if (!message) return { error: 'No reply message provided' };

    // We should be on the tweet page already
    await sleep(1500);

    // Find the reply input (tweet compose box on the tweet page)
    const replyInputSelectors = [
      'div[data-testid="tweetTextarea_0"] div[contenteditable="true"]',
      'div[data-testid="tweetTextarea_0"]',
      'div[role="textbox"][data-testid*="tweetTextarea"]',
      'div[aria-label*="Post your reply"]',
      'div[aria-label*="Tweet your reply"]',
      'div[data-testid="reply"] div[contenteditable="true"]'
    ];

    let input = null;

    // First, click the reply area to activate it
    const replyArea = document.querySelector(
      '[data-testid="tweetTextarea_0"], ' +
      'div[aria-label*="reply"], ' +
      'div[aria-label*="Reply"]'
    );
    if (replyArea) {
      replyArea.click();
      await sleep(800);
    }

    // Now find the active input
    for (let attempt = 0; attempt < 20; attempt++) {
      for (const sel of replyInputSelectors) {
        input = document.querySelector(sel);
        if (input && input.getAttribute('contenteditable') === 'true') break;
        input = null;
      }
      if (input) break;

      // Try clicking the reply button/area again
      const replyBtn = document.querySelector(
        '[data-testid="reply"], ' +
        'div[aria-label*="Reply"]'
      );
      if (replyBtn && attempt === 5) {
        replyBtn.click();
        await sleep(800);
      }
      await sleep(500);
    }

    if (!input) {
      return { error: 'Could not find reply input on X tweet page' };
    }

    // Focus and type
    input.focus();
    await sleep(300);
    input.textContent = '';
    await sleep(100);

    // Type the reply
    document.execCommand('insertText', false, message);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(500);

    // Find and click the Reply/Post button
    const postBtn = document.querySelector(
      '[data-testid="tweetButtonInline"], ' +
      '[data-testid="tweetButton"], ' +
      'button[data-testid="tweetButtonInline"]'
    );

    if (!postBtn) {
      return { error: 'Reply/Post button not found on X' };
    }

    postBtn.click();
    await sleep(2000);

    // Verify: check if input was cleared
    if (input.textContent.trim() === '' || input.textContent.trim() !== message) {
      return { success: true, method: 'reply' };
    }

    return { success: true, method: 'reply', warning: 'Reply posted but could not verify' };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 8: CHECK IF PROFILE IS PRIVATE/PROTECTED
  // ════════════════════════════════════════════════════════════

  async function handleCheckIfPrivate() {
    await sleep(1000);
    const pageText = document.body.innerText || '';

    // Check for protected account
    const protectedIndicators = [
      'These Tweets are protected',
      'These posts are protected',
      'This account\'s posts are protected',
      'Only approved followers can see'
    ];

    for (const indicator of protectedIndicators) {
      if (pageText.includes(indicator)) {
        return { isPrivate: true, reason: indicator };
      }
    }

    // Check for lock icon
    const lockIcon = document.querySelector(
      'svg[data-testid="icon-lock"], ' +
      '[aria-label*="Protected"], ' +
      '[aria-label*="protected"]'
    );
    if (lockIcon) {
      return { isPrivate: true, reason: 'Protected account (lock icon)' };
    }

    // Check for suspended/deactivated
    if (pageText.includes('Account suspended') || pageText.includes('doesn\'t exist')) {
      return { isPrivate: true, reason: 'Account suspended or does not exist' };
    }

    return { isPrivate: false };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 9: CHECK DM AVAILABILITY
  // ════════════════════════════════════════════════════════════

  async function handleCheckDMAvailability() {
    // Check if the DM button exists on the profile
    const dmBtn = document.querySelector(
      '[data-testid="sendDMFromProfile"], ' +
      'button[aria-label*="Message"]'
    );

    if (dmBtn) {
      // Check if it's disabled or has a tooltip about DMs being closed
      const isDisabled = dmBtn.disabled || dmBtn.getAttribute('aria-disabled') === 'true';
      if (isDisabled) {
        return { canDM: false, reason: 'DM button disabled — user has closed DMs' };
      }
      return { canDM: true };
    }

    // No DM button at all — DMs are closed
    return { canDM: false, reason: 'No DM button on profile — user has closed DMs' };
  }

})();
