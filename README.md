# Shelf Enter

A Chrome extension that enters Goodreads giveaways in one click. Hit the
**⚡ Enter Giveaway** button and it queues the entry in the background — picking
your saved address and agreeing to the terms for you — using your existing
logged-in session. No Selenium, no stored credentials.

## Install

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Open **Settings** (extension popup → Settings) and set your preferred
   shipping address (a substring of the address, e.g. a city, or its numeric id)

## Use

- Browse `goodreads.com/giveaway` (or any giveaway page) while logged in.
- Each **Enter Giveaway** button now shows a ⚡. Click it — a toast confirms
  `✓ Queued`, and the entry is submitted in the background.
- Click the toolbar icon to see the **queue**: status per giveaway, the address
  used, retry/remove, and clickable titles that open the giveaway page.

## Settings

| Option | What it does |
| --- | --- |
| Preferred shipping address | Substring (case-insensitive) or numeric id of the saved address to use. Blank = first saved address. |
| Concurrent entries | How many entries process at once (keep low, 1–2). |
| Min delay between entries | Throttle so you don't hammer Goodreads. |
| Max retries | Retry attempts per giveaway on transient failure. |

## How it works

Goodreads' entry flow is two POSTs, replayed with `fetch` using your session
cookies and the page's CSRF token:

1. `POST /giveaway/enter_choose_address/{id}?address={addressId}` — select address
2. `POST /giveaway/enter_print_giveaway/{id}?address={addressId}` — agree to terms + submit

A background service worker runs the queue (with concurrency limit, throttle,
retries, persisted across restarts). HTML is parsed in an offscreen document
(`DOMParser` isn't available in MV3 workers). The content script never mutates
Goodreads' DOM — the ⚡ is CSS-only — to avoid crashing its React app.

## Files

- `manifest.json` — MV3 config
- `content.js` / `content.css` — ⚡ marker + click interception + toast
- `background.js` — queue + entry logic (`dryRun`/`enterNow`/`debugEnter` console helpers)
- `offscreen.html` / `offscreen.js` — form/address parsing
- `popup.html` / `popup.js` — queue UI
- `options.html` / `options.js` — settings

## Notes

- Be reasonable with concurrency/delay — rapid automated entries risk rate
  limiting or flagging your account.
- If the ⚡ buttons stop working after reloading the extension, refresh the
  Goodreads tab (the old tab holds a stale content script).
