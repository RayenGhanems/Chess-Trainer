# Chess Trainer

Local chess training app with:

- play against a bundled Stockfish engine
- rewind and branch from any move
- import finished games for review
- one-click Chess.com handoff through a local Chrome extension

This is still an MVP. It is good enough to hand to a friend for testing, but it is not a polished hosted product yet.

## Current Stage

What works well right now:

- local play against Stockfish
- move tree navigation and branching
- PGN import for review
- local cache of imported games in the browser
- reopenable local review links such as `/game/chesscom/<id>`
- Chrome extension handoff from completed Chess.com game pages
- deployable single-instance web app with Docker / Render scaffolding

What this is not yet:

- not a true multi-user cloud product
- not a Chrome Web Store extension
- not an always-perfect Chess.com integration
- not a multiplayer product
- not a shared database-backed review service

## Best Way To Test It

If you are giving this repo to a friend, the best test order is:

1. Run the local app and make sure the board loads.
2. Play a few moves against Stockfish.
3. Paste a PGN and confirm review mode works.
4. Load the extension in Chrome.
5. Finish a Chess.com game, click the extension, and confirm the review opens.
6. Refresh the imported review page and confirm it still opens from the local cache.

That covers the important paths.

## Requirements

For normal use:

- Python 3
- a modern browser

For the Chess.com extension flow:

- Chrome or another Chromium-based browser with Manifest V3 support

Optional:

- internet access for Chess.com imports and Chess.com-hosted piece images

What you do not need:

- no `pip install`
- no `npm install`
- no build step

The engine is already bundled in `vendor/stockfish/`.

Optional for deployment:

- Docker
- a hosting platform that can run a long-lived web process
- a persistent disk if you want temporary import handoff files to survive restarts better

## Quick Start

From the project directory:

```bash
python3 serve.py
```

Then open:

```text
http://127.0.0.1:8000
```

If your machine uses `python` instead of `python3`, run:

```bash
python serve.py
```

## Deployment

This repo is now deployable as a small hosted beta.

The current deployment shape is:

- one Python web process
- static frontend files served by `serve.py`
- temporary import handoff records written to disk
- imported review cache still stored per user in the browser
- lightweight in-memory rate limiting on import endpoints

That means deployment is good for:

- private beta testing
- sharing one hosted review URL with friends
- using the extension against a hosted app origin

It is not yet the same as a full hosted product with shared user accounts and cross-device saved history.

### Environment Variables

The server supports these runtime variables:

- `CHESS_TRAINER_HOST`: bind host
- `CHESS_TRAINER_PORT`: optional custom port
- `PORT`: hosting-platform port fallback
- `CHESS_TRAINER_DATA_DIR`: directory for temporary server-side import handoff files

Useful production defaults:

```text
CHESS_TRAINER_HOST=0.0.0.0
CHESS_TRAINER_DATA_DIR=/data
```

### Health Check

Use:

```text
/healthz
```

or:

```text
/api/healthz
```

### Option 1: Docker

Build:

```bash
docker build -t chess-trainer .
```

Run:

```bash
docker run --rm -p 8000:8000 -e CHESS_TRAINER_HOST=0.0.0.0 -e CHESS_TRAINER_DATA_DIR=/data chess-trainer
```

Then open:

```text
http://127.0.0.1:8000
```

### Option 2: Render

This repo includes `render.yaml` and `Dockerfile`.

High-level Render steps:

1. Push the repo to GitHub.
2. Create a new Render web service from the repo.
3. Let Render use `render.yaml`.
4. Wait for the deploy to finish.
5. Open `/healthz` on the deployed URL.
6. Use that deployed origin in the extension options page.

### Option 3: Procfile Platforms

The repo also includes a `Procfile` for platforms that launch a standard web command.

## Hosted Extension Flow

If you deploy the app, the extension can target the hosted origin instead of localhost.

To do that:

1. load the unpacked extension
2. open `Extension options`
3. replace `http://127.0.0.1:8000` with your deployed app origin
4. save the new origin

Important:

- the extension keeps local Chess.com access by default and requests extra host access only when you point it at a custom deployed app origin
- it still only activates meaningfully when you click it on a Chess.com page

## What The App Does

The app has two main modes.

### Play Mode

Use this as a training board against Stockfish.

You can:

- choose White or Black
- make moves by click or drag
- see the eval bar and best move suggestion
- rewind to an earlier move
- create a different branch instead of overwriting the line

### Review Mode

Use this to inspect a finished game.

You can enter review mode by:

- pasting a PGN
- pasting a Chess.com game link
- clicking the Chrome extension on a completed Chess.com game page

In review mode the app:

- builds the full imported move tree
- jumps to the final imported position
- starts a background Stockfish pass over the imported line
- fills in evals and move grades as analysis completes

## Main UI Areas

The important parts of the UI are:

- `Board`: current position
- `Eval`: evaluation for the current position
- `Move feedback`: grade for the latest reviewed move
- `Engine suggestion`: best move from Stockfish
- `Variation tree`: all saved moves and branches
- `Branch explorer`: continuations from the current node
- `Recent reviews`: locally cached imported games
- `Import a game`: PGN / Chess.com import panel
- `Cached permalink`: stable local review link for the current imported game

## Controls

Buttons:

- `|<`: jump to the start
- `<`: go back one move
- `>`: go forward one move
- `>|`: jump to the latest node
- `Flip board`: flip orientation
- `New game`: reset back to a fresh play board

Settings:

- `Play as`: choose White or Black in play mode
- `Coach depth`: target analysis depth, defaulting to the maximum on fresh load
- `Stockfish delay`: delay before the engine auto-replies in play mode
- `Show best move arrow`: toggle the best-move overlay

Keyboard:

- `Left Arrow`: back one move
- `Right Arrow`: forward one move

## How To Use It

### A. Play Against Stockfish

1. Start the server with `python3 serve.py`.
2. Open `http://127.0.0.1:8000`.
3. Wait until the top status says `Stockfish ready`.
4. Make moves on the board.
5. Use the navigation buttons to rewind.
6. Play a different move from an older position to create a branch.

Good signs that this is working:

- the eval changes after moves
- the engine replies in play mode
- the move tree grows
- rewinding and replaying creates alternate lines

### B. Import A PGN

1. Copy a PGN.
2. Paste it into the `PGN or copied game text` box.
3. Click `Import for review`.

Expected result:

- the app switches into review mode
- the imported game appears in the move tree
- the board jumps to the end of the imported line
- the `Recent reviews` panel gets a new entry

### C. Import A Chess.com Link Without The Extension

1. Copy a Chess.com game URL.
2. Paste it into the `Chess.com link` box.
3. Click `Import for review`.

This path works, but the extension is the better test path because it has more fallback options.

### D. Import From Chess.com With The Extension

This is the main product-shaped flow right now.

1. Finish a game on Chess.com.
2. Open the completed game page.
3. Click the extension icon.
4. A new local review tab should open.
5. The app should load the imported game in review mode.
6. After import, the URL should become a stable local route such as `/game/chesscom/<id>`.

Expected result:

- a new tab opens on the local app
- the review loads without needing manual PGN paste
- if the extension can identify the Chess.com account that clicked it, that player is shown at the bottom automatically, even when they were Black
- the game appears under `Recent reviews`
- refreshing the final `/game/...` page should still work in the same browser profile

## Chrome Extension Setup

The extension is documented in `extension/README.md`, but the short version is here too.

### Load The Extension

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the `extension/` folder

### Configure The Extension

1. In `chrome://extensions`, open the extension details page
2. Click `Extension options`
3. Set the app origin to:

```text
http://127.0.0.1:8000
```

If you run the server on another port, update that value to match.

When you later switch the extension to a custom deployed origin, Chrome may prompt once for host access to that new origin.

### Use The Extension

1. Keep `python3 serve.py` running
2. Open a completed Chess.com game page
3. Click the extension icon once

The extension currently tries these import sources in roughly this order:

1. PGN already exposed on the page
2. Chess.com public monthly archive PGN when a username/month match is available
3. Chess.com page-native move list data such as `moveList=...`
4. Structured move-list extraction from the DOM
5. Raw page HTML as a last-resort handoff

The goal is: open the review as soon as possible, then cache it locally.

## What Is Stored Locally

Two different kinds of local storage are used:

### Browser local storage

Imported games are cached in the browser so that:

- `Recent reviews` works
- `/game/chesscom/<id>` can reopen later
- refreshes are fast after the first import

Important:

- this cache is per browser profile
- if your friend changes browser or clears site storage, the local cache is gone

### Temporary server-side handoff records

The extension posts an import record to the local Python server first. That temporary handoff is then loaded by the app on `/import/<token>`.

Those records are temporary and only exist to move data from the extension into the app.

If `CHESS_TRAINER_DATA_DIR` is set, those handoff files are written there instead of under the repo working directory.

## What To Ask A Tester To Check

Here is a useful test checklist you can send directly.

### Basic app checks

- Does the app load at `http://127.0.0.1:8000`?
- Does the page reach `Stockfish ready`?
- Can you make moves on the board?
- Does Stockfish reply?
- Does the move tree update?

### Review checks

- Can you paste a PGN and get review mode?
- After PGN import, do evals and move grades start filling in?
- Does `Recent reviews` get a new item?
- Does the `Cached permalink` update?

### Chess.com extension checks

- Does the extension load in `chrome://extensions` without crashing?
- On a completed Chess.com game page, does clicking the extension open a review tab?
- Does the review show the actual imported game instead of a fresh starting board?
- After import, can you refresh the final `/game/...` page and still reopen the game?

### Branching checks

- In review mode, can you rewind and play a different move?
- Does that create a branch instead of deleting the imported main line?

## Known Limitations

At this stage, your friend should expect these limits:

- the app is local-only
- the extension must be loaded manually in developer mode
- the extension is meant for completed Chess.com game pages, not live assistance
- the app does not run automatic review during games in progress
- local review history is not synced across machines
- deployed instances still do not provide shared cross-user saved-game history
- some Chess.com pages may still need fallback handling if their DOM changes
- if automated import fails, manual PGN paste is still the fallback

## If Import Fails

The fastest fallback is:

1. open the Chess.com game page
2. copy/export the PGN from Chess.com
3. paste it into the app manually

That still tests the review engine even if the page-handoff path fails.

## Troubleshooting

### The app opens but stays on a fresh starting board after import

Check:

- the local server is still running
- the extension was reloaded after any code change
- the review tab was hard refreshed with `Ctrl+Shift+R`

### The extension opens a tab but no game loads

Check:

- the extension options origin matches the running server
- the Chess.com page is a completed game page
- the service worker console for the extension

### The extension seems loaded but clicking it does nothing

Open:

- `chrome://extensions`
- find `Review on Chess Trainer`
- click `service worker`

Then click the extension again and read the console output there.

### Recent reviews are missing

Remember:

- they are stored in browser local storage
- they are not shared between browsers or machines

## What To Send Back In A Bug Report

If your friend finds a bug, ask for:

1. the exact Chess.com URL, if relevant
2. what they clicked
3. what they expected
4. what actually happened
5. the `Status` line text from the app
6. the Python server terminal output
7. the extension service worker console output, if the extension was involved

That is enough to debug most issues quickly.

## Optional Developer Checks

Running the app does not require Node, but the repo includes tests.

Python tests:

```bash
python3 -m unittest discover -s tests -q
```

If Node is available, the combined test command is:

```bash
npm test
```

## Project Layout

```text
.
├── app.js
├── extension/
├── index.html
├── serve.py
├── src/
│   ├── adapters/
│   └── domain/
├── styles.css
├── tests/
└── vendor/stockfish/
```

High-level roles:

- `app.js`: main browser app and UI state
- `src/domain/`: chess rules, review logic, import normalization
- `src/adapters/`: Stockfish bridge, import clients, local cache
- `serve.py`: local file server and import handoff endpoints
- `extension/`: Chrome MV3 one-click Chess.com import

## Summary

If you only send one paragraph to a tester, send this:

Start the app with `python3 serve.py` or deploy it with the included Docker / Render files, open the app in a browser, confirm Stockfish works, then load the unpacked Chrome extension from `extension/`, finish or open a completed Chess.com game, click the extension, and confirm the review opens and appears under `Recent reviews`. If anything fails, send the app `Status` text, the server terminal output, and the extension service worker console output.
