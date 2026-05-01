# Influencer DM Manager — Chrome Extension

> Automate Instagram & Threads influencer engagement: keyword-based comment scanning, bulk outreach with smart follow/DM logic, templated messaging, cadence follow-ups, waitlist management, dashboard analytics, and CSV import/export. No AI, no API keys, 100% local browser automation.

---

## What's New in v8

### Skip Private Profiles Toggle

New **"Skip private profiles entirely"** behavior setting that detects private accounts **before** sending a follow request and skips them completely — no follow, no waitlist, just moves to the next user.

**How it works:**
- After navigating to a profile, the extension checks for private account indicators:
  - "This account is private" text on the page
  - No posts visible + Follow button present
  - Private account headings or lock icons
- If private is detected and the toggle is enabled, the user is skipped instantly
- No follow request is sent, keeping your account's follow activity clean

**Toggle location:** Behavior Settings → "Skip private profiles entirely" (unchecked by default)

### Duplicate Message Prevention

Multi-level deduplication system prevents the same user from receiving the same message twice:

| Layer | What it prevents |
|-------|------------------|
| **Pre-send history check** | Re-running outreach with same handles won't re-send |
| **Retry loop guard** | If input was cleared (message sent), never retry |
| **Cadence step check** | Same follow-up step can't fire twice |
| **Cross-queue dedup** | Users in both waitlist and cadence won't get double messages |

Skipped users show as "skipped-dup" in the progress log.

### Private Profile Handling Fix

Private profiles no longer trigger auto-pause. Previously, encountering 2 private profiles in a row would pause the entire automation. Now:

- Profile/follow errors are **not** counted as health failures
- Only actual DM delivery failures affect session health
- "Already Requested" profiles are detected early and handled gracefully
- `clickFollowButton` errors are caught inline (waitlist + continue) instead of throwing
- Health thresholds relaxed: consecutive fail max 2→3, rolling window 3/5→4/5

---

## What's New in v7

### Dashboard Analytics

A new **Dashboard** sub-tab is now the default view when opening Bulk Outreach. It provides at-a-glance performance metrics without leaving the side panel:

| Metric | Description |
|--------|-------------|
| **DMs Today** | Number of successful DMs sent in the last 24 hours |
| **DMs This Week** | Total DMs sent in the last 7 days |
| **Success Rate** | Percentage of successful sends vs total attempts (7-day window) |
| **Waitlisted** | Current number of users pending follow-back |

**Visual Charts:**
- **7-Day Activity Bar Chart** — Shows DMs sent per day with gradient-filled bars
- **Outcome Breakdown** — Horizontal bars comparing messaged / followed / waitlisted / errors for the week
- **Session Health Display** — Real-time health bar showing success rate with Healthy / Fair / Degraded status indicators

The dashboard auto-refreshes whenever outreach progress or history updates are received.

### CSV Import / Export

**Import CSV** — Click the Import CSV button on the Outreach sub-tab to load handles from a `.csv` or `.txt` file. The parser automatically detects columns named `handle`, `username`, or `user`, and handles quoted fields, various delimiters, and plain lists.

**Export CSV** — Export your current handles list to a downloadable CSV file with a single click.

**Export History** — On the History sub-tab, export your full outreach history as a CSV with columns: `username`, `platform`, `status`, `viewed`, `followed`, `messaged`, `templateName`, `timestamp`, `message`, `cadenceStep`.

### DM Reliability & Send Rate Improvements

Significant improvements to DM delivery success rate:

- **Post-send bubble verification** — After sending each DM, the extension counts message bubbles before and after to confirm delivery actually occurred. If verification fails, it retries automatically.
- **Session health monitoring** — Tracks a rolling window of the last 5 send attempts. Auto-pauses outreach on 2 consecutive failures or 3 out of 5 failures to protect your account.
- **Adaptive delay** — Automatically increases delay by 10s per failure and decreases by 5s per success, dynamically adjusting to Instagram's rate limits.
- **Default delay set to 60s** — With a visible warning if you set it below 60s to reduce risk of action blocks.
- **Configurable behavior settings** — Always follow before DM, DM after follow for public accounts, waitlist private accounts (all toggleable).

### Line Break Preservation in DMs

DM templates now fully preserve line breaks. The extension uses **Shift+Enter simulation** to insert line breaks in Instagram's contenteditable input, so multi-paragraph messages render exactly as written in your template.

### Other v7 Improvements
- Dashboard is now the **default active sub-tab** in Bulk Outreach (before Outreach, History, Waitlist, Templates)
- Sub-tab order: Dashboard → Outreach → History → Waitlist → Templates
- Pause takes effect **immediately** after current task completes (not after full delay)
- Back to Config button appears when paused for easy reconfiguration

---

## Features

### Multi-Platform Support (v6)

Toggle between **Instagram** and **Threads** with a single click in the side panel header. The extension adapts labels, URL validation, and DOM interaction for each platform.

| Platform | Keyword Scan | Bulk Outreach (Follow) | DMs |
|----------|:---:|:---:|:---:|
| **Instagram** | Scan post comments | Follow on Instagram | DM via Instagram |
| **Threads** | Scan thread replies | Follow on Threads | DM via Instagram (Threads web has no DM) |

> **Note:** Threads does not support web-based DMs. When operating on Threads, the extension automatically redirects to the user's Instagram profile to send DMs.

---

### Mode 1: Bulk Outreach (Primary)

Provide a list of handles and let the extension connect and message each one.

**Smart Three-Case Logic:**

| Case | Condition | Action |
|------|-----------|--------|
| Direct DM | Message button visible | Send DM immediately |
| Follow + DM | Follow accepted instantly (public account) | Follow, then DM immediately |
| Follow + Waitlist | Follow requires approval (private account) | Follow, then add to waitlist |

**Sub-tabs:**

1. **Dashboard** — At-a-glance stats, 7-day chart, outcome breakdown, session health (v7)
2. **Outreach** — Paste handles (or import CSV), assign templates, configure delay, start outreach
3. **History** — All past interactions with three-light status indicators, filters, and CSV export
4. **Waitlist** — Users pending follow-back approval, with re-check functionality
5. **Templates** — Create, edit, and delete reusable DM templates (Reply Directions)

**Additional Features:**
- **Full Automation toggle** — Skip review, go straight from parsing to sending
- **Auto-cadence follow-ups** — Schedule follow-up messages at 6h, 12h, and/or 24h
- **Three-light status per account:** Viewed (blue), Followed (orange), Messaged (green)
- **Pause/Resume** with immediate effect (finishes current user, then pauses)
- **Back to Config** button when paused

---

### Mode 2: Keyword Scan

Scan an Instagram post or Threads thread for comments containing specific keywords, then DM the matching commenters.

**Step-by-step flow:**

1. **Configure** — Enter post URL, keyword(s), DM template, delay
2. **Scan** — Extension scrolls the comment area, expands replies, extracts all comments
3. **Review** — See matched users, select/deselect who to message
4. **Send** — Automatically navigates to each profile and sends personalized DMs

**Features:**
- Case-insensitive keyword matching with word-boundary detection
- `{{username}}` personalization in DM templates
- Full Automation toggle to skip the review step
- Duplicate prevention via DM history tracking

---

### Reply Directions (Templates)

Pre-configure multiple DM templates for different outreach scenarios:

- **Collaboration Invite** — "Hi {{username}}, we'd love to collaborate with you..."
- **Product Gifting** — "Hey {{username}}, we'd like to send you our latest..."
- **Event Invite** — "Hi {{username}}, you're invited to our exclusive..."

Each template supports `{{username}}` personalization and can be assigned per-handle during bulk outreach. Templates can be created, edited, and deleted at any time.

---

### Waitlist Management

When a user's profile requires follow approval before messaging:

1. Extension sends a follow request
2. User is added to the **Waitlist** with their assigned template
3. Periodically click **Re-check** — the extension revisits each profile
4. If they followed back (Message button now visible), sends the DM automatically
5. If still pending, keeps them on the waitlist

---

### Auto-Cadence Follow-Ups

After an initial DM is sent, schedule automatic follow-up messages:

| Interval | When it sends |
|----------|---------------|
| 6 hours | 6h after initial DM |
| 12 hours | 12h after initial DM |
| 24 hours | 24h after initial DM |

- Select which intervals to enable per campaign
- Choose a specific follow-up template
- Background worker checks every 2 minutes for due follow-ups
- View scheduled follow-ups in the History tab

---

## Installation

1. Download or clone this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `influencer-dm-extension` folder
5. Click the extension icon to open the side panel
6. Make sure you're logged into Instagram (and Threads if using Threads mode) in the same Chrome profile

---

## Use Cases

### 1. "Comment for Link" Funnel

An influencer posts content saying "Comment PHOTO to get the free preset pack."

1. Select **Keyword Scan** mode
2. Paste the post URL, set keyword to `photo`
3. Write a DM template: "Hi {{username}}! Here's your free preset pack: [link]"
4. Scan, review, and send DMs to all matching commenters

### 2. Cold Influencer Outreach Campaign

You have a list of 100 micro-influencers to pitch for a brand collaboration.

1. Select **Bulk Outreach** mode
2. Create templates: "Collaboration Invite", "Product Gifting"
3. Paste all 100 handles, assign the right template per handle
4. Enable auto-cadence (24h follow-up)
5. Start outreach — the extension handles follow/DM logic per account

### 3. Cross-Platform Engagement (Instagram + Threads)

A brand posts the same campaign on both Instagram and Threads.

1. Start with **Threads** platform selected
2. Use Keyword Scan on the Threads post to find engaged users
3. Extension scans Threads replies, then redirects to Instagram for DMs
4. Switch to **Instagram** and repeat for the Instagram post
5. History shows all interactions across both platforms

### 4. Event Invitation with Automated Follow-ups

Inviting influencers to an exclusive event with reminder cadence.

1. Create templates: "Event Invite" (initial) and "Event Reminder" (follow-up)
2. Paste handles, assign "Event Invite" as default
3. Enable 24h cadence with "Event Reminder" as follow-up template
4. Start outreach — initial invites go out immediately
5. 24 hours later, follow-up reminders are sent automatically

---

## Safety & Best Practices

| Setting | Conservative | Moderate | Aggressive |
|---------|:---:|:---:|:---:|
| Delay between DMs | 90s | 45s | 20s |
| DMs per session | 10–15 | 20–30 | 50+ |
| DMs per day | 30–40 | 50–70 | 80+ |
| Template variations | 3–5 | 2–3 | 1 |

**Recommendations:**
- Start with conservative settings and gradually increase
- Warm up new accounts over 1–2 weeks before scaling
- Run during normal business hours
- Stop immediately if you see "Action Blocked" warnings
- Maintain regular organic activity on your account

---

## Technical Details

- **Manifest V3** Chrome Extension with Side Panel API
- **No AI, no API keys, no external servers** — everything runs locally in your browser
- **Architecture:** Background service worker orchestrates navigation, re-injects content scripts per page, content scripts perform atomic DOM actions
- **Storage:** `chrome.storage.local` for templates, history, waitlist, cadence queue
- **Platforms:** Instagram (`content.js`) and Threads (`threads-content.js`) with platform-specific DOM selectors
- **DMs:** Always sent through Instagram (Threads web DMs not yet available)

---

## Repository

**GitHub:** [alanalyzing/influencer-dm-extension](https://github.com/alanalyzing/influencer-dm-extension)
