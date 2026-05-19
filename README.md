# Chess Trainer

Small local chess trainer built around analysis, branching, and review rather than simply "playing an engine game".

The idea is:

- play against Stockfish if you want to train ideas
- see live evaluation while you play
- get move-by-move feedback
- rewind easily and try another branch
- import a finished game and review it with Stockfish

This project is intentionally lightweight. It is a browser app with one JavaScript file, one stylesheet, one HTML file, a tiny Python server, and a locally bundled Stockfish browser build.

## Quick Start

Clone the repo and run the local server:

```bash
git clone https://github.com/RayenGhanems/Chess-Trainer.git
cd Chess-Trainer
python3 serve.py
```

Then open:

```text
http://127.0.0.1:8000
```

If your system does not have `python3` as a command, try:

```bash
python serve.py
```

## Why This Exists

This project was built for players who want a study board more than an "engine battle" app.

The main goal is not:

- to beat Stockfish
- to play a polished online platform clone
- to build a huge chess database product

The main goal is:

- to test ideas against an engine quickly
- to see whether a move was good or bad immediately
- to rewind without friction
- to branch into another idea without losing the original line
- to import a real game and review it locally

In short, it is meant to feel closer to a training notebook than a competitive chess client.

## Who This Is For

This project is a good fit for:

- club players who want fast move feedback
- people studying their own games
- people who want a free local alternative to paid review tools
- developers or agents who want a small, hackable chess analysis app

This project is probably not the right fit if you want:

- online matchmaking
- cloud accounts and synced history
- a full tournament-grade GUI
- exact Chess.com or Lichess backend behavior

## Features

- Play as White or Black against Stockfish
- Live evaluation bar and best-move suggestion
- Configurable Stockfish reply delay so you can study the best reply before it is played
- Move grading with labels like `Best`, `Excellent`, `Good`, `Inaccuracy`, `Mistake`, `Blunder`
- Extra heuristic labels like `Great Move`, `Brilliant`, and `Miss`
- Board overlay arrow for the engine's best move
- Clear end-of-game presentation with final result text and board overlay
- Full move tree with branching and rewind/forward navigation
- Rewind and manually branch for either side to test alternate replies
- Drag-and-drop move input
- Click-to-move input
- Promotion modal
- Import a game from:
  - pasted PGN
  - pasted Chess.com game link
- Imported games are analyzed in the background so the full review fills in automatically

## What This Is Not

- Not a full tournament chess GUI
- Not a faithful clone of Chess.com review internals
- Not an opening explorer yet
- Not a database-backed app
- Not a server app with accounts, saved games, or multiplayer

## Requirements

- Python 3
- A modern browser

There is no Python package install step and no JavaScript build step.

You do not need to install any project-specific dependencies.

That means:

- no `pip install`
- no `npm install`
- no `yarn install`
- no build command
- Stockfish is already bundled in `vendor/stockfish/`

This project currently uses:

- Python standard library only for the local server
- plain browser JavaScript for the frontend
- bundled local Stockfish files under `vendor/stockfish/`

Optional but useful:

- Internet access if you want:
  - Chess.com piece images
  - Chess.com link import

The engine itself is bundled locally, so Stockfish does not depend on the internet.

## Install From GitHub

If you want to run the GitHub version locally, use:

```bash
git clone https://github.com/RayenGhanems/Chess-Trainer.git
cd Chess-Trainer
python3 serve.py
```

Then open:

```text
http://127.0.0.1:8000
```

## Setup Notes

There is nothing to install with `pip`, `npm`, or `yarn`.

That means:

- no `requirements.txt` is needed right now
- no `package.json` is needed right now
- no build command is needed right now

The only real setup requirement is that the machine can run:

```bash
python3
```

On systems where `python3` is not available, `python` may work instead.

## Run From The Project Directory

From the project directory:

```bash
python3 serve.py
```

Then open:

```text
http://127.0.0.1:8000
```

## How It Runs

This app runs in a very simple way:

1. `serve.py` starts a local HTTP server on `127.0.0.1:8000`.
2. Your browser loads `index.html`, `styles.css`, and `app.js`.
3. `app.js` starts a Web Worker using the bundled Stockfish files in `vendor/stockfish/`.
4. The UI renders the board and game tree entirely in the browser.
5. All move generation, branching, board rendering, and most analysis logic happen client-side.
6. The Python server is only used for:
   - serving the files
   - disabling cache during development
   - proxying Chess.com import requests through `/api/import-game`

So the architecture is:

- browser app first
- minimal Python helper second
- no database
- no backend state
- no authentication layer

## What Happens On Import

When you import a PGN or Chess.com game:

1. the game is parsed into moves
2. the full imported main line is built as a node tree
3. the app switches into review mode
4. the current imported position is analyzed immediately
5. Stockfish walks the rest of the imported line in the background
6. move grades and evaluations fill in as that pass completes

This is why imported reviews may continue improving for a short time after the board first appears, especially at higher depth settings.

## How To Use

### Play Mode

1. Start a new game.
2. Choose whether you want to play as White or Black.
3. Move pieces by:
   - clicking a piece and then a target square
   - dragging a piece onto a legal square
4. After your move:
   - Stockfish replies
   - the evaluation updates
   - the move gets graded
5. Use the navigation buttons to go backward and forward through the line.
6. If you go back and play a different move, a new branch is created.

### Review Mode

1. Paste a PGN into the import box, or paste a Chess.com game link.
2. Click `Import for review`.
3. The app will:
   - build the move tree for the imported game
   - jump to the final position
   - analyze the imported line in the background
4. You can browse immediately, and the evaluations/labels will continue filling in.

## Controls

- `|<`: go to the start
- `<`: go back one move
- `>`: go forward one move
- `>|`: go to the latest node
- `Flip board`: flip orientation
- `Show best move arrow`: toggle engine best-move arrow overlay
- `Coach depth`: change Stockfish depth

Keyboard:

- `Left Arrow`: back one move
- `Right Arrow`: forward one move

## Project Structure

```text
.
├── app.js
├── index.html
├── styles.css
├── serve.py
├── favicon.svg
└── vendor/
    └── stockfish/
        ├── stockfish-18-lite-single.js
        ├── stockfish-18-lite-single.wasm
        └── stockfish-18-asm.js
```

### File Roles

- `index.html`
  - page layout
  - board container
  - sidebar panels
  - import UI
  - promotion modal

- `styles.css`
  - page styling
  - board theme
  - move callout colors
  - drag layer visuals
  - import panel styling

- `app.js`
  - almost all application logic
  - chess rules and move generation
  - game tree state
  - Stockfish integration
  - move grading
  - review/import logic
  - board rendering
  - drag-and-drop handling

- `serve.py`
  - local static server
  - disables caching
  - exposes `/api/import-game` for Chess.com link import

- `vendor/stockfish/*`
  - bundled browser engine files

## Architecture

### 1. State Model

The app uses a node tree rather than a flat move list.

Each node represents one position and stores:

- `state`: board state
- `move`: move that led to this node
- `children`: continuations
- `preferredChildId`: chosen forward path from that node
- `analysis`: Stockfish result for that position
- `feedback`: grade for the move that led to the node
- `ply`: move depth

Important top-level app state in `app.js`:

- `app.nodes`
- `app.rootId`
- `app.currentNodeId`
- `app.latestNodeId`
- `app.mode` (`play` or `review`)

This makes branching easy. If you rewind and play something else, the app creates or reuses another child node instead of overwriting the line.

### 2. Chess Rules

`app.js` contains its own move generator and position logic.

Important functions:

- `generateLegalMoves`
- `generatePseudoMovesForPiece`
- `applyMove`
- `isInCheck`
- `isSquareAttacked`
- `generateFen`
- `parseFen`

Supported rules include:

- normal moves
- captures
- castling
- en passant
- promotion
- checkmate and stalemate detection

Not fully tracked yet:

- threefold repetition
- fifty-move rule draw claims
- insufficient material draw logic

### 3. Engine Integration

Stockfish is wrapped by `StockfishBridge`.

Important parts:

- `ENGINE_CANDIDATES`
- `StockfishBridge.init()`
- `StockfishBridge.analyze()`
- `parseEngineInfo()`

The app tries:

1. `stockfish-18-lite-single.js`
2. `stockfish-18-asm.js`

The engine is used for:

- current position evaluation
- best move suggestion
- engine replies in play mode
- grading imported games in review mode

### 4. Play Mode Flow

Main path:

- `commitPlayerMove`
- `requestEngineReplyForNode`
- `ensureEngineWorkForCurrentNode`

When you move:

1. the move is applied into the tree
2. the current node changes
3. Stockfish evaluates the new position
4. the move gets graded
5. Stockfish replies if the app is in play mode

### 5. Review Mode Flow

Main path:

- `parseImportedGame`
- `importParsedGame`
- `startReviewWarmup`
- `requestReviewDataForNode`

When you import a game:

1. PGN is parsed into a move list
2. the full main line is built into the node tree
3. the app switches to `review` mode
4. Stockfish starts a background warmup pass over the imported line
5. each move node gets:
   - position analysis
   - move feedback

The warmup pass is sequential because each move grade depends on the previous position's evaluation.

### 6. Import Pipeline

There are two import paths.

#### Pasted PGN

Handled entirely in the browser:

- `extractPgnText`
- `parsePgnHeaders`
- `tokenizePgnMoves`
- `matchSanMove`
- `parseImportedGame`

#### Chess.com Link

Handled in two steps:

1. Browser calls local endpoint:
   - `/api/import-game?url=...`
2. `serve.py` fetches the page server-side and returns the text
3. `app.js` tries to extract PGN-like content from the response

This exists because direct browser fetches to arbitrary Chess.com pages are usually blocked by CORS.

## Where To Change Things

This section is the main "future maintainer" map.

### Change the Board Theme

Edit CSS variables near the top of `styles.css`:

- `--light-square`
- `--dark-square`
- `--selected`
- `--target`
- `--capture`

### Change Piece Images

Edit `PIECE_IMAGE_BASE_URL` in `app.js`.

Current default points to Chess.com's `neo` set. If those images fail, the app falls back to Unicode piece glyphs.

If you want the app to be fully offline visually too, bundle local piece PNGs or SVGs and change `pieceAssetUrl()`.

### Change Move Labels / Grading Rules

Edit these in `app.js`:

- `buildMoveFeedback`
- `isBrilliantSacrifice`
- `isGreatMove`
- `isMiss`
- `PIECE_VALUES`

Important note:

The current labels are approximations. They are inspired by Chess.com-style review labels, but they are not generated by Chess.com's exact backend model.

### Change Engine Depth Limits

Edit the slider in `index.html`:

```html
<input type="range" id="depth-input" min="8" max="16" value="11">
```

And the engine behavior in:

- `ensureEngineWorkForCurrentNode`
- `startReviewWarmup`

### Change Best-Move Arrow Behavior

Edit:

- `renderBoardOverlay`
- `overlayPointForSquare`

### Change Board Input Behavior

Click input:

- `onBoardClick`

Drag-and-drop:

- `onBoardPointerDown`
- `onWindowPointerMove`
- `onWindowPointerUp`
- `onWindowPointerCancel`
- `renderDragLayer`

### Change Import Behavior

Browser-side PGN parsing:

- `extractPgnText`
- `tokenizePgnMoves`
- `matchSanMove`
- `parseImportedGame`

Server-side Chess.com fetching:

- `serve.py`
- `NoCacheHandler.handle_import_game`
- `ALLOWED_IMPORT_HOSTS`

### Change Review Warmup Behavior

Edit:

- `startReviewWarmup`
- `analyzeNodeForWarmup`
- `requestReviewDataForNode`
- `reviewWarmupMessage`

This is the part responsible for automatically filling imported games with evaluations and feedback in the background.

## Why There Are No `Book` Moves Yet

Stockfish alone cannot tell you that a move is a true opening-book move.

It can tell you:

- whether a move is strong
- whether it matches the best engine move
- how much evaluation was lost

But `Book` labeling normally comes from an opening database or opening explorer, not from raw engine analysis.

So right now:

- the app can grade opening moves as good/best/etc
- the app cannot honestly label them as `Book`

If you want to add this later, the clean solution is:

1. choose an opening database source
2. match the current move sequence against that database
3. if the move is in book, label it `Book`
4. stop using the `Book` label once the line leaves known theory

## Limitations

- Move classification is approximate, not Chess.com's exact system
- No opening-book database yet
- No persistent storage
- No multiplayer
- No PGN export yet
- No full draw-rule coverage
- Chess.com link import depends on the page still containing extractable PGN-like data
- Piece images come from Chess.com URLs unless you bundle your own local set

## Troubleshooting

### The page loads but Stockfish does not work

Check the engine status pill in the top-right corner.

Expected good state:

- `Stockfish ready`

If it fails:

- hard refresh with `Ctrl+Shift+R`
- confirm the `vendor/stockfish/` files are present
- make sure you started the page through `python3 serve.py` and not directly from the filesystem

### Imported game shows no feedback immediately

The app should now analyze the imported game in the background automatically.

If it still looks incomplete:

- wait for the import status line to finish
- lower the depth slider
- check whether the engine status says `Stockfish ready`

### Chess.com link import fails

Possible causes:

- Chess.com returned a different page shape
- network issue
- blocked host
- page content does not expose a PGN that the current parser can extract

Fallback:

- open the game on Chess.com
- copy the PGN
- paste the PGN directly into the import text area

### Port 8000 is already in use

Edit `serve.py` and change:

```python
ThreadingHTTPServer(("127.0.0.1", 8000), NoCacheHandler)
```

to another port, for example `8001`.

## Development Notes

- `serve.py` sends `Cache-Control: no-store`, so reload behavior is simpler during local edits.
- The app is intentionally plain JavaScript without a framework.
- There is no build step.
- Because everything is in `app.js`, the easiest way to make bigger future changes is usually to split it into modules once the feature set stabilizes.

## Suggested Future Improvements

- Real opening-book detection
- PGN export
- Save/load analysis locally
- Better move classification model
- Engine multi-PV support
- Arrows for played move plus best move comparison
- Local piece assets for fully offline visuals
- Decompose `app.js` into modules:
  - rules
  - engine
  - rendering
  - import/review
  - feedback

## License / Sharing

This repo is currently just a personal project structure. If you plan to publish it on GitHub and want other people to use or modify it, add an explicit license file such as `MIT`.

Without a license, people can view the code on GitHub, but the reuse rights are unclear.
