# AGENTS.md

## Version
v1.0.2

## What this repo is
`Artee` — a browser drawing & tracing app. Plain static site: `index.html`, `styles.css`, `app.js`.
No `package.json`, no build step, no bundler, no ES modules. `app.js` is one large IIFE loaded via
`<script src="app.js"></script>` at the end of `index.html`. State lives in a single `state` object.

## Run & verify
- There are **no** automated tests, no lint, no typecheck, no build.
- `node --check app.js` only checks syntax (browser globals are fine for parsing). It is not a test.
- Real verification is manual: open `index.html` in a browser and exercise the tool you changed.
  For a local server, serve the folder (e.g. `python -m http.server`) — IndexedDB/gallery need a real origin.
- Never claim a UI/tool change works without loading it and checking.

## Architecture (non-obvious)
- `displayCanvas` = composited **output only**: white bg + reference image + drawing layers. Do not draw
  tool previews or edits here. Edits go to `layer.ctx`, then `scheduleRender()`.
- `overlayCanvas` = transient tool UI only (bézier handles, selection marching ants, transform boxes).
  Redraw with `renderOverlay()`. It is not part of the artwork.
- `recordingCanvas` = offscreen capture. Export/recording use `compositeDrawingOnly(targetCtx)`, which
  deliberately excludes the reference image.
- The **reference image is never part of the drawing or export.**
- `state.layers` is a tree of `{type:'layer'|'group'}` nodes; index 0 is the top. Use `getActiveLayer()`
  and `canEditActive()` before editing.
- Paint pipeline: pointer → `screenToDoc(clientX, clientY)` → mutate `layer.ctx` →
  `updateLayerThumbnail(id)` + `scheduleRender()`.
- `scheduleRender([rect])` coalesces repaints into one `requestAnimationFrame` **and** triggers autosave
  (`queueSave()`). Call it instead of painting synchronously. Overlay-only changes use `renderOverlay()`.
- Undo/redo: `pushUndo(layer)` snapshots that one layer's full `ImageData` before an edit; capped at
  `state.maxHistory` (40). There is no global multi-layer history.
- Persistence: IndexedDB `artee-db` / store `projects`, keys prefixed `meta:` (gallery listing) and
  `data:` (full payload). Accordion UI state is `localStorage['artee.acc']`. Don't add localStorage keys casually.
- Document is fixed 1920×1080 (`state.docWidth/docHeight`). Offscreen canvases are sized from it via
  `createOffscreenCanvas()`.

## Conventions & gotchas
- DOM is looked up by selector at load via `$`/`$$`. If you rename/add an id in `index.html`, update the
  matching `$('#...')` in `app.js` (and vice-versa).
- Adding or remapping a tool touches multiple places that must stay in sync: the `data-tool` button in
  `index.html`, the `title="... (X)"` tooltip, the `onKeyDown` shortcut switch, and `selectTool`/pointer handlers.
- All styling lives in `styles.css`; keep JS free of inline styles except existing dynamic positioning.
- Follow the existing section-banner comment style; don't add comments to self-explanatory code.
- Environment is Windows/PowerShell and this folder is **not** a git repository.

## Working rules
- Read the relevant source first; find the root cause before editing. Don't ship temporary fixes. Check
  for related bugs, edge cases, and side effects, and fix any error your change introduces.
- Make the smallest complete change yourself — don't hand back manual instructions. Don't redesign or
  remove features unless explicitly asked.
- For visual bugs, compare the screen against the relevant HTML/CSS/JS. Only inspect images that are
  actually attached and readable; say so plainly if you can't.
- After changes, report which files changed, what was fixed, and what verification you actually ran.
- Be direct and brief, use simple English. If something can't be done, state the exact limitation.
