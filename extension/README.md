# Browser Extension

This folder contains the local Chrome extension used to send completed Chess.com games into the local Chess Trainer review app.

It is not published to the Chrome Web Store. You load it manually in developer mode.

## What It Does

When you click the extension on a completed Chess.com game page, it:

1. reads the current game page
2. tries to capture the game data using several fallback methods
3. posts that data to the local Chess Trainer server
4. opens a new review tab in the local app

The local app then imports the game and caches it in the browser.

## Load It

1. Open `chrome://extensions`
2. Turn on `Developer mode`
3. Click `Load unpacked`
4. Select the `extension/` folder

## Configure It

Open the extension options page and set the review app origin.

Default:

```text
http://127.0.0.1:8000
```

If the app server is running on a different port, update that value to match.

If you deploy the app, set this to your hosted app origin instead.

When you first use a non-local origin, Chrome may prompt for permission to access that host. That is expected.

## Use It

1. Start the local app:

```bash
python3 serve.py
```

2. Open a completed Chess.com game page
3. Click the extension icon once
4. Wait for the local review tab to open

If the handoff succeeds, the app should:

- open on `/import/<token>` first
- import the game into review mode
- orient the board so the clicking Chess.com account is at the bottom when that username can be identified
- then settle onto a stable cached route such as `/game/chesscom/<id>`

## Current Import Strategy

The extension currently tries these sources in roughly this order:

1. PGN directly exposed on the Chess.com page
2. Chess.com public monthly archive PGN
3. Chess.com page-native `moveList=...` data
4. structured move-list extraction from the page DOM
5. raw page HTML as a last-resort handoff

This is intentionally redundant because different Chess.com pages expose different data.

The extension keeps its default host access narrow and requests extra host access at runtime when you choose a custom deployed app origin.

## Important Limits

- This is for completed games only.
- It is not designed for live in-game assistance.
- It does not analyze on the Chess.com page itself.
- The local app server must be running first.
- If the extension cannot confidently identify the logged-in Chess.com username, the board falls back to the app's normal orientation instead of guessing.
- Chess.com DOM changes can still break some fallback paths.

## If It Fails

Check these places:

- the terminal running `python3 serve.py`
- `chrome://extensions` -> `Review on Chess Trainer` -> `service worker`
- the `Status` line inside the local review tab

If needed, fall back to manual PGN paste inside the app.
