/**
 * X (Twitter) Content Script (v2) — Atomic Single-Page Actions for x.com
 *
 * Updated with verified DOM selectors from real logged-in X (May 2026).
 *
 * KEY DOM FINDINGS:
 *   - X uses data-testid attributes extensively — very reliable selectors
 *   - Follow button: button[data-testid$="-follow"] or button[aria-label^="Follow @"]
 *   - DM button on profile: button[aria-label="Message"] (NO data-testid!)
 *   - Tweet: article[data-testid="tweet"]
 *   - Tweet text: div[data-testid="tweetText"]
 *   - Reply input: div[data-testid="tweetTextarea_0"][role="textbox"] (contenteditable)
 *   - Reply send: button[data-testid="tweetButtonInline"]
 *   - DM compose input: div[data-testid="dmComposerTextInput"] (contenteditable)
 *   - DM send: button[data-testid="dmComposerSendButton"]
 *   - User-Name: div[data-testid="User-Name"]
 *   - UserAvatar: div[data-testid="UserAvatar-Container-{username}"]
 *   - DM new chat: button[data-testid="dm-new-chat-button"]
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
 */

(() => {
  'use strict';

  // Prevent duplicate injection
  if (window.__IEM_X_V2__) return;
  window.__IEM_X_V2__ = true;

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
      const allButtons = document.querySelectorAll('button[role="button"], div[role="button"]');
      for (const btn of allButtons) {
        const text = btn.textContent.trim().toLowerCase();
        if (text.includes('show') && (text.includes('replies') || text.includes('more'))) {
          btn.click();
          await sleep(800);
        }
      }
    }

    // Extract replies — each reply is an <article data-testid="tweet">
    const users = new Map();
    const tweetArticles = document.querySelectorAll('article[data-testid="tweet"]');

    // Skip the first article (it's the original tweet)
    const replies = Array.from(tweetArticles).slice(1);

    for (const article of replies) {
      let username = '';
      let displayName = '';

      // Strategy 1: Use UserAvatar-Container data-testid to extract username
      const avatarEl = article.querySelector('div[data-testid^="UserAvatar-Container-"]');
      if (avatarEl) {
        const testId = avatarEl.getAttribute('data-testid') || '';
        username = testId.replace('UserAvatar-Container-', '');
      }

      // Strategy 2: Find @username from User-Name div
      if (!username) {
        const userNameDiv = article.querySelector('div[data-testid="User-Name"]');
        if (userNameDiv) {
          const spans = userNameDiv.querySelectorAll('span');
          for (const span of spans) {
            const text = span.textContent.trim();
            if (text.startsWith('@')) {
              username = text.replace('@', '');
              break;
            }
          }
          // Get display name from first link text
          const nameLink = userNameDiv.querySelector('a[role="link"]');
          if (nameLink) {
            displayName = nameLink.textContent.trim().split('\n')[0].trim();
          }
        }
      }

      // Strategy 3: Find profile links
      if (!username) {
        const allLinks = article.querySelectorAll('a[role="link"]');
        for (const link of allLinks) {
          const href = link.getAttribute('href') || '';
          if (href.match(/^\/[A-Za-z0-9_]+$/) && !href.includes('/status/')) {
            username = href.replace('/', '');
            displayName = link.textContent.trim();
            break;
          }
        }
      }

      if (!username) continue;

      // Extract reply text using data-testid="tweetText"
      const tweetTextEl = article.querySelector('div[data-testid="tweetText"]');
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

    // Check for DM/Message button — button[aria-label="Message"] (NO data-testid!)
    const dmBtn = document.querySelector('button[aria-label="Message"]');
    if (dmBtn) {
      hasMessage = true;
    }

    // Check Follow button — button[data-testid$="-follow"] or button[aria-label^="Follow @"]
    const followBtn = document.querySelector('button[data-testid$="-follow"]') ||
                      document.querySelector('button[aria-label^="Follow @"]');

    if (followBtn) {
      const text = followBtn.textContent.trim().toLowerCase();
      const ariaLabel = (followBtn.getAttribute('aria-label') || '').toLowerCase();
      const testId = (followBtn.getAttribute('data-testid') || '').toLowerCase();

      if (text === 'follow' && !testId.includes('unfollow') && !ariaLabel.includes('unfollow')) {
        hasFollow = true;
      }
    }

    // Check Following/Unfollow button — button[data-testid$="-unfollow"]
    const unfollowBtn = document.querySelector('button[data-testid$="-unfollow"]') ||
                        document.querySelector('button[aria-label^="Following @"]');
    if (unfollowBtn) {
      isFollowing = true;
    }

    // Check for Pending state
    const allButtons = document.querySelectorAll('button');
    for (const btn of allButtons) {
      const text = btn.textContent.trim().toLowerCase();
      if (text === 'pending') {
        isRequested = true;
        break;
      }
    }

    // Check for protected account — look for lock icon or protected text
    const pageText = document.body.innerText || '';
    if (pageText.includes('These posts are protected') ||
        pageText.includes('These Tweets are protected') ||
        pageText.includes("This account's posts are protected")) {
      isProtected = true;
    }

    // Also check for lock icon via aria-label
    const lockIcon = document.querySelector(
      'svg[aria-label*="Protected"], svg[aria-label*="protected"]'
    );
    if (lockIcon) {
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
    // Find Follow button using verified selectors
    let followBtn = document.querySelector('button[data-testid$="-follow"]:not([data-testid$="-unfollow"])');
    if (!followBtn) {
      followBtn = document.querySelector('button[aria-label^="Follow @"]');
    }

    if (!followBtn) {
      // Fallback: find by text content
      const buttons = document.querySelectorAll('button[role="button"]');
      for (const btn of buttons) {
        if (btn.textContent.trim() === 'Follow') {
          followBtn = btn;
          break;
        }
      }
    }

    if (!followBtn) {
      // Check if already following
      const unfollowBtn = document.querySelector('button[data-testid$="-unfollow"]');
      if (unfollowBtn) {
        return { success: true, status: 'Following', alreadyFollowing: true };
      }
      return { success: false, error: 'No Follow button found' };
    }

    const text = followBtn.textContent.trim().toLowerCase();
    if (text === 'following' || text === 'pending') {
      return { success: true, status: text === 'pending' ? 'Requested' : 'Following', alreadyFollowing: true };
    }

    followBtn.click();
    await sleep(1500);

    // Verify: check if button changed to Following or Pending
    const updatedBtn = document.querySelector('button[data-testid$="-unfollow"]') ||
                       document.querySelector('button[aria-label^="Following @"]');
    if (updatedBtn) {
      return { success: true, status: 'Following', alreadyFollowing: false };
    }

    // Check for Pending
    const allButtons = document.querySelectorAll('button');
    for (const btn of allButtons) {
      if (btn.textContent.trim().toLowerCase() === 'pending') {
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
      // Primary: button[aria-label="Message"] (verified — no data-testid!)
      const dmBtn = document.querySelector('button[aria-label="Message"]');
      if (dmBtn && !dmBtn.disabled) {
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
    // Primary: button[aria-label="Message"] (verified)
    const dmBtn = document.querySelector('button[aria-label="Message"]');

    if (dmBtn) {
      dmBtn.click();
      await sleep(2000); // Wait for DM compose to open
      return { success: true };
    }

    return { error: 'No Message/DM button found on X profile' };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 6: TYPE AND SEND DM (in X DM conversation)
  // ════════════════════════════════════════════════════════════

  async function handleTypeAndSendDM(message) {
    if (!message) return { error: 'No message provided' };

    // Wait for DM compose to appear
    await sleep(2000);

    // Find the DM input — data-testid="dmComposerTextInput" (verified)
    const inputSelectors = [
      'div[data-testid="dmComposerTextInput"]',
      'div[data-testid="dmComposerTextInput"] div[contenteditable="true"]',
      'div[data-testid="dmComposerTextInput"] div[role="textbox"]',
      'div[role="textbox"][data-testid="dmComposerTextInput"]',
      // Fallback selectors
      'aside div[role="textbox"][contenteditable="true"]',
      'div[data-testid="DmScrollerContainer"] div[contenteditable="true"]'
    ];

    let input = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      for (const sel of inputSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          // If the element itself is contenteditable, use it
          if (el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox') {
            input = el;
            break;
          }
          // Otherwise look for a contenteditable child
          const child = el.querySelector('[contenteditable="true"], [role="textbox"]');
          if (child) {
            input = child;
            break;
          }
        }
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

    // Type message using execCommand for contenteditable compatibility
    const lines = message.split('\n');
    for (let i = 0; i < lines.length; i++) {
      document.execCommand('insertText', false, lines[i]);
      if (i < lines.length - 1) {
        // Shift+Enter for line break within DM
        const enterEvent = new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13,
          shiftKey: true, bubbles: true, cancelable: true
        });
        input.dispatchEvent(enterEvent);
        document.execCommand('insertLineBreak');
      }
      await sleep(50);
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(500);

    // Find and click Send button — data-testid="dmComposerSendButton" (verified)
    let sendBtn = document.querySelector('button[data-testid="dmComposerSendButton"]');
    if (!sendBtn) {
      sendBtn = document.querySelector('button[aria-label="Send"]');
    }

    if (!sendBtn) {
      return { error: 'Send button not found in X DM' };
    }

    sendBtn.click();
    await sleep(2000);

    // Verify: check if input was cleared
    const inputAfter = document.querySelector('div[data-testid="dmComposerTextInput"]') || input;
    const afterText = inputAfter.textContent || inputAfter.innerText || '';
    if (afterText.trim() === '') {
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

    // First, click the reply area to activate it
    // The reply input is: div[data-testid="tweetTextarea_0"] (verified)
    let replyArea = document.querySelector('div[data-testid="tweetTextarea_0"]');
    if (replyArea) {
      replyArea.click();
      await sleep(800);
    }

    // Find the actual contenteditable input inside the reply area
    let input = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      // Look for contenteditable inside tweetTextarea_0
      const container = document.querySelector('div[data-testid="tweetTextarea_0"]');
      if (container) {
        if (container.getAttribute('contenteditable') === 'true') {
          input = container;
          break;
        }
        const child = container.querySelector('[contenteditable="true"]');
        if (child) {
          input = child;
          break;
        }
        // The container itself might be the textbox
        if (container.getAttribute('role') === 'textbox') {
          input = container;
          break;
        }
      }

      // Fallback: find any textbox in the inline reply area
      const inlineReply = document.querySelector('div[data-testid="inline_reply_offscreen"]');
      if (inlineReply) {
        const textbox = inlineReply.querySelector('[role="textbox"][contenteditable="true"]');
        if (textbox) {
          input = textbox;
          break;
        }
      }

      // Try clicking the reply button to open the reply area
      if (attempt === 5) {
        const replyBtn = document.querySelector('button[data-testid="reply"]');
        if (replyBtn) {
          replyBtn.click();
          await sleep(1000);
        }
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

    // Type the reply using execCommand
    document.execCommand('insertText', false, message);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(500);

    // Find and click the Reply/Post button — data-testid="tweetButtonInline" (verified)
    let postBtn = document.querySelector('button[data-testid="tweetButtonInline"]');
    if (!postBtn) {
      postBtn = document.querySelector('button[data-testid="tweetButton"]');
    }

    if (!postBtn) {
      return { error: 'Reply/Post button not found on X' };
    }

    postBtn.click();
    await sleep(2000);

    // Verify: check if input was cleared
    if (!input.textContent || input.textContent.trim() === '') {
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

    // Check for protected account text
    const protectedIndicators = [
      'These posts are protected',
      'These Tweets are protected',
      "This account's posts are protected",
      'Only approved followers can see'
    ];

    for (const indicator of protectedIndicators) {
      if (pageText.includes(indicator)) {
        return { isPrivate: true, reason: indicator };
      }
    }

    // Check for lock icon via aria-label (verified)
    const lockIcon = document.querySelector(
      'svg[aria-label*="Protected"], svg[aria-label*="protected"]'
    );
    if (lockIcon) {
      return { isPrivate: true, reason: 'Protected account (lock icon)' };
    }

    // Check for suspended/deactivated
    if (pageText.includes('Account suspended') || pageText.includes("doesn't exist") ||
        pageText.includes('This account doesn')) {
      return { isPrivate: true, reason: 'Account suspended or does not exist' };
    }

    return { isPrivate: false };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 9: CHECK DM AVAILABILITY
  // ════════════════════════════════════════════════════════════

  async function handleCheckDMAvailability() {
    // Check for Message button — button[aria-label="Message"] (verified — no data-testid!)
    const dmBtn = document.querySelector('button[aria-label="Message"]');

    if (dmBtn) {
      // Check if it's disabled
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
