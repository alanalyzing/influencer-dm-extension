# Influencer DM Manager — Chrome Extension (v3)

A Chrome Extension that automates influencer engagement on Instagram. It scans post comments for specific keywords, identifies matching commenters, and sends personalized DMs to each one. The extension runs as a **persistent side panel** on the right side of Chrome, showing real-time progress for every step.

---

## Architecture (v3)

This version was completely rebuilt to fix the "Lost connection to Instagram tab" error from v2. The core change is a strict separation of concerns between three components.

| Component | Role |
|-----------|------|
| **Background Service Worker** | The orchestrator. Drives all page navigation via `chrome.tabs.update()`, waits for page loads, and re-injects the content script on each new page via `chrome.scripting.executeScript()`. Runs the DM loop. |
| **Content Script** | Performs only atomic, single-page actions. Never navigates. Three actions: `scanComments` (on post page), `clickMessageButton` (on profile page), `typeAndSendDM` (on DM page). |
| **Side Panel** | Persistent UI on the right side of Chrome. Shows real-time progress for scanning and per-user DM sub-steps. Stays open across page navigations. |

The previous version failed because the content script tried to navigate (`window.location.href = ...`), which destroyed its own execution context. Now, the background worker handles all navigation and re-injects the content script after each page load.

---

## How It Works

### Step 1 — Configure

Enter the Instagram post URL, keyword(s) to match, your DM template (with `{{username}}` personalization), and the delay between messages.

### Step 2 — Scan Comments

The extension navigates to the post, scrolls the comment panel to load all comments, expands reply threads, and matches each comment against your keywords. The side panel shows a live log of each scanning sub-step.

### Step 3 — Review Matches

Review matched commenters with their comments and matched keywords. Select or deselect users, see who was already messaged, and preview the DM.

### Step 4 — Send DMs

For each selected user, the side panel shows granular real-time progress through these sub-steps:

1. **Opening profile** — Background navigates to `instagram.com/username/`
2. **Clicking "Message"** — Content script finds and clicks the Message button
3. **Waiting for DM** — Background waits for the DM conversation to load
4. **Typing message** — Content script types the personalized message
5. **DM sent** — Confirmation with timestamp

Each user's entry in the log shows checkmarks for completed sub-steps and a spinner for the active sub-step.

---

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `influencer-dm-extension` folder
4. Click the extension icon in the toolbar to open the side panel
5. Make sure you are logged into Instagram in the same Chrome profile

---

## File Structure

```
influencer-dm-extension/
├── manifest.json          # Manifest V3 with sidePanel API
├── sidepanel.html         # Side panel UI
├── css/
│   ├── sidepanel.css      # Side panel styles
│   └── overlay.css        # Content script toast styles
├── js/
│   ├── background.js      # Service worker (orchestrator)
│   ├── content.js         # Content script (atomic actions)
│   └── sidepanel.js       # Side panel controller
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## Key Features

| Feature | Description |
|---------|-------------|
| Side Panel UI | Stays open on the right side of Chrome, persists across page navigations |
| Real-time Progress | Per-user sub-step tracking with spinners and checkmarks |
| Background Orchestration | All navigation driven by background worker — no lost connections |
| Content Script Re-injection | Automatically re-injected after each page navigation |
| Keyword Matching | Case-insensitive with word-boundary detection and plural support |
| DM Personalization | `{{username}}` template variable |
| Duplicate Prevention | History tracking shows already-messaged users |
| Rate Limit Protection | Configurable delay (10–120s) between DMs |
| Pause/Resume | Stop and continue the DM sequence at any time |
| Config Memory | Last campaign settings saved and pre-filled |

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Side panel doesn't open | Click the extension icon in the toolbar. If it still doesn't open, go to `chrome://extensions/`, find the extension, and check for errors. |
| Scan finds 0 comments | Ensure the post URL is correct and the post has visible comments. |
| DM fails — no "Message" button | The user may have restricted DMs, or their profile may not have loaded. The extension logs the error and moves to the next user. |
| Extension stops after Chrome update | Reload the extension from `chrome://extensions/`. |
