/**
 * X (Twitter) Content Script (v3) — Atomic Single-Page Actions for x.com
 *
 * Updated with verified DOM selectors from real logged-in X (May 2026).
 * v3 fixes: Bug #3 (execCommand for contenteditable), Bug #7 (reply from tweet page),
 *           Edge cases E4/E5, Improvements S4/S8.
 *
 * KEY DOM FINDINGS (verified May 2026):
 *   - X uses data-testid attributes extensively — very reliable selectors
 *   - Follow button: button[data-testid$="-follow"] or button[aria-label^="Follow @"]
 *   - DM button on profile: button[aria-label="Message"] (NO data-testid!)
 *   - Tweet: article[data-testid="tweet"]
 *   - Tweet text: div[data-testid="tweetText"]
 *   - Reply input: div[data-testid="tweetTextarea_0"][role="textbox"] (contenteditable)
 *   - Reply send: button[data-testid="tweetButtonInline"]
 *   - DM compose input: textarea[data-testid="dm-composer-textarea"][placeholder="Message"]
 *     (CHANGED from div[data-testid="dmComposerTextInput"] contenteditable)
 *   - DM compose form: form[data-testid="dm-composer-form"]
 *   - DM compose container: div[data-testid="dm-composer-container"]
 *   - DM send: Enter key on textarea (no explicit send button in new UI)
 *     (CHANGED from button[data-testid="dmComposerSendButton"])
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
 *  10. findLatestTweetUrl  — find the URL of the user's latest tweet (for reply fallback)
 *  11. likeLatestTweet     — like the first visible tweet (S8 improvement)
 *  12. ping                — health check
 */

(() => {
  'use strict';

  // Prevent duplicate injection
  if (window.__IEM_X_V3__) return;
  window.__IEM_X_V3__ = true;

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
      typeAndSendReply: () => handleTypeAndSendReply(msg.message),
      checkIfPrivate: () => handleCheckIfPrivate(),
      checkDMAvailability: () => handleCheckDMAvailability(),
      findLatestTweetUrl: () => handleFindLatestTweetUrl(),
      likeLatestTweet: () => handleLikeLatestTweet(),
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

      // IMPROVEMENT S4: Also extract the tweet URL for this reply (for reply fallback)
      let tweetUrl = '';
      const timeLink = article.querySelector('a[href*="/status/"] time');
      if (timeLink) {
        const parentLink = timeLink.closest('a');
        if (parentLink) {
          tweetUrl = 'https://x.com' + parentLink.getAttribute('href');
        }
      }

      // Check keyword match
      const textLower = replyText.toLowerCase();
      const matched = keywordList.some(kw => textLower.includes(kw));

      if (matched && !users.has(username)) {
        users.set(username, {
          username,
          displayName: displayName || username,
          commentText: replyText.substring(0, 200),
          profileUrl: `https://x.com/${username}`,
          tweetUrl // Store for reply fallback (S4)
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
    const followBtn = document.querySelector('button[data-testid$="-follow"]:not([data-testid$="-unfollow"])');
    const followBtnAria = document.querySelector('button[aria-label^="Follow @"]');
    const actualFollowBtn = followBtn || followBtnAria;

    if (actualFollowBtn) {
      const text = actualFollowBtn.textContent.trim().toLowerCase();
      const testId = (actualFollowBtn.getAttribute('data-testid') || '').toLowerCase();
      if (text === 'follow' && !testId.includes('unfollow')) {
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

    // Also check for lock icon via aria-label (verified)
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

    // Check for Pending (protected account)
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

    return { error: 'No Message/DM button found on X profile', noMessage: true };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 6: TYPE AND SEND DM (in X DM conversation)
  // ════════════════════════════════════════════════════════════

  async function handleTypeAndSendDM(message) {
    if (!message) return { error: 'No message provided' };

    // Wait for DM compose to appear
    await sleep(2000);

    // Find the DM input
    // X DM DOM (verified May 2026):
    //   textarea[data-testid="dm-composer-textarea"][placeholder="Message"]
    //   inside form[data-testid="dm-composer-form"]
    //   inside div[data-testid="dm-composer-container"]
    //   NO contenteditable elements, NO role="textbox"
    //   OLD selectors (pre-2026): div[data-testid="dmComposerTextInput"] contenteditable
    const inputSelectors = [
      // Current X (May 2026) — textarea
      'textarea[data-testid="dm-composer-textarea"]',
      'form[data-testid="dm-composer-form"] textarea',
      'div[data-testid="dm-composer-container"] textarea',
      'textarea[placeholder="Message"]',
      'textarea[placeholder="Start a new message"]',
      // Legacy selectors (pre-2026) — contenteditable div
      'div[data-testid="dmComposerTextInput"]',
      'div[data-testid="dmComposerTextInput"] div[contenteditable="true"]',
      'div[data-testid="dmComposerTextInput"] div[role="textbox"]',
      'div[role="textbox"][data-testid="dmComposerTextInput"]',
      'aside div[role="textbox"][contenteditable="true"]',
      'div[data-testid="DmScrollerContainer"] div[contenteditable="true"]'
    ];

    let input = null;
    let isTextarea = false;
    for (let attempt = 0; attempt < 25; attempt++) {
      for (const sel of inputSelectors) {
        const el = document.querySelector(sel);
        if (el && (el.offsetParent !== null || el.offsetWidth > 0)) {
          if (el.tagName === 'TEXTAREA') {
            input = el;
            isTextarea = true;
            break;
          } else if (el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox') {
            input = el;
            break;
          } else {
            // Look for a contenteditable child
            const child = el.querySelector('[contenteditable="true"], [role="textbox"]');
            if (child) {
              input = child;
              break;
            }
          }
        }
      }
      if (input) break;
      await sleep(500);
    }

    if (!input) {
      return { error: 'Could not find DM input on X' };
    }

    input.focus();
    await sleep(300);

    if (isTextarea) {
      // Modern X (May 2026): textarea — use native value setter for React compatibility
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value'
      ).set;
      nativeSetter.call(input, message);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(300);

      // Double-check: if value didn't stick, try execCommand
      if (input.value !== message) {
        input.focus();
        input.select();
        document.execCommand('insertText', false, message);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else {
      // Legacy X: contenteditable div — use execCommand
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      await sleep(100);

      const lines = message.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]) {
          document.execCommand('insertText', false, lines[i]);
        }
        if (i < lines.length - 1) {
          document.execCommand('insertLineBreak', false, null);
        }
        await sleep(50);
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    await sleep(500);

    // Find and click Send button
    // Modern X (May 2026): form submit via Enter key or submit button within form
    // Legacy X: button[data-testid="dmComposerSendButton"]
    let sendBtn = null;
    const SEND_SELECTORS = [
      'button[data-testid="dmComposerSendButton"]',
      'form[data-testid="dm-composer-form"] button[type="submit"]',
      'div[data-testid="dm-composer-container"] button[type="submit"]',
      'button[aria-label="Send"]',
      'button[aria-label="send"]'
    ];
    for (const sel of SEND_SELECTORS) {
      const btn = document.querySelector(sel);
      if (btn) { sendBtn = btn; break; }
    }

    if (sendBtn) {
      sendBtn.click();
    } else {
      // No explicit send button — submit via Enter key on the textarea/form
      const form = input.closest('form');
      if (form) {
        // Dispatch Enter keydown on the input to trigger form submission
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        await sleep(100);
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      } else {
        return { error: 'Send button not found in X DM and no form to submit' };
      }
    }

    await sleep(2000);

    // Verify: check if input was cleared
    const inputAfter = document.querySelector('textarea[data-testid="dm-composer-textarea"]') ||
                       document.querySelector('div[data-testid="dmComposerTextInput"]') || input;
    const afterText = isTextarea ? (inputAfter.value || '') : (inputAfter.textContent || inputAfter.innerText || '');
    if (afterText.trim() === '') {
      return { success: true };
    }

    return { success: true, warning: 'DM sent but could not verify delivery on X' };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 7: TYPE AND SEND REPLY (fallback when DMs closed)
  //  BUG FIX #7: Must be called when ON the tweet page, not profile
  // ════════════════════════════════════════════════════════════

  async function handleTypeAndSendReply(message) {
    if (!message) return { error: 'No reply message provided' };

    // Verify we're on a tweet page (should contain /status/ in URL)
    const currentUrl = window.location.href;
    if (!currentUrl.includes('/status/')) {
      return { error: 'Not on a tweet page — cannot reply. Navigate to a tweet first.' };
    }

    // Wait for page to load
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

    // BUG FIX #3: Use execCommand for contenteditable React compatibility
    input.focus();
    await sleep(300);

    // Clear existing content using execCommand
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
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

  // ════════════════════════════════════════════════════════════
  //  ACTION 10: FIND LATEST TWEET URL (for reply fallback)
  //  IMPROVEMENT S4: Navigate to user's latest tweet for reply
  // ════════════════════════════════════════════════════════════

  async function handleFindLatestTweetUrl() {
    await sleep(1500);

    // We should be on the user's profile page
    // Find the first tweet article that has a status link
    const tweets = document.querySelectorAll('article[data-testid="tweet"]');

    for (const tweet of tweets) {
      // Find the time element which is inside the tweet's status link
      const timeEl = tweet.querySelector('time');
      if (timeEl) {
        const statusLink = timeEl.closest('a[href*="/status/"]');
        if (statusLink) {
          const href = statusLink.getAttribute('href');
          if (href && href.includes('/status/')) {
            return { url: 'https://x.com' + href };
          }
        }
      }
    }

    return { url: null, error: 'No tweets found on profile' };
  }

  // ════════════════════════════════════════════════════════════
  //  ACTION 11: LIKE LATEST TWEET (before replying)
  //  IMPROVEMENT S8: Like tweet before replying for visibility
  // ════════════════════════════════════════════════════════════

  async function handleLikeLatestTweet() {
    await sleep(500);

    // Find the first tweet's like button
    const tweets = document.querySelectorAll('article[data-testid="tweet"]');
    if (tweets.length === 0) {
      return { success: false, error: 'No tweets found' };
    }

    // Use the first tweet (original tweet on a tweet page)
    const firstTweet = tweets[0];
    const likeBtn = firstTweet.querySelector('button[data-testid="like"]');

    if (likeBtn) {
      likeBtn.click();
      await sleep(500);
      return { success: true };
    }

    // Already liked
    const unlikeBtn = firstTweet.querySelector('button[data-testid="unlike"]');
    if (unlikeBtn) {
      return { success: true, alreadyLiked: true };
    }

    return { success: false, error: 'Like button not found' };
  }

})();
