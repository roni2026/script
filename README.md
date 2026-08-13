# Bikroy Category & Audit Log Notifier

A Tampermonkey userscript that speeds up moderation work on the Bikroy admin review panel.

## What it does

- **Category auto-selector** — on the review pages (listing fee, general, edited, verification, member), the script reads the ad's title and automatically suggests/fills the matching category, cutting out repetitive manual selection
- **Payment ad lock** — when reviewing a paid ad, the script locks the original category in place and disables auto category changes, so a paid listing's category can't accidentally get overwritten
- **Audit log notifier** — on item pages, surfaces recent audit log activity so a moderator can see an item's history at a glance
- **Reject confirmation** — payment ads require an extra confirmation step before a Reject action goes through, as a safeguard against accidental rejections on paid listings

Runs on `admin.bikroy.com`'s review queues (`listing_fee`, `general`, `edited`, `verification`, `member`) and on individual item pages.

## Installing

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open the `.user.js` file in this repo, click "Raw," and Tampermonkey will prompt to install it.
3. Navigate to the Bikroy admin review panel — the script activates automatically on matching pages.
