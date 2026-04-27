# Influencer DM Manager

A powerful, 100% local Chrome Extension for automating Instagram influencer engagement. This tool operates directly in your browser by interacting with the Instagram DOM — **no AI, no API keys, and no external servers required.**

## Features

The extension provides two distinct modes of operation, accessible via tabs in the side panel:

### 1. Bulk Outreach (Handle List)
Provide a list of Instagram handles and automatically connect and message them based on their account type.

* **Smart Follow/DM Logic:**
  * **Public/Connected Accounts:** If the "Message" button is visible, it sends the DM immediately.
  * **Public (Not Followed):** Clicks "Follow", waits for the "Message" button to appear, and sends the DM.
  * **Private Accounts:** Clicks "Follow", detects the "Requested" status, and adds the user to a Waitlist for later follow-up once approved.
* **Template Manager:** Create multiple color-coded DM templates (e.g., "Collab Invite", "Product Gifting") with `{{username}}` personalization.
* **Auto-Cadence Follow-ups:** Schedule automated follow-up messages at 6h, 12h, and 24h intervals after the initial DM.
* **Three-Light Status Tracking:** Visual indicators for each user showing if their profile was Viewed (Blue), Followed (Orange), and Messaged (Green).
* **History & Waitlist:** Track all past interactions, filter by status, and easily re-check waitlisted users to send DMs once they accept your follow request.

### 2. Keyword Scan (Post Comments)
Automate the process of finding and messaging users who express interest in a specific Instagram post.

* **Comment Scraping:** Automatically scrolls through all comments on a target post, expanding replies to capture every interaction.
* **Keyword Matching:** Identifies users who commented with specific trigger words (e.g., "photo", "link", "guide").
* **Automated DMing:** Navigates to each matched user's profile and sends a personalized templated message.

## Use Cases

### Use Case 1: The "Comment for Link" Funnel
**Scenario:** You post a reel or carousel offering a free guide, preset, or link, asking followers to "Comment 'GUIDE' to get it in your DMs."
**Workflow:**
1. Open the **Keyword Scan** tab.
2. Enter the post URL and the keyword "guide".
3. Set your DM template: `"Hey {{username}}! Here is the link to the guide you requested: [link]"`
4. The extension scans all comments, finds everyone who typed "guide", and automatically delivers the link to their DMs.

### Use Case 2: Cold Influencer Outreach Campaign
**Scenario:** Your brand is launching a new product and you have a spreadsheet of 100 micro-influencers you want to invite for a gifting collaboration.
**Workflow:**
1. Open the **Bulk Outreach** tab and create a template named "Gifting Collab".
2. Paste the 100 handles into the Outreach list.
3. Enable **Full Automation** and click Start.
4. The extension handles the rest: it DMs the public accounts immediately, follows the ones that require it, and waitlists the private accounts.
5. You check the **Waitlist** a few days later and click "Re-check" to DM the private accounts that accepted your follow request.

### Use Case 3: Event Invitation with Automated Follow-ups
**Scenario:** You are hosting an exclusive creator event and need RSVPs quickly.
**Workflow:**
1. In **Bulk Outreach**, create an "Event Invite" template and a "Reminder" template.
2. Paste your guest list handles.
3. Check the **24h Follow-up** box and select the "Reminder" template.
4. The extension sends the initial invites. Exactly 24 hours later, it automatically sends the reminder DM to those same users, ensuring maximum attendance without manual tracking.

## Installation

1. Download or clone this repository.
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top right corner).
4. Click **Load unpacked** and select the `influencer-dm-extension` folder.
5. Pin the extension to your toolbar and click the icon to open the side panel.
6. Ensure you are logged into Instagram in the same Chrome profile.

## Safety & Best Practices

Because this extension automates actions on your behalf, it is important to use it responsibly to avoid triggering Instagram's anti-spam systems:

* **Pacing:** Use a delay of 45–90 seconds between DMs. The default 30s is aggressive and should only be used for small batches.
* **Volume:** Limit your outreach to 30–50 DMs per day for established accounts, and 15–20 for newer accounts.
* **Warm-up:** If you have never sent bulk DMs before, start with 5 per day and gradually increase over a few weeks.
* **Variation:** Avoid sending the exact same message to hundreds of people. Use the `{{username}}` tag and vary your templates.

## Technical Details

This extension is built using Manifest V3 and utilizes the `chrome.sidePanel`, `chrome.scripting`, and `chrome.storage.local` APIs. It does not use any external APIs or AI models. All DOM interaction is handled via vanilla JavaScript injected directly into the Instagram page context.
