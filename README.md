# Influencer DM Manager — Chrome Extension (v4)

A Chrome Extension for automating influencer engagement on Instagram. Two modes:

1. **Keyword Scan** — Scan an Instagram post's comments for specific keywords and auto-DM matching commenters.
2. **Bulk Outreach** — Provide a list of Instagram handles, connect/follow if needed, and send personalized DMs using pre-configured templates.

---

## Installation

1. Download or clone this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `influencer-dm-extension` folder
5. Click the extension icon to open the side panel
6. Make sure you're logged into Instagram in the same Chrome profile

---

## Mode 1: Keyword Scan

### Step-by-step flow

| Step | What happens |
|------|-------------|
| **1. Configure** | Enter the Instagram post URL, keyword(s), DM template, and delay between messages |
| **2. Scan** | Extension navigates to the post, scrolls the comment area, loads all comments, and matches keywords |
| **3. Review** | See all matched users, select/deselect who to message, preview the DM |
| **4. Send DMs** | Automatically opens each user's profile, clicks "Message", types and sends the DM |

### Features
- Case-insensitive keyword matching with word-boundary detection
- `{{username}}` personalization in DM templates
- Full Automation toggle to skip the review step
- Pause/Resume with immediate effect (finishes current user, then stops)
- "Back to Config" button when paused
- Plan B: If no "Message" button exists, follows the user and saves to a retry queue

---

## Mode 2: Bulk Outreach

### Sub-tabs

#### Reply Directions (Templates)
Create and manage multiple DM templates. Each template has a name, body text, and color indicator. Templates support `{{username}}` personalization.

#### Outreach
1. Paste a list of Instagram handles (one per line)
2. Select a default template, then optionally override per-handle
3. Click "Start Outreach"

For each handle, the extension:
- Navigates to their profile
- Checks for a "Message" button
  - **If found**: Clicks it, types the assigned template, sends the DM
  - **If not found**: Clicks "Follow" and adds the user to the **Waitlist**

#### Waitlist
Users who were followed but couldn't be DM'd are stored here with their assigned template. You can:
- **Re-check**: The extension revisits each profile. If a "Message" button now exists (they followed back), it sends the DM automatically. Otherwise, they stay on the waitlist.
- **Clear**: Remove all waitlisted users.

---

## Architecture

| Component | Role |
|-----------|------|
| `manifest.json` | Manifest V3 with sidePanel, scripting, tabs, storage permissions |
| `sidepanel.html` | Persistent side panel UI with tabbed navigation |
| `css/sidepanel.css` | All styling for the side panel |
| `js/sidepanel.js` | Side panel controller — UI logic, template management, progress display |
| `js/background.js` | **Orchestrator** — drives all navigation via `chrome.tabs.update()`, re-injects content script, manages DM loops and waitlist |
| `js/content.js` | **Atomic actions only** — scan comments, check profile buttons, click Message/Follow, type and send DM. Never navigates. |
| `css/overlay.css` | Minimal content script styles |

### Key design decisions
- The **content script never navigates**. All navigation is done by the background worker via `chrome.tabs.update()`. This prevents "Lost connection to Instagram tab" errors.
- After each navigation, the background worker **re-injects** the content script via `chrome.scripting.executeScript()`.
- A **duplicate-injection guard** (`window.__IEM_CONTENT_V3__`) prevents double message listeners.
- The side panel **persists across navigations**, showing real-time progress for each sub-step.

---

## No AI, No API Keys

This extension is 100% local browser automation:
- No AI or LLM calls
- No API keys required
- No external servers contacted
- No Instagram API usage
- Everything runs in your browser using Chrome Extension APIs

---

## File Structure

```
influencer-dm-extension/
├── manifest.json
├── sidepanel.html
├── css/
│   ├── sidepanel.css
│   └── overlay.css
├── js/
│   ├── background.js
│   ├── content.js
│   └── sidepanel.js
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Side panel doesn't open | Click the extension icon in the toolbar. If not visible, click the puzzle piece icon and pin it. |
| "Lost connection" errors | Reload the extension from `chrome://extensions/`. |
| DM not sending | Make sure you're logged into Instagram. Check that the DM input field is visible. |
| Comments not loading | The post may have restricted comments. Try a different post. |
| Follow button not found | The profile may be deactivated or have blocked your account. |
