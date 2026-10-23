/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   Artee â€” Drawing & Tracing Studio  |  Application Logic
   ibisPaint X-style interface + reference tracing + recording
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

(function () {
  'use strict';

  // â”€â”€â”€ DOM References â”€â”€â”€
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  const displayCanvas = $('#displayCanvas');
  const displayCtx = displayCanvas.getContext('2d');
  const overlayCanvas = $('#overlayCanvas');
  const overlayCtx = overlayCanvas ? overlayCanvas.getContext('2d') : null;
  const recordingCanvas = $('#recordingCanvas');
  const recordingCtx = recordingCanvas.getContext('2d');
  const canvasArea = $('#canvasArea');
  const canvasViewport = $('#canvasViewport');
  const canvasWrapper = $('#canvasWrapper');
  const cursorPosEl = $('#cursorPos');
  const remoteStrokes = new Map();

  // â”€â”€â”€ Application State â”€â”€â”€
  const state = {
    docWidth: 1920,
    docHeight: 1080,

    // Project / gallery
    currentProjectId: null,
    currentProjectTitle: '',
    projectCreatedAt: 0,

    // View
    zoom: 1,
    panX: 0,
    panY: 0,
    viewRot: 0,

    // Tool:
    // 'brush' | 'eraser' | 'fill' | 'curve' | 'fade-shape' | 'text'
    // 'rect' | 'ellipse' | 'line'
    // 'transform' | 'select' | 'wand' | 'eyedropper' | 'move' | 'zoom'
    tool: 'brush',
    prevTool: null,

    // Brush
    brushSize: 5,
    brushOpacity: 1,
    brushColor: '#000000',
    brushType: 'pen',      // active brush type id (see BRUSH_TYPES)
    brushSettings: {},     // per-brush-type tweakable settings (hardness, spacing, flow, scatter, texture)
    stabilization: 0.45,   // 0 = raw, higher = smoother (pressure-like easing)
    // Force Fade â€” per painting tool, ibisPaint-style tapered/faded strokes.
    // All values are percentages (0-100). `length` = fraction of the stroke used
    // for the fade; `minThickness`/`minOpacity` = tip values.
    fade: {
      brush: { enabled: false, start: 0, end: 100, length: 35, minThickness: 12, minOpacity: 20 },
      eraser: { enabled: false, start: 0, end: 100, length: 35, minThickness: 12, minOpacity: 20 },
    },
    outputFollowView: true, // Output window mirrors the current zoom/pan instead of the whole canvas

    // Drawing
    isDrawing: false,
    points: [],
    smoothPoint: { x: 0, y: 0 },

    // Reference image (NEVER part of the drawing)
    refImage: null,
    refOpacity: 0.6,
    refVisible: true,
    refLocked: false,
    refX: 0,
    refY: 0,
    refScale: 1,
    refRotation: 0,

    // Layers: a tree of nodes (index 0 = top).
    //   layer: { id, type:'layer', name, canvas, ctx, visible, locked, opacity }
    //   group: { id, type:'group', name, visible, locked, opacity, expanded, children:[] }
    layers: [],
    activeLayerId: null,
    selectedNodeIds: new Set(),
    nextLayerId: 1,

    // History
    undoStack: [],
    redoStack: [],
    maxHistory: 40,

    // Recording
    isRecording: false,
    mediaRecorder: null,
    recordedChunks: [],
    recAnimFrame: null,

    // Input
    spaceHeld: false,
    altHeld: false,
    isPanning: false,
    panStartX: 0,
    panStartY: 0,
    panStartPanX: 0,
    panStartPanY: 0,
  };

  // True while the My Gallery screen is covering the workspace. Used to mute
  // editor keyboard shortcuts and to know the current project can be re-saved.
  let galleryOpen = false;

  // â”€â”€â”€ Fade Shape Tool State â”€â”€â”€
  const fadeShapeState = {
    shape: 'rect',
    fillMode: 'feather',
    feather: 30,
    isDrawing: false,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
  };

  // â”€â”€â”€ BÃ©zier Curve Tool State (3-step state machine) â”€â”€â”€
  const curveState = {
    step: 0, // 0 = idle, 1 = dragging end point, 2 = pulling curve control point
    p0: { x: 0, y: 0 },
    p1: { x: 0, y: 0 },
    cp: { x: 0, y: 0 },
    isPulling: false,
    isClosed: false,
    strokeShape: true,
    fillShape: false,
    points: [],
    selectedIdx: -1,
    dragTarget: null,
    isDragging: false,
    isCreatingDrag: false,
  };

  // â”€â”€â”€ Shape / Ruler Tools State (rectangle, ellipse, line) â”€â”€â”€
  const shapeState = {
    isDrawing: false,
    startX: 0, startY: 0,
    curX: 0, curY: 0,
    shift: false,
    fill: true,
    stroke: true,
    lineWidth: 5,
  };

  // â”€â”€â”€ Magic Wand (Select Detect) State â”€â”€â”€
  const wandState = {
    tolerance: 32,
    feather: 2,
    sampleAll: true,
  };

  // â”€â”€â”€ Fill Tool State â”€â”€â”€
  const fillState = { tolerance: 32, contiguous: true, eightWay: false, pixelArt: false, sampleAll: false };

  // â”€â”€â”€ Text Tool State â”€â”€â”€
  const textState = { size: 48, style: 'normal', docX: 0, docY: 0, editing: false, committing: false };

  // â”€â”€â”€ Selection State â”€â”€â”€
  // kind: 'rect' (hard marquee) or 'wand' (soft colour mask).
  // For 'wand', maskCanvas holds the soft alpha (tinted cyan) and
  // maskEdgeCanvas holds the 1px boundary used for the marching-ants overlay.
  const selectState = {
    active: false,
    kind: 'rect',
    x: 0, y: 0, w: 0, h: 0,
    isSelecting: false,
    startX: 0, startY: 0,
    antOffset: 0,
    animId: null,
    maskCanvas: null,
    maskEdgeCanvas: null,
    pixelCount: 0,
  };

  // â”€â”€â”€ Reference Transform Drag State â”€â”€â”€
  const transformState = {
    dragging: false,
    type: null,        // 'move' | 'scale' | 'rotate'
    corner: -1,
    lastDocX: 0, lastDocY: 0,
    startDocX: 0, startDocY: 0,
    startScale: 1,
    startRot: 0,
    startAngle: 0,
    startDist: 1,
  };

  // â”€â”€â”€ Layer Transform (Move Layer) State â”€â”€â”€
  const layerTransform = {
    active: false,
    layerId: null,
    snapshot: null,       // offscreen copy of the layer at session start
    bounds: null,         // { x, y, w, h } content bounding box (doc space)
    tx: 0, ty: 0,
    scale: 1,
    rotation: 0,
    dragging: false,
    type: null,           // 'move' | 'scale' | 'rotate'
    corner: -1,
    startDocX: 0, startDocY: 0,
    lastDocX: 0, lastDocY: 0,
    startScale: 1,
    startRotation: 0,
    startAngle: 0,
    undoPushed: false,
  };
  let layerTransformRAF = 0;

  // â”€â”€â”€ Color Presets â”€â”€â”€
  const PRESET_COLORS = [
    '#ffffff', '#c8c8c8', '#808080', '#404040', '#000000', '#1a1a1a',
    '#ef5350', '#e53935', '#ff7043', '#ff9800', '#ffc107', '#ffeb3b',
    '#66bb6a', '#43a047', '#26a69a', '#4fc3f7', '#2196f3', '#1565c0',
    '#7e57c2', '#ab47bc', '#ec407a', '#f06292', '#8d6e63', '#78909c',
  ];

  // Force Fade slider descriptors: [input selector, settings key, value label]
  const FADE_SLIDERS = [
    ['#fadeStart', 'start', '#fadeStartVal'],
    ['#fadeEnd', 'end', '#fadeEndVal'],
    ['#fadeLength', 'length', '#fadeLengthVal'],
    ['#fadeMinThickness', 'minThickness', '#fadeMinThicknessVal'],
    ['#fadeMinOpacity', 'minOpacity', '#fadeMinOpacityVal'],
  ];

  // â”€â”€â”€ Numeric inputs â†” sliders â”€â”€â”€
  // Writes a value to a number field without clobbering the user mid-typing.
  function setNumVal(el, value) {
    if (!el) return;
    if (document.activeElement === el) return;
    el.value = value;
  }

  // Keeps a number input and a range input perfectly in sync (both directions),
  // validating the typed value against the range's min/max.
  function bindNumberPair(numSel, rangeSel) {
    const num = $(numSel);
    const range = $(rangeSel);
    if (!num || !range) return;
    // Read bounds dynamically so callers can retarget the pair (e.g. filters).
    const clamp = (v) => Math.min(parseFloat(range.max), Math.max(parseFloat(range.min), v));
    const pushToRange = (v) => {
      range.value = v;
      range.dispatchEvent(new Event('input', { bubbles: true }));
    };
    // Typing updates the slider live (kept within range, but the field itself is
    // left untouched so the user can keep typing intermediate values).
    num.addEventListener('input', () => {
      if (num.value === '' || num.value === '-') return;
      const v = parseFloat(num.value);
      if (isNaN(v)) return;
      pushToRange(clamp(v));
    });
    // On commit, snap the field to a valid in-range integer.
    const normalize = () => {
      let v = parseFloat(num.value);
      if (isNaN(v)) v = parseFloat(range.value);
      v = clamp(v);
      num.value = v;
      pushToRange(v);
    };
    num.addEventListener('change', normalize);
    num.addEventListener('blur', normalize);
    num.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); normalize(); num.blur(); }
    });
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     INITIALIZATION
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  async function init() {
    bindEvents();
    createBrushCursor();
    createColorPresets();
    buildBrushTypeGrid();
    buildTextureChips();
    buildFilterGrid();
    updateFilterUI();
    initAccordions();
    updateToolSettingsPanel();
    setColor(state.brushColor);
    updateBrushPreview();
    canvasArea.setAttribute('data-tool', state.tool);
    updateRefToggleIcon();

    // Use the shared server store when available, then join live sync.
    try { await detectServerStorage(); } catch (e) { /* stay on IndexedDB */ }
    connectLiveSync();

    // Bring any older single-slot save into the new multi-project store, then
    // land on the gallery. Nothing is opened until the user picks a project.
    try { await migrateLegacyProject(); } catch (e) { /* ignore migration issues */ }
    await openGallery();
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     LAYER SYSTEM
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function createOffscreenCanvas() {
    const c = document.createElement('canvas');
    c.width = state.docWidth;
    c.height = state.docHeight;
    return c;
  }

  function isGroupNode(node) { return !!node && node.type === 'group'; }

  // Depth-first search for a node by id anywhere in the tree.
  function findNode(id, nodes) {
    nodes = nodes || state.layers;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.id === id) return n;
      if (isGroupNode(n)) {
        const found = findNode(id, n.children);
        if (found) return found;
      }
    }
    return null;
  }

  // Locates the array that holds `id` plus its index and owning group (if any).
  function findParentOf(id, nodes, parent) {
    nodes = nodes || state.layers;
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].id === id) return { arr: nodes, index: i, parent: parent || null };
      if (isGroupNode(nodes[i])) {
        const r = findParentOf(id, nodes[i].children, nodes[i]);
        if (r) return r;
      }
    }
    return null;
  }

  function isDescendantOf(id, ancestorId) {
    const anc = findNode(ancestorId);
    if (!anc || !isGroupNode(anc)) return false;
    return !!findNode(id, anc.children);
  }

  function countLayerNodes(nodes) {
    nodes = nodes || state.layers;
    let c = 0;
    for (const n of nodes) c += isGroupNode(n) ? countLayerNodes(n.children) : 1;
    return c;
  }

  function bottomLayerOfGroup(group) {
    if (!isGroupNode(group) || !group.children.length) return null;
    const last = group.children[group.children.length - 1];
    return isGroupNode(last) ? bottomLayerOfGroup(last) : last;
  }

  // Visibility/lock consider all ancestor groups so hidden/locked folders
  // protect the layers inside them.
  function nodeHidden(id) {
    let nodes = state.layers;
    const chain = [];
    (function walk(list) {
      for (const n of list) {
        chain.push(n);
        if (n.id === id) return true;
        if (isGroupNode(n) && walk(n.children)) return true;
        chain.pop();
      }
      return false;
    })(nodes);
    for (const n of chain) if (n.visible === false) return true;
    return false;
  }

  function nodeLocked(id) {
    let nodes = state.layers;
    const chain = [];
    (function walk(list) {
      for (const n of list) {
        chain.push(n);
        if (n.id === id) return true;
        if (isGroupNode(n) && walk(n.children)) return true;
        chain.pop();
      }
      return false;
    })(nodes);
    for (const n of chain) if (n.locked) return true;
    return false;
  }

  function getActiveNode() { return findNode(state.activeLayerId); }

  function getActiveLayer() {
    const n = getActiveNode();
    return (n && !isGroupNode(n)) ? n : null;
  }

  // True when the active node is an editable layer (not a folder, not locked,
  // not hidden by itself or an ancestor folder). Shows a toast otherwise.
  function canEditActive() {
    const node = getActiveNode();
    if (!node || isGroupNode(node)) { showToast('Select a layer to draw on', 'error'); return false; }
    if (nodeLocked(node.id)) { showToast('Layer is locked', 'error'); return false; }
    if (nodeHidden(node.id)) { showToast('Layer is hidden', 'error'); return false; }
    return true;
  }

  // â”€â”€â”€ Mutations â”€â”€â”€

  function createLayer(name, parentGroup, atBottom) {
    const canvas = createOffscreenCanvas();
    const layer = {
      id: state.nextLayerId++,
      type: 'layer',
      name: name || `Layer ${state.nextLayerId - 1}`,
      canvas,
      ctx: canvas.getContext('2d'),
      visible: true,
      locked: false,
      opacity: 1,
    };
    const arr = parentGroup ? parentGroup.children : state.layers;
    if (atBottom) arr.push(layer); else arr.unshift(layer);
    if (parentGroup) parentGroup.expanded = true;
    state.activeLayerId = layer.id;
    state.selectedNodeIds = new Set([layer.id]);
    updateLayerList();
    scheduleRender();
    queueSave();
    return layer;
  }

  function createGroup(name, parentGroup) {
    const group = {
      id: state.nextLayerId++,
      type: 'group',
      name: name || `Folder ${state.nextLayerId - 1}`,
      visible: true,
      locked: false,
      opacity: 1,
      expanded: true,
      children: [],
    };
    const arr = parentGroup ? parentGroup.children : state.layers;
    arr.unshift(group);
    if (parentGroup) parentGroup.expanded = true;
    state.activeLayerId = group.id;
    state.selectedNodeIds = new Set([group.id]);
    updateLayerList();
    queueSave();
    return group;
  }

  function deleteNode(id) {
    const loc = findParentOf(id);
    if (!loc) return;
    const node = loc.arr[loc.index];
    const removedLayers = isGroupNode(node) ? countLayerNodes(node.children) : 1;
    if (countLayerNodes() - removedLayers < 1) { showToast('Need at least one layer', 'error'); return; }

    const wasActive = state.activeLayerId === id || (isGroupNode(node) && !!findNode(state.activeLayerId, node.children));
    loc.arr.splice(loc.index, 1);
    state.selectedNodeIds.delete(id);

    if (wasActive) {
      if (loc.arr.length) {
        state.activeLayerId = loc.arr[Math.min(loc.index, loc.arr.length - 1)].id;
      } else if (loc.parent) {
        state.activeLayerId = loc.parent.id;
      } else {
        state.activeLayerId = state.layers.length ? state.layers[0].id : null;
      }
    }
    // Purge selection entries that no longer exist.
    for (const sid of Array.from(state.selectedNodeIds)) if (!findNode(sid)) state.selectedNodeIds.delete(sid);
    updateLayerList();
    scheduleRender();
    queueSave();
  }

  function cloneNode(node) {
    if (isGroupNode(node)) {
      return {
        id: state.nextLayerId++,
        type: 'group',
        name: node.name,
        visible: node.visible,
        locked: node.locked,
        opacity: node.opacity,
        expanded: node.expanded,
        children: node.children.map(cloneNode),
      };
    }
    const canvas = createOffscreenCanvas();
    const ctx = canvas.getContext('2d');
    ctx.drawImage(node.canvas, 0, 0);
    return {
      id: state.nextLayerId++,
      type: 'layer',
      name: node.name,
      canvas, ctx,
      visible: node.visible,
      locked: node.locked,
      opacity: node.opacity,
    };
  }

  function duplicateNode(id) {
    const loc = findParentOf(id);
    if (!loc) return;
    const src = loc.arr[loc.index];
    const copy = cloneNode(src);
    copy.name = src.name + ' copy';
    loc.arr.splice(loc.index, 0, copy); // directly above the original
    state.activeLayerId = copy.id;
    state.selectedNodeIds = new Set([copy.id]);
    updateLayerList();
    scheduleRender();
    queueSave();
    return copy;
  }

  function renameNode(id, name) {
    const node = findNode(id);
    if (!node) return;
    const clean = (name || '').trim();
    if (clean) node.name = clean.slice(0, 40);
    updateLayerList();
    queueSave();
  }

  function setNodeVisible(id, visible) {
    const node = findNode(id);
    if (!node) return;
    node.visible = visible;
    updateLayerList();
    scheduleRender();
    queueSave();
  }

  function setNodeLocked(id, locked) {
    const node = findNode(id);
    if (!node) return;
    node.locked = locked;
    if (locked) { /* nothing else */ }
    updateLayerList();
    if (!locked) renderOverlay();
    queueSave();
  }

  function setNodeOpacity(id, value) {
    const node = findNode(id);
    if (!node) return;
    node.opacity = Math.max(0, Math.min(1, value));
    scheduleRender();
    queueSave();
  }

  function toggleNodeExpanded(id) {
    const node = findNode(id);
    if (!node || !isGroupNode(node)) return;
    node.expanded = !node.expanded;
    updateLayerList();
    queueSave();
  }

  function moveNode(id, dir) {
    const loc = findParentOf(id);
    if (!loc) return;
    const ni = loc.index + dir;
    if (ni < 0 || ni >= loc.arr.length) return;
    [loc.arr[loc.index], loc.arr[ni]] = [loc.arr[ni], loc.arr[loc.index]];
    updateLayerList();
    scheduleRender();
    queueSave();
  }

  // Drag-and-drop reparent / reorder. position: 'before' | 'after' | 'inside'.
  function reorderNode(dragId, targetId, position) {
    if (dragId === targetId) return;
    const from = findParentOf(dragId);
    const target = findNode(targetId);
    if (!from || !target) return;
    // Never drop a group into its own subtree.
    if (isDescendantOf(targetId, dragId)) return;

    const node = from.arr[from.index];
    from.arr.splice(from.index, 1);

    if (position === 'inside' && isGroupNode(target)) {
      target.children.unshift(node);
      target.expanded = true;
    } else {
      const tp = findParentOf(targetId); // recompute: indexes may have shifted
      if (!tp) { from.arr.splice(from.index, 0, node); return; }
      const insertAt = position === 'before' ? tp.index : tp.index + 1;
      tp.arr.splice(insertAt, 0, node);
    }
    updateLayerList();
    scheduleRender();
    queueSave();
  }

  function clearNode(id) {
    const node = findNode(id);
    if (!node) return;
    if (nodeLocked(id)) { showToast('Layer is locked', 'error'); return; }
    if (isGroupNode(node)) {
      let any = false;
      (function walk(n) {
        for (const c of n.children) {
          if (isGroupNode(c)) walk(c);
          else { pushUndo(c); c.ctx.clearRect(0, 0, state.docWidth, state.docHeight); updateLayerThumbnail(c.id); any = true; }
        }
      })(node);
      if (!any) { showToast('Folder is empty', 'error'); return; }
    } else {
      pushUndo(node);
      node.ctx.clearRect(0, 0, state.docWidth, state.docHeight);
      updateLayerThumbnail(node.id);
    }
    scheduleRender();
    showToast('Layer cleared');
  }

  // Merge the given layer down into the sibling below it (bakes into that layer).
  function mergeDown(id) {
    const node = findNode(id);
    if (!node || isGroupNode(node)) { showToast('Select a layer to merge down', 'error'); return; }
    const loc = findParentOf(id);
    const below = loc.arr[loc.index + 1];
    if (!below) { showToast('No layer below to merge into', 'error'); return; }
    const target = isGroupNode(below) ? bottomLayerOfGroup(below) : below;
    if (!target) { showToast('Folder below is empty', 'error'); return; }

    // Bake `node` onto `target`, honouring the merged layer's opacity.
    const tctx = target.ctx;
    tctx.save();
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.globalAlpha = node.opacity;
    tctx.globalCompositeOperation = 'source-over';
    tctx.drawImage(node.canvas, 0, 0);
    tctx.restore();

    loc.arr.splice(loc.index, 1);
    state.selectedNodeIds.delete(id);
    state.activeLayerId = target.id;
    state.selectedNodeIds = new Set([target.id]);
    updateLayerThumbnail(target.id);
    updateLayerList();
    scheduleRender();
    queueSave();
    showToast('Merged down');
  }

  function mergeSelectedLayers() {
    const ids = Array.from(state.selectedNodeIds).filter(id => {
      const n = findNode(id);
      return n && !isGroupNode(n);
    });
    if (ids.length < 2) { showToast('Select two or more layers to merge', 'error'); return; }
    const locs = ids.map(id => findParentOf(id));
    if (!locs.every(l => l && l.arr === locs[0].arr)) {
      showToast('Selected layers must be in the same group', 'error');
      return;
    }
    const arr = locs[0].arr;
    const entries = locs.map((l, i) => ({ id: ids[i], index: l.index })).sort((a, b) => a.index - b.index);
    const targetId = entries[entries.length - 1].id; // bottom-most selected
    const target = findNode(targetId);

    // Draw the other selected layers (bottom-to-top) onto the target.
    const others = entries.slice(0, entries.length - 1).sort((a, b) => b.index - a.index);
    for (const o of others) {
      const loc = findParentOf(o.id);
      if (!loc) continue;
      const other = loc.arr[loc.index];
      target.ctx.save();
      target.ctx.setTransform(1, 0, 0, 1, 0, 0);
      target.ctx.globalAlpha = other.opacity;
      target.ctx.globalCompositeOperation = 'source-over';
      target.ctx.drawImage(other.canvas, 0, 0);
      target.ctx.restore();
      loc.arr.splice(loc.index, 1);
    }
    state.activeLayerId = target.id;
    state.selectedNodeIds = new Set([target.id]);
    updateLayerThumbnail(target.id);
    updateLayerList();
    scheduleRender();
    queueSave();
    showToast('Merged ' + ids.length + ' layers');
  }

  // Moves a layer into the nearest group (or out to the top level).
  function moveNodeIntoGroup(id, groupId) {
    if (!groupId) {
      const loc = findParentOf(id);
      if (!loc || loc.parent === null) return;
      const node = loc.arr[loc.index];
      loc.arr.splice(loc.index, 1);
      state.layers.unshift(node);
      updateLayerList();
      scheduleRender();
      queueSave();
      return;
    }
    reorderNode(id, groupId, 'inside');
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     RENDERING  (dirty-rect compositing + rAF scheduling)
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  let renderQueued = false;
  let renderRAF = 0;
  let pendingDirty = null; // {x,y,w,h} or 'full'

  // Every repaint goes through exactly one requestAnimationFrame. Input handlers
  // only mark the document dirty, so 120/240 Hz pointer events can never block
  // the UI thread with synchronous canvas work on iPad/iOS.
  function scheduleRender(rect, noSave) {
    if (!rect) {
      pendingDirty = 'full';
    } else if (pendingDirty !== 'full') {
      const rx = Number(rect.x), ry = Number(rect.y), rw = Number(rect.w), rh = Number(rect.h);
      if (!isFinite(rx) || !isFinite(ry) || !isFinite(rw) || !isFinite(rh) || rw <= 0 || rh <= 0) {
        pendingDirty = 'full';
      } else if (!pendingDirty) {
        pendingDirty = { x: rx, y: ry, w: rw, h: rh };
      } else {
        const x1 = Math.min(pendingDirty.x, rx);
        const y1 = Math.min(pendingDirty.y, ry);
        const x2 = Math.max(pendingDirty.x + pendingDirty.w, rx + rw);
        const y2 = Math.max(pendingDirty.y + pendingDirty.h, ry + rh);
        pendingDirty = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      }
    }
    if (!renderQueued) {
      renderQueued = true;
      try {
        if (typeof document !== 'undefined' && document.hidden) {
          setTimeout(flushRender, 16);
        } else {
          renderRAF = requestAnimationFrame(flushRender);
        }
      } catch (e) {
        renderRAF = 0;
        setTimeout(flushRender, 16);
      }
    }
    if (!noSave) queueSave();
  }

  function flushRender() {
    if (renderRAF) {
      try { cancelAnimationFrame(renderRAF); } catch (e) {}
      renderRAF = 0;
    }
    renderQueued = false;
    const dirty = pendingDirty;
    pendingDirty = null;
    try {
      if (dirty && dirty !== 'full') compositeRegion(dirty.x, dirty.y, dirty.w, dirty.h);
      else compositeDisplay();
    } catch (e) {}
    try {
      updateOutputWindow();
    } catch (e) {}
  }

  function drawReference(ctx) {
    if (!state.refImage || !state.refVisible) return;
    const img = state.refImage;
    ctx.save();
    ctx.globalAlpha = state.refOpacity;
    ctx.translate(state.refX, state.refY);
    ctx.rotate(state.refRotation);
    ctx.scale(state.refScale, state.refScale);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    ctx.restore();
  }

  // Scratch canvases (one per nesting depth) used to composite an entire group
  // as a single unit when the group has its own opacity.
  const groupBufferPool = [];
  function getGroupBuffer(depth) {
    if (!groupBufferPool[depth]) {
      const canvas = createOffscreenCanvas();
      groupBufferPool[depth] = { canvas, ctx: canvas.getContext('2d') };
    }
    return groupBufferPool[depth];
  }

  function drawNodes(ctx, nodes, depth) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (!node.visible || node.opacity <= 0) continue;
      if (isGroupNode(node)) {
        if (node.opacity >= 1) {
          drawNodes(ctx, node.children, depth + 1);
        } else {
          const buf = getGroupBuffer(depth);
          buf.ctx.setTransform(1, 0, 0, 1, 0, 0);
          buf.ctx.clearRect(0, 0, state.docWidth, state.docHeight);
          drawNodes(buf.ctx, node.children, depth + 1);
          ctx.save();
          ctx.globalAlpha = node.opacity;
          ctx.drawImage(buf.canvas, 0, 0);
          ctx.restore();
        }
      } else {
        ctx.save();
        ctx.globalAlpha = node.opacity;
        ctx.drawImage(node.canvas, 0, 0);
        ctx.restore();
      }
    }
  }

  function drawLayers(ctx) {
    drawNodes(ctx, state.layers, 0);
  }

  function compositeDisplay() {
    const w = state.docWidth, h = state.docHeight;
    displayCtx.setTransform(1, 0, 0, 1, 0, 0);
    displayCtx.globalAlpha = 1;
    displayCtx.globalCompositeOperation = 'source-over';
    displayCtx.clearRect(0, 0, w, h);
    displayCtx.fillStyle = '#ffffff';
    displayCtx.fillRect(0, 0, w, h);
    drawReference(displayCtx);
    drawLayers(displayCtx);
  }

  // Repaints only the dirty document rectangle. During a live stroke this is
  // usually a few hundred pixels instead of the full 1920x1080 composite, which
  // is what keeps ProMotion iPads at their frame budget.
  function compositeRegion(rx, ry, rw, rh) {
    const w = state.docWidth, h = state.docHeight;
    const x0 = Math.max(0, Math.floor(rx));
    const y0 = Math.max(0, Math.floor(ry));
    const x1 = Math.min(w, Math.ceil(rx + rw));
    const y1 = Math.min(h, Math.ceil(ry + rh));
    if (!(x1 > x0) || !(y1 > y0)) return;
    displayCtx.setTransform(1, 0, 0, 1, 0, 0);
    displayCtx.globalAlpha = 1;
    displayCtx.globalCompositeOperation = 'source-over';
    displayCtx.save();
    displayCtx.beginPath();
    displayCtx.rect(x0, y0, x1 - x0, y1 - y0);
    displayCtx.clip();
    displayCtx.fillStyle = '#ffffff';
    displayCtx.fillRect(x0, y0, x1 - x0, y1 - y0);
    drawReference(displayCtx);
    drawLayers(displayCtx);
    displayCtx.restore();
  }

  /** Composite only drawing layers (no reference) â€” used for export & recording */
  function compositeDrawingOnly(targetCtx) {
    const w = state.docWidth, h = state.docHeight;
    targetCtx.setTransform(1, 0, 0, 1, 0, 0);
    targetCtx.clearRect(0, 0, w, h);
    targetCtx.fillStyle = '#ffffff';
    targetCtx.fillRect(0, 0, w, h);
    drawNodes(targetCtx, state.layers, 0);
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     ZOOM & PAN
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function updateCanvasTransform() {
    const rot = state.viewRot ? ` rotate(${state.viewRot}rad)` : '';
    canvasWrapper.style.transform = `translate(${state.panX}px, ${state.panY}px)${rot} scale(${state.zoom})`;
    $('#zoomLevel').textContent = Math.round(state.zoom * 100) + '%';
    updateBrushCursor();
    scheduleOutputUpdate();
  }

  function setZoom(newZoom, centerX, centerY) {
    const clamped = Math.max(0.05, Math.min(32, newZoom));
    if (centerX !== undefined && centerY !== undefined) {
      const ratio = clamped / state.zoom;
      state.panX = centerX - (centerX - state.panX) * ratio;
      state.panY = centerY - (centerY - state.panY) * ratio;
    }
    state.zoom = clamped;
    updateCanvasTransform();
    if (state.tool === 'transform') renderOverlay();
  }

  function fitCanvasToView() {
    const rect = canvasViewport.getBoundingClientRect();
    const pad = 34;
    const availW = Math.max(40, rect.width - pad * 2);
    const availH = Math.max(40, rect.height - pad * 2);
    const scale = Math.min(availW / state.docWidth, availH / state.docHeight, 1);
    state.zoom = scale;
    state.viewRot = 0;
    state.panX = Math.round((rect.width - state.docWidth * scale) / 2);
    state.panY = Math.round((rect.height - state.docHeight * scale) / 2);
    updateCanvasTransform();
  }

  function zoomReset() {
    const rect = canvasViewport.getBoundingClientRect();
    state.zoom = 1;
    state.viewRot = 0;
    state.panX = Math.round((rect.width - state.docWidth) / 2);
    state.panY = Math.round((rect.height - state.docHeight) / 2);
    updateCanvasTransform();
  }

  // Allocation-free variant for the hot stroke path. Pass a cached viewport
  // rect when converting a whole frame of queued points.
  function screenToDocInto(sx, sy, out, rect) {
    const r = rect || canvasViewport.getBoundingClientRect();
    let x = sx - r.left - state.panX;
    let y = sy - r.top - state.panY;
    if (state.viewRot) {
      const c = Math.cos(-state.viewRot), s = Math.sin(-state.viewRot);
      const rx = x * c - y * s;
      const ry = x * s + y * c;
      x = rx; y = ry;
    }
    out.x = x / state.zoom;
    out.y = y / state.zoom;
    return out;
  }

  function screenToDoc(sx, sy) {
    return screenToDocInto(sx, sy, { x: 0, y: 0 });
  }

  function docToScreen(dx, dy) {
    const rect = canvasViewport.getBoundingClientRect();
    let x = dx * state.zoom, y = dy * state.zoom;
    if (state.viewRot) {
      const c = Math.cos(state.viewRot), s = Math.sin(state.viewRot);
      const rx = x * c - y * s;
      const ry = x * s + y * c;
      x = rx; y = ry;
    }
    return { x: rect.left + state.panX + x, y: rect.top + state.panY + y };
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     DRAWING ENGINE  (smoothed / stabilized strokes)
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function applySelectionClip(ctx) {
    if (!selectState.active) return false;
    // A wand selection is a soft raster mask, which cannot be expressed as a
    // path. Callers that composite a delta use drawDeltaMasked()/paintDelta()
    // which apply the mask itself; here we only bound the clip to the mask's
    // bounding box so rect-style callers stay safe.
    ctx.beginPath();
    ctx.rect(selectState.x, selectState.y, selectState.w, selectState.h);
    ctx.clip();
    return true;
  }

  // True while a soft magic-wand selection is active.
  function wandActive() {
    return selectState.active && selectState.kind === 'wand' && !!selectState.maskCanvas;
  }

  // Scratch canvases reused for masking drawing deltas (avoids per-frame allocs).
  let wandMaskCanvas = null;
  function getWandMaskScratch() {
    if (!wandMaskCanvas) wandMaskCanvas = createOffscreenCanvas();
    return wandMaskCanvas;
  }
  let wandPaintCanvas = null;
  function getWandPaintScratch() {
    if (!wandPaintCanvas) wandPaintCanvas = createOffscreenCanvas();
    return wandPaintCanvas;
  }

  // Draws a full-document `src` delta into `dstCtx`, multiplied by the wand mask
  // when one is active. The mask's alpha is the selection, so the result keeps
  // smooth, anti-aliased edges and leaves no jagged pixels behind.
  function drawDeltaMasked(dstCtx, src) {
    if (!wandActive()) { dstCtx.drawImage(src, 0, 0); return; }
    const scratch = getWandMaskScratch();
    const sctx = scratch.getContext('2d');
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = 'source-over';
    sctx.clearRect(0, 0, state.docWidth, state.docHeight);
    sctx.drawImage(src, 0, 0);
    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(selectState.maskCanvas, 0, 0);
    sctx.globalCompositeOperation = 'source-over';
    dstCtx.drawImage(scratch, 0, 0);
  }

  // Paints a one-shot delta (text / shape / curve) honouring both the rect
  // marquee and the soft wand mask, then composites it onto the layer.
  function paintDelta(layer, fn) {
    const scratch = getWandPaintScratch();
    const c = scratch.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, state.docWidth, state.docHeight);
    c.save();
    if (selectState.active && selectState.kind === 'rect') {
      c.beginPath();
      c.rect(selectState.x, selectState.y, selectState.w, selectState.h);
      c.clip();
    }
    fn(c);
    c.restore();
    if (wandActive()) {
      const m = getWandMaskScratch();
      const mctx = m.getContext('2d');
      mctx.setTransform(1, 0, 0, 1, 0, 0);
      mctx.globalCompositeOperation = 'source-over';
      mctx.clearRect(0, 0, state.docWidth, state.docHeight);
      mctx.drawImage(scratch, 0, 0);
      mctx.globalCompositeOperation = 'destination-in';
      mctx.drawImage(selectState.maskCanvas, 0, 0);
      mctx.globalCompositeOperation = 'source-over';
      c.clearRect(0, 0, state.docWidth, state.docHeight);
      c.drawImage(m, 0, 0);
    }
    layer.ctx.save();
    layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
    layer.ctx.globalCompositeOperation = (state.tool === 'eraser') ? 'destination-out' : 'source-over';
    layer.ctx.globalAlpha = 1;
    layer.ctx.drawImage(scratch, 0, 0);
    layer.ctx.restore();
  }

  // â”€â”€â”€ Off-Screen Stroke Buffer System â”€â”€â”€
  let strokeSnapshotCanvas = null; // Clean pre-stroke snapshot of the active layer
  let strokeBufferCanvas = null;   // Active stroke path drawn at 100% opacity
  let strokeBufferCtx = null;
  let fadeBBox = null;             // { minX, minY, maxX, maxY }
  let fadeRAF = null;              // Coalesces stroke re-renders to one per animation frame
  let fadePending = false;
  let fadeScratchCanvas = null;    // Reusable raster for the arc-length fade mask

  function defaultFadeSettings() {
    return { enabled: false, start: 0, end: 100, length: 35, minThickness: 12, minOpacity: 20 };
  }

  // Force Fade settings for the currently active painting tool. Stored per-tool
  // so the brush and eraser keep independent fade setups.
  function getFadeSettings() {
    const key = (state.tool === 'eraser') ? 'eraser' : 'brush';
    if (!state.fade[key]) {
      state.fade[key] = defaultFadeSettings();
      try {
        if (typeof localStorage !== 'undefined') {
          if (localStorage.getItem('artee.forceFade') === '1') state.fade[key].enabled = true;
          const vs = localStorage.getItem('artee.fadeStart'); if (vs != null) state.fade[key].start = parseInt(vs);
          const ve = localStorage.getItem('artee.fadeEnd'); if (ve != null) state.fade[key].end = parseInt(ve);
          const vl = localStorage.getItem('artee.fadeLength'); if (vl != null) state.fade[key].length = parseInt(vl);
          const vm = localStorage.getItem('artee.fadeMinThickness'); if (vm != null) state.fade[key].minThickness = parseInt(vm);
          const vo = localStorage.getItem('artee.fadeMinOpacity'); if (vo != null) state.fade[key].minOpacity = parseInt(vo);
        }
      } catch (ex) {}
    }
    return state.fade[key];
  }

  // Loads Force Fade settings from a saved project, migrating the older flat
  // { fadeEnds, fadeLength } format when necessary.
  function restoreFade(fadeData, legacyBrush) {
    const def = defaultFadeSettings();
    const pick = (src) => {
      const out = Object.assign({}, def);
      if (src) {
        for (const k in def) if (src[k] != null) out[k] = src[k];
      }
      // Coerce every numeric field to a finite number so a corrupt save cannot
      // inject NaN/negatives into the fade profile.
      for (const k of ['start', 'end', 'length', 'minThickness', 'minOpacity']) {
        const n = Number(out[k]);
        out[k] = isFinite(n) ? n : def[k];
      }
      out.enabled = !!out.enabled;
      return out;
    };
    if (fadeData && (fadeData.brush || fadeData.eraser)) {
      state.fade = { brush: pick(fadeData.brush), eraser: pick(fadeData.eraser) };
    } else {
      state.fade = { brush: pick(null), eraser: pick(null) };
    }
    if (legacyBrush && (legacyBrush.fadeEnds != null || legacyBrush.fadeLength != null)) {
      const on = !!legacyBrush.fadeEnds;
      state.fade.brush.enabled = on;
      state.fade.eraser.enabled = on;
    }
  }

  function isFadeStroke() {
    if (state.tool !== 'brush' && state.tool !== 'eraser') return false;
    const cfg = getFadeSettings();
    if (!cfg) return false;
    return !!cfg.enabled;
  }

  // Restored projects can carry a corrupt brush size/opacity. Canvas APIs
  // silently drop (or throw on) non-positive sizes, which looks like a stroke
  // that only paints in patches â€” so clamp both before every stroke op.
  function safeBrushSize() {
    const v = Number(state.brushSize);
    if (!isFinite(v) || v <= 0) return 5;
    return Math.min(4000, v);
  }

  function safeBrushOpacity() {
    const v = Number(state.brushOpacity);
    if (!isFinite(v)) return 1;
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  function unionBox(a, b) {
    if (!a) return { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
    return {
      x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
      x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
    };
  }

  function fadeSmooth(t) {
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    return t * t * (3 - 2 * t);
  }

  // Returns width/opacity multipliers (0..1) at normalized arc position s (0..1),
  // or dynamically scaled based on arc-length distances (dStart, dEnd, fadeDist).
  function fadeProfile(s, cfg, dStart, dEnd, fadeDist) {
    // Restored projects can carry out-of-range or non-numeric fade values;
    // sanitizing here keeps NaN/negatives out of every radius & alpha calc.
    const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
    const f = Math.max(0.001, Math.min(1, num(cfg.length, 35) / 100));
    const startStr = Math.max(0, Math.min(1, num(cfg.start, 0) / 100));
    const endStr = Math.max(0, Math.min(1, num(cfg.end, 100) / 100));
    const minW = Math.max(0.01, Math.min(1, num(cfg.minThickness, 12) / 100));
    const minO = Math.max(0, Math.min(1, num(cfg.minOpacity, 20) / 100));

    let w = 1, o = 1;

    if (dStart !== undefined && dEnd !== undefined && fadeDist !== undefined && fadeDist > 0) {
      if (startStr > 0 && dStart < fadeDist) {
        const t = Math.max(0, Math.min(1, dStart / fadeDist));
        const k = fadeSmooth(1 - t) * startStr;
        w *= 1 - (1 - minW) * k;
        o *= 1 - (1 - minO) * k;
      }
      if (endStr > 0 && dEnd < fadeDist) {
        const t = Math.max(0, Math.min(1, dEnd / fadeDist));
        const k = fadeSmooth(1 - t) * endStr;
        w *= 1 - (1 - minW) * k;
        o *= 1 - (1 - minO) * k;
      }
    } else {
      s = (typeof s === 'number' && isFinite(s)) ? Math.max(0, Math.min(1, s)) : 0;
      if (startStr > 0 && s < f) {
        const k = fadeSmooth(1 - s / f) * startStr;
        w *= 1 - (1 - minW) * k;
        o *= 1 - (1 - minO) * k;
      }
      if (endStr > 0 && s > 1 - f) {
        const k = fadeSmooth((s - (1 - f)) / f) * endStr;
        w *= 1 - (1 - minW) * k;
        o *= 1 - (1 - minO) * k;
      }
    }
    w = Math.max(0.01, Math.min(1, isFinite(w) ? w : 1));
    o = Math.max(0, Math.min(1, isFinite(o) ? o : 1));
    return { w, o };
  }

  // Traces a tapered ribbon as ONE continuous closed contour: left edge forward,
  // round end cap, right edge back, round start cap, close. Filling it a single
  // time keeps anti-aliased edges from ever overlapping (no blended seams).
  // Traces a tapered ribbon as ONE continuous closed contour: left edge forward,
  // round end cap (or smooth tapered point), right edge back, start cap (or point), close.
  // Filling it a single time keeps anti-aliased edges from ever overlapping (no blended seams).
  function traceStrokeOutline(c, pts, left, right, radii, n, tangents, startFade, endFade) {
    const tan0 = (tangents && tangents[0]) ? tangents[0] : { tx: 1, ty: 0 };
    const tanN = (tangents && tangents[n - 1]) ? tangents[n - 1] : { tx: 1, ty: 0 };
    const r0 = radii[0];
    const rN = radii[n - 1];

    c.moveTo(left[0].x, left[0].y);
    for (let i = 1; i < n; i++) c.lineTo(left[i].x, left[i].y);

    // End tip / cap:
    // If end is tapered or radius is very small, form a clean, smooth point
    // rather than an arc that can miscalculate into a crescent, hook, or spike.
    if (endFade || rN < 2.5) {
      const tipDist = Math.max(rN * 1.35, 0.5);
      const tipX = pts[n - 1].x + tanN.tx * tipDist;
      const tipY = pts[n - 1].y + tanN.ty * tipDist;
      c.lineTo(tipX, tipY);
      c.lineTo(right[n - 1].x, right[n - 1].y);
    } else {
      const eAng = Math.atan2(left[n - 1].y - pts[n - 1].y, left[n - 1].x - pts[n - 1].x);
      c.arc(pts[n - 1].x, pts[n - 1].y, rN, eAng, eAng - Math.PI, true);
    }

    for (let i = n - 1; i >= 0; i--) c.lineTo(right[i].x, right[i].y);

    // Start tip / cap:
    // If start is tapered or radius is very small, form a clean, smooth point.
    if (startFade || r0 < 2.5) {
      const tipDist0 = Math.max(r0 * 1.35, 0.5);
      const tipX0 = pts[0].x - tan0.tx * tipDist0;
      const tipY0 = pts[0].y - tan0.ty * tipDist0;
      c.lineTo(tipX0, tipY0);
      c.lineTo(left[0].x, left[0].y);
    } else {
      const sAng = Math.atan2(right[0].y - pts[0].y, right[0].x - pts[0].x);
      c.arc(pts[0].x, pts[0].y, r0, sAng, sAng - Math.PI, true);
    }
    c.closePath();
  }

  // Lazily-created scratch raster that carries the fade mask.
  // Grows in capacity to avoid reallocating on every pointer move frame.
  function getFadeScratch(w, h) {
    if (!fadeScratchCanvas) fadeScratchCanvas = document.createElement('canvas');
    const reqW = Math.max(1, Math.min(16384, Math.ceil(w)));
    const reqH = Math.max(1, Math.min(16384, Math.ceil(h)));
    if (fadeScratchCanvas.width < reqW || fadeScratchCanvas.height < reqH) {
      fadeScratchCanvas.width = Math.max(reqW, Math.round((fadeScratchCanvas.width || 0) * 1.5), 256);
      fadeScratchCanvas.height = Math.max(reqH, Math.round((fadeScratchCanvas.height || 0) * 1.5), 256);
    }
    return fadeScratchCanvas;
  }

  // Paints the arc-length alpha ramp (white, varying alpha) into `c`, which is
  // already translated into document space. Canvas2D gradients are spatial, so a
  // lone gradient cannot follow a curve; instead each fade zone uses a
  // per-segment gradient whose stops are indexed by arc length. The crisp shape
  // is multiplied in afterwards with 'source-in', so ramp imperfections never
  // touch the outline's edges.
  //
  // Composite op is 'lighter' (additive), NOT 'source-over': neighbouring quads
  // share an anti-aliased cross-section, and source-over folds the two partial
  // coverages as A - AÂ²Â·cÂ·(1-c), which leaves a lighter 1px line at every joint
  // â€” the recurring gap-by-gap banding. Additively the coverages sum
  // (c + (1-c) = 1), so each seam resolves to exactly A. All shapes here abut
  // edge-to-edge with matching values, so nothing ever double-counts.
  function buildFadeRamp(c, pts, left, right, radii, alphas, n, i0, i1, hasMiddle, baseA, tangents, startFade, endFade) {
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = 1;

    const tan0 = (tangents && tangents[0]) ? tangents[0] : { tx: 1, ty: 0 };
    const tanN = (tangents && tangents[n - 1]) ? tangents[n - 1] : { tx: 1, ty: 0 };
    const r0 = radii[0];
    const rN = radii[n - 1];

    // Start cap
    c.fillStyle = 'rgba(255,255,255,' + alphas[0] + ')';
    if (startFade || r0 < 2.5) {
      const tipDist0 = Math.max(r0 * 1.35, 0.5);
      const tipX0 = pts[0].x - tan0.tx * tipDist0;
      const tipY0 = pts[0].y - tan0.ty * tipDist0;
      c.beginPath();
      c.moveTo(right[0].x, right[0].y);
      c.lineTo(tipX0, tipY0);
      c.lineTo(left[0].x, left[0].y);
      c.closePath();
      c.fill();
    } else {
      const sAng = Math.atan2(right[0].y - pts[0].y, right[0].x - pts[0].x);
      c.beginPath();
      c.arc(pts[0].x, pts[0].y, r0, sAng, sAng - Math.PI, true);
      c.closePath();
      c.fill();
    }

    // End cap
    c.fillStyle = 'rgba(255,255,255,' + alphas[n - 1] + ')';
    if (endFade || rN < 2.5) {
      const tipDist = Math.max(rN * 1.35, 0.5);
      const tipX = pts[n - 1].x + tanN.tx * tipDist;
      const tipY = pts[n - 1].y + tanN.ty * tipDist;
      c.beginPath();
      c.moveTo(left[n - 1].x, left[n - 1].y);
      c.lineTo(tipX, tipY);
      c.lineTo(right[n - 1].x, right[n - 1].y);
      c.closePath();
      c.fill();
    } else {
      const eAng = Math.atan2(left[n - 1].y - pts[n - 1].y, left[n - 1].x - pts[n - 1].x);
      c.beginPath();
      c.arc(pts[n - 1].x, pts[n - 1].y, rN, eAng, eAng - Math.PI, true);
      c.closePath();
      c.fill();
    }

    const quad = (i) => {
      const p0 = pts[i], p1 = pts[i + 1];
      const d = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      if (!isFinite(d) || d < 0.01) return;
      const g = c.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
      g.addColorStop(0, 'rgba(255,255,255,' + alphas[i] + ')');
      g.addColorStop(1, 'rgba(255,255,255,' + alphas[i + 1] + ')');
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(left[i].x, left[i].y);
      c.lineTo(left[i + 1].x, left[i + 1].y);
      c.lineTo(right[i + 1].x, right[i + 1].y);
      c.lineTo(right[i].x, right[i].y);
      c.closePath();
      c.fill();
    };

    // Fade zones: per-segment lengthwise gradients (stacked = arc length).
    if (hasMiddle) {
      for (let i = 0; i < i0; i++) quad(i);
      for (let i = i1; i < n - 1; i++) quad(i);
    } else {
      for (let i = 0; i < n - 1; i++) quad(i);
    }

    // Constant-opacity mid-section. Its edge values equal baseA on both sides
    // (the fade is exactly 1.0 where it meets each taper), so under 'lighter'
    // it resolves to baseA across the junction instead of double-counting.
    if (hasMiddle) {
      c.fillStyle = 'rgba(255,255,255,' + baseA + ')';
      c.beginPath();
      c.moveTo(left[i0].x, left[i0].y);
      for (let i = i0 + 1; i <= i1; i++) c.lineTo(left[i].x, left[i].y);
      for (let i = i1; i >= i0; i--) c.lineTo(right[i].x, right[i].y);
      c.closePath();
      c.fill();
    }
  }

  // Reusable geometry scratch for paintFadeStroke(). These arrays keep their
  // capacity across frames, so a live fade stroke does not allocate thousands
  // of points/tangents on every animation frame (major GC pressure on iOS).
  const fadeWork = {
    cum: [], tangents: [], left: [], right: [], radii: [], alphas: [],
    rampLeft: [], rampRight: [], rampRadii: [],
  };
  function ensureFadeWork(n) {
    const w = fadeWork;
    const growNums = (a) => { if (a.length < n) a.length = n; };
    const growPts = (a) => { while (a.length < n) a.push({ x: 0, y: 0 }); };
    growNums(w.cum);
    growNums(w.radii);
    growNums(w.alphas);
    growNums(w.rampRadii);
    growPts(w.tangents);
    growPts(w.left);
    growPts(w.right);
    growPts(w.rampLeft);
    growPts(w.rampRight);
    return w;
  }

  // Paints a tapered / faded stroke into `ctx`.
  // The shape is always ONE continuous contour fill (left edge �+' end cap �+'
  // right edge �+' start cap), so anti-aliased edges never overlap and leave
  // seams. When opacity fades, that fade is an arc-length alpha ramp multiplied
  // into the contour with 'source-in' on a scratch raster �?" so the fade follows
  // the real path length through loops and self-crossings, unlike a single
  // spatial gradient which collapses on curves.
  function paintFadeStroke(ctx, pts, cfg, baseSize, baseA, color, erase) {
    if (!pts || pts.length < 1) return null;
    const n = pts.length;

    // Guard the geometry inputs: a NaN/negative size would produce NaN path
    // coordinates (silently unrenderable) and a NaN alpha would poison the fill.
    baseSize = (typeof baseSize === 'number' && isFinite(baseSize) && baseSize > 0)
      ? Math.max(0.5, Math.min(4000, baseSize)) : 5;
    baseA = (typeof baseA === 'number' && isFinite(baseA))
      ? Math.max(0, Math.min(1, baseA)) : 1;

    const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
    const f = Math.max(0.001, Math.min(1, num(cfg.length, 35) / 100));
    const startFade = Math.max(0, Math.min(1, num(cfg.start, 0) / 100)) > 0;
    const endFade = Math.max(0, Math.min(1, num(cfg.end, 100) / 100)) > 0;

    if (n === 1) {
      const prof = fadeProfile(0, cfg, 0, 0, baseSize * f * 2);
      const r = Math.max(0.25, Math.min(baseSize * 2, (baseSize * prof.w) / 2));
      const a = Math.max(0, Math.min(1, baseA * prof.o));
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = a;
      ctx.fillStyle = erase ? '#000000' : color;
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, r, 0, Math.PI * 2, false);
      ctx.fill('nonzero');
      ctx.restore();
      return { minX: pts[0].x - r, minY: pts[0].y - r, maxX: pts[0].x + r, maxY: pts[0].y + r };
    }

    const work = ensureFadeWork(n);
    const cum = work.cum;
    cum[0] = 0;
    for (let i = 1; i < n; i++) {
      const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      cum[i] = cum[i - 1] + (isFinite(d) ? d : 0);
    }
    const total = cum[n - 1] > 0.0001 ? cum[n - 1] : 0.0001;

    // Dynamically scale fade distance so short strokes and live growing strokes
    // have a smooth, stable taper zone rather than collapsing into degenerate bounds.
    const fadeDist = Math.max(baseSize * 1.5 * f, total * f);

    // Compute smooth tangents along the path with lookahead/lookbehind to filter touch jitter.
    const tangents = work.tangents;
    let lastValidTx = 1, lastValidTy = 0;
    for (let i = 0; i < n; i++) {
      let tx = 0, ty = 0;
      if (i === 0) {
        for (let k = 1; k < n; k++) {
          const d = Math.hypot(pts[k].x - pts[0].x, pts[k].y - pts[0].y);
          if (d >= 1.0) {
            tx = (pts[k].x - pts[0].x) / d;
            ty = (pts[k].y - pts[0].y) / d;
            break;
          }
        }
      } else if (i === n - 1) {
        for (let k = n - 2; k >= 0; k--) {
          const d = Math.hypot(pts[n - 1].x - pts[k].x, pts[n - 1].y - pts[k].y);
          if (d >= 1.0) {
            tx = (pts[n - 1].x - pts[k].x) / d;
            ty = (pts[n - 1].y - pts[k].y) / d;
            break;
          }
        }
      } else {
        const dx = pts[i + 1].x - pts[i - 1].x;
        const dy = pts[i + 1].y - pts[i - 1].y;
        const dlen = Math.hypot(dx, dy);
        if (dlen >= 1e-4) {
          tx = dx / dlen;
          ty = dy / dlen;
        }
      }
      if (tx === 0 && ty === 0) {
        if (i < n - 1) {
          const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
          if (d >= 1e-4) { tx = (pts[i + 1].x - pts[i].x) / d; ty = (pts[i + 1].y - pts[i].y) / d; }
        }
        if (tx === 0 && ty === 0 && i > 0) {
          const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
          if (d >= 1e-4) { tx = (pts[i].x - pts[i - 1].x) / d; ty = (pts[i].y - pts[i - 1].y) / d; }
        }
        if (tx === 0 && ty === 0) {
          tx = lastValidTx;
          ty = lastValidTy;
        }
      }
      // Guard against 180-degree flip (bow-tie knot) relative to the incoming stroke direction
      if (i > 0 && (tx * lastValidTx + ty * lastValidTy) < -0.2) {
        tx = lastValidTx;
        ty = lastValidTy;
      }
      lastValidTx = tx;
      lastValidTy = ty;
      const tan = tangents[i];
      tan.tx = tx;
      tan.ty = ty;
    }

    const left = work.left, right = work.right, radii = work.radii, alphas = work.alphas;
    const rampGrow = 1.5;
    const rampLeft = work.rampLeft, rampRight = work.rampRight, rampRadii = work.rampRadii;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let anyOpacityFade = false;
    let i0 = startFade ? n : 0;
    let i1 = endFade ? -1 : n - 1;

    for (let i = 0; i < n; i++) {
      const dStart = cum[i];
      const dEnd = total - cum[i];
      const s = Math.max(0, Math.min(1, cum[i] / total));
      const prof = fadeProfile(s, cfg, dStart, dEnd, fadeDist);
      if (prof.o < 0.999) anyOpacityFade = true;
      const r = Math.max(0.25, Math.min(baseSize * 2, (baseSize * prof.w) / 2));
      radii[i] = r;
      alphas[i] = Math.max(0, Math.min(1, baseA * prof.o));

      if (startFade && i0 === n && dStart >= fadeDist) i0 = i;
      if (endFade && dEnd >= fadeDist) i1 = i;

      const p = pts[i];
      const tan = tangents[i];
      const nx = -tan.ty;
      const ny = tan.tx;

      const l = left[i];
      l.x = p.x + nx * r;
      l.y = p.y + ny * r;
      const rt = right[i];
      rt.x = p.x - nx * r;
      rt.y = p.y - ny * r;

      const rg = r + rampGrow;
      const rl = rampLeft[i];
      rl.x = p.x + nx * rg;
      rl.y = p.y + ny * rg;
      const rr = rampRight[i];
      rr.x = p.x - nx * rg;
      rr.y = p.y - ny * rg;
      rampRadii[i] = rg;

      minX = Math.min(minX, p.x - rg - 2); maxX = Math.max(maxX, p.x + rg + 2);
      minY = Math.min(minY, p.y - rg - 2); maxY = Math.max(maxY, p.y + rg + 2);
    }

    // Expand bounding box to include start and end apex tips
    const tan0 = tangents[0], tanN = tangents[n - 1];
    const tipDist0 = Math.max(rampRadii[0] * 1.5, 1);
    const tipDistN = Math.max(rampRadii[n - 1] * 1.5, 1);
    minX = Math.min(minX, pts[0].x - tan0.tx * tipDist0, pts[n - 1].x + tanN.tx * tipDistN);
    maxX = Math.max(maxX, pts[0].x - tan0.tx * tipDist0, pts[n - 1].x + tanN.tx * tipDistN);
    minY = Math.min(minY, pts[0].y - tan0.ty * tipDist0, pts[n - 1].y + tanN.ty * tipDistN);
    maxY = Math.max(maxY, pts[0].y - tan0.ty * tipDist0, pts[n - 1].y + tanN.ty * tipDistN);

    const bbox = { minX, minY, maxX, maxY };

    // Constant opacity across the whole stroke: keep the cheap, seam-free single-contour fill.
    if (!anyOpacityFade) {
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = Math.max(0, Math.min(1, baseA));
      ctx.fillStyle = erase ? '#000000' : color;
      ctx.beginPath();
      traceStrokeOutline(ctx, pts, left, right, radii, n, tangents, startFade, endFade);
      ctx.fill('nonzero');
      ctx.restore();
      return bbox;
    }

    // Arc-length fade: build alpha ramp on scratch raster, mask with contour via 'source-in', composite into ctx.
    const i0c = Math.max(0, Math.min(n - 1, i0));
    const i1c = Math.max(0, Math.min(n - 1, i1));
    const hasMiddle = i1c > i0c;

    const pad = Math.max(4, Math.ceil(rampGrow + 3));
    const sx = Math.floor(minX) - pad;
    const sy = Math.floor(minY) - pad;
    const sw = Math.ceil(maxX) + pad - sx;
    const sh = Math.ceil(maxY) + pad - sy;
    if (!(sw > 0) || !(sh > 0) || !isFinite(sw) || !isFinite(sh) ||
        sw > 16384 || sh > 16384) {
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = Math.max(0, Math.min(1, baseA));
      ctx.fillStyle = erase ? '#000000' : color;
      ctx.beginPath();
      traceStrokeOutline(ctx, pts, left, right, radii, n, tangents, startFade, endFade);
      ctx.fill('nonzero');
      ctx.restore();
      return bbox;
    }

    const scratch = getFadeScratch(sw, sh);
    const sctx = scratch.getContext('2d');
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, sw, sh);
    sctx.translate(-sx, -sy);

    buildFadeRamp(sctx, pts, rampLeft, rampRight, rampRadii, alphas, n, i0c, i1c, hasMiddle, baseA, tangents, startFade, endFade);

    sctx.globalCompositeOperation = 'source-in';
    sctx.globalAlpha = 1;
    sctx.fillStyle = erase ? '#000000' : color;
    sctx.beginPath();
    traceStrokeOutline(sctx, pts, left, right, radii, n, tangents, startFade, endFade);
    sctx.fill('nonzero');
    sctx.globalCompositeOperation = 'source-over';

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(scratch, 0, 0, sw, sh, sx, sy, sw, sh);
    ctx.restore();

    return bbox;
  }

  // â”€â”€â”€ Touch & Retina Stroke Stabilizer (EMA + String-Drag) â”€â”€â”€
  // Overhauled for iPad OS / iOS Safari and mobile smartphones.
  // Combines pulled-string deadzone logic with adaptive exponential moving average (EMA)
  // smoothing, scaling distance calculations by window.devicePixelRatio so stabilization
  // is immediately perceptible and buttery smooth on Retina screens.
  const stabilizer = {
    x: 0, y: 0,
    smoothX: 0, smoothY: 0,
    dragX: 0, dragY: 0,
    lastTime: 0,
    ready: false,
    raw: false,
  };

  function resetStabilizer(x, y) {
    const s = stabilizer;
    s.x = s.smoothX = s.dragX = x;
    s.y = s.smoothY = s.dragY = y;
    s.lastTime = performance.now();
    s.ready = true;
    s.raw = state.stabilization < 0.02;
  }

  const stabilizerResult = { x: 0, y: 0 };
  function updateStabilizer(rawX, rawY) {
    const s = stabilizer;
    const stab = Math.min(0.95, Math.max(0, state.stabilization));
    if (stab < 0.02 || s.raw) {
      s.smoothX = s.dragX = s.x = rawX;
      s.smoothY = s.dragY = s.y = rawY;
      stabilizerResult.x = rawX;
      stabilizerResult.y = rawY;
      return stabilizerResult;
    }

    const now = performance.now();
    let dt = (now - s.lastTime) / 1000;
    if (!s.ready || dt <= 0 || dt > 0.1) dt = 1 / 60;
    s.lastTime = now;

    // Scale calculations using devicePixelRatio for high-DPI Retina mobile screens
    const dpr = window.devicePixelRatio || 1;
    const zoom = Math.max(0.05, state.zoom || 1);

    // 1. String-drag deadzone logic: filters tremor and finger contact jitter
    const deadzoneScreen = stab * 12 * dpr; // physical display pixels
    const deadzoneDoc = deadzoneScreen / (zoom * dpr); // document space

    const dx = rawX - s.dragX;
    const dy = rawY - s.dragY;
    const dist = Math.hypot(dx, dy);

    if (dist > deadzoneDoc && dist > 0.0001) {
      const pull = (dist - deadzoneDoc) / dist;
      s.dragX += dx * pull;
      s.dragY += dy * pull;
    }

    // 2. Exponential Moving Average (EMA) smoothing towards the string anchor
    const baseWeight = Math.max(0.06, 1.0 - stab * 0.88);
    const alpha = Math.max(0.01, Math.min(1.0, 1 - Math.pow(1 - baseWeight, Math.max(0.1, dt * 60))));

    s.smoothX += (s.dragX - s.smoothX) * alpha;
    s.smoothY += (s.dragY - s.smoothY) * alpha;
    s.x = s.smoothX;
    s.y = s.smoothY;

    stabilizerResult.x = s.smoothX;
    stabilizerResult.y = s.smoothY;
    return stabilizerResult;
  }

  // Backward-compatible One Euro aliases
  const oneEuro = stabilizer;
  function resetOneEuro(x, y) { resetStabilizer(x, y); }
  function updateOneEuro(rawX, rawY) { return updateStabilizer(rawX, rawY); }

  // â”€â”€â”€ Point pool â”€â”€â”€
  // Pointer events can fire at 120-240 Hz; reusing point objects keeps the hot
  // path allocation-free (no per-event GC churn).
  const pointPool = [];
  function allocPoint(x, y) {
    const p = pointPool.length ? pointPool.pop() : { x: 0, y: 0 };
    p.x = x;
    p.y = y;
    return p;
  }
  function releasePoints(pts) {
    for (let i = 0; i < pts.length; i++) pointPool.push(pts[i]);
  }

  // Hard cap for the live stroke history. When a stroke gets longer than this,
  // every second interior point is dropped (the endpoints and shape are kept),
  // so paintFadeStroke() and the point loops stay O(cap) instead of growing
  // forever during a single continuous finger/A-pencil stroke.
  const MAX_ACTIVE_STROKE_POINTS = 2048;
  function capStrokePoints(pts) {
    if (pts.length <= MAX_ACTIVE_STROKE_POINTS) return pts;
    const last = pts[pts.length - 1];
    for (let r = 1; r < pts.length - 1; r += 2) pointPool.push(pts[r]);
    let w = 1;
    for (let r = 2; r < pts.length - 1; r += 2) pts[w++] = pts[r];
    pts[w++] = last;
    pts.length = w;
    return pts;
  }

  // Fixed-size ring buffer for raw pointer samples. High-frequency pointermove
  // callbacks write two floats and return; nothing is allocated and no canvas
  // work happens until the next requestAnimationFrame.
  const STROKE_INPUT_CAP = 4096;
  const strokeInput = new Float32Array(STROKE_INPUT_CAP * 2);
  let strokeInputHead = 0;
  let strokeInputCount = 0;
  let strokeFrameRAF = 0;

  function clearStrokeInput() {
    strokeInputHead = 0;
    strokeInputCount = 0;
    if (strokeFrameRAF) {
      try { cancelAnimationFrame(strokeFrameRAF); } catch (e) {}
      strokeFrameRAF = 0;
    }
  }

  // â”€â”€â”€ Stroke bounding box â”€â”€â”€
  // Document-space bounds of the in-progress stroke. The per-event layer
  // re-composite only has to touch these pixels, instead of the whole
  // 1920Ã—1080 document on every pointer move.
  let strokeBBox = null;
  function expandStrokeBBox(x0, y0, x1, y1) {
    if (!strokeBBox) { strokeBBox = { x0: x0, y0: y0, x1: x1, y1: y1 }; return; }
    if (x0 < strokeBBox.x0) strokeBBox.x0 = x0;
    if (y0 < strokeBBox.y0) strokeBBox.y0 = y0;
    if (x1 > strokeBBox.x1) strokeBBox.x1 = x1;
    if (y1 > strokeBBox.y1) strokeBBox.y1 = y1;
  }

  // Bounds touched during the current animation frame only. Long plain/stamp
  // strokes re-composite just the new segment, not the stroke's whole history.
  let strokeFrameBBox = null;
  function expandStrokeFrameBBox(x0, y0, x1, y1) {
    if (!strokeFrameBBox) { strokeFrameBBox = { x0: x0, y0: y0, x1: x1, y1: y1 }; return; }
    if (x0 < strokeFrameBBox.x0) strokeFrameBBox.x0 = x0;
    if (y0 < strokeFrameBBox.y0) strokeFrameBBox.y0 = y0;
    if (x1 > strokeFrameBBox.x1) strokeFrameBBox.x1 = x1;
    if (y1 > strokeFrameBBox.y1) strokeFrameBBox.y1 = y1;
  }
  function bboxToRect(b) {
    if (!b) return null;
    return { x: b.x0 - 2, y: b.y0 - 2, w: (b.x1 - b.x0) + 4, h: (b.y1 - b.y0) + 4 };
  }

  // Restores `snapshot` then composites `srcBuffer` over it, limited to `bbox`
  // (or the whole document when bbox is null). Equivalent to a full re-composite
  // but only pays for the pixels that actually changed.
  function compositeStrokeRegion(ctx, snapshot, bbox, alpha, op, srcBuffer) {
    const w = state.docWidth, h = state.docHeight;
    if (!bbox) {
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(snapshot, 0, 0);
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = op;
      ctx.drawImage(srcBuffer, 0, 0);
      return;
    }
    const x0 = bbox.x0 < 0 ? 0 : Math.floor(bbox.x0);
    const y0 = bbox.y0 < 0 ? 0 : Math.floor(bbox.y0);
    const x1 = bbox.x1 > w ? w : Math.ceil(bbox.x1);
    const y1 = bbox.y1 > h ? h : Math.ceil(bbox.y1);
    if (!(x1 > x0) || !(y1 > y0)) return;
    const rw = x1 - x0, rh = y1 - y0;
    ctx.clearRect(x0, y0, rw, rh);
    ctx.drawImage(snapshot, x0, y0, rw, rh, x0, y0, rw, rh);
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = op;
    ctx.drawImage(srcBuffer, x0, y0, rw, rh, x0, y0, rw, rh);
  }

  function compositeStrokeBufferToLayer(layer, box) {
    if (!strokeSnapshotCanvas || !strokeBufferCanvas) return;
    const ctx = layer.ctx;
    const w = state.docWidth, h = state.docHeight;
    const target = box || strokeBBox;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1.0;
    ctx.globalCompositeOperation = 'source-over';
    applySelectionClip(ctx);

    const erase = state.tool === 'eraser';
    const alpha = erase ? 1.0 : safeBrushOpacity();
    const op = erase ? 'destination-out' : 'source-over';
    const fullWand = wandActive();

    if (fullWand) {
      // A soft wand mask needs the whole canvas; fall back to a full re-composite.
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(strokeSnapshotCanvas, 0, 0);
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = op;
      drawDeltaMasked(ctx, strokeBufferCanvas);
    } else {
      compositeStrokeRegion(ctx, strokeSnapshotCanvas, target, alpha, op, strokeBufferCanvas);
    }
    ctx.restore();

    scheduleRender(fullWand ? null : bboxToRect(target), true);
  }

  // Re-renders the live stroke: draws on off-screen buffer at 100% opacity,
  // then composites to the active layer with uniform brush opacity.
  function renderFadeStroke(layer) {
    if (!strokeBufferCanvas || !strokeSnapshotCanvas) return;
    const bctx = strokeBufferCtx;
    const w = state.docWidth, h = state.docHeight;

    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, w, h);

    const pts = state.points;
    if (!pts || !pts.length) return;

    const baseSize = safeBrushSize();
    const color = state.tool === 'eraser' ? '#000000' : state.brushColor;

    // Draw the tapered stroke at 100% opacity on the off-screen buffer
    const box = paintFadeStroke(bctx, pts, getFadeSettings(), baseSize, 1.0, color, state.tool === 'eraser');

    if (box) {
      fadeBBox = box;
      expandStrokeBBox(box.minX - 4, box.minY - 4, box.maxX + 4, box.maxY + 4);
    }
    compositeStrokeBufferToLayer(layer);
  }

  // Coalesce live fade repaints to at most one per animation frame.
  function scheduleFadeStrokeRender() {
    if (fadeRAF != null) return;
    fadeRAF = requestAnimationFrame(() => {
      fadeRAF = null;
      fadePending = false;
      if (!state.isDrawing) return;
      const layer = getActiveLayer();
      if (layer) renderFadeStroke(layer);
      if (renderQueued) flushRender();
    });
  }

  function flushFadeStroke() {
    if (fadeRAF != null) { cancelAnimationFrame(fadeRAF); fadeRAF = null; }
    fadePending = false;
    if (strokeSnapshotCanvas) {
      const layer = getActiveLayer();
      if (layer) renderFadeStroke(layer);
    }
  }

  function beginStroke(docX, docY) {
    if (!canEditActive()) return;
    const layer = getActiveLayer();
    if (!layer) return;

    // Starting to draw discards any live filter preview so it can't be baked in.
    if (filterState.id) cancelFilterSession();
    clearStrokeInput();
    strokeFrameBBox = null;

    state.isDrawing = true;
    state.points = [allocPoint(docX, docY)];
    state.smoothPoint.x = docX;
    state.smoothPoint.y = docY;
    resetStabilizer(docX, docY);

    const fadeActive = isFadeStroke();
    let stab = Math.min(0.95, Math.max(0, state.stabilization));
    // Do not disable stabilization on touch: mobile / Retina touch needs full stabilization!
    stabilizer.raw = stab < 0.02;

    // Seed the stroke bounds so the first re-composite is already clipped.
    const seedR = safeBrushSize() / 2 + 4;
    strokeBBox = { x0: docX - seedR, y0: docY - seedR, x1: docX + seedR, y1: docY + seedR };

    // Broadcast the stroke to other devices on the same Artee server.
    // Assign a stroke ID for all brush/eraser strokes so moves stream live;
    // non-plain strokes also send a restore at endStroke to ensure pixel-perfect fidelity.
    currentStrokeSid = (state.tool === 'brush' || state.tool === 'eraser')
      ? (wsClientId + '-' + (++liveStrokeSeq))
      : null;

    // `strokeBBox` is a live object that `expandStrokeBBox` grows in place, so
    // by undo time it holds the stroke's final region â€” lets undo ship only the
    // affected pixels instead of the whole 1920Ã—1080 layer.
    pushUndo(layer, { bbox: strokeBBox });
    emitStroke('begin', {
      layerId: layer.id,
      tool: state.tool,
      color: state.brushColor,
      size: safeBrushSize(),
      opacity: safeBrushOpacity(),
      brushType: state.brushType,
      fade: fadeActive ? Object.assign({}, getFadeSettings()) : null,
      x: docX, y: docY,
    });

    const w = state.docWidth, h = state.docHeight;

    // 1. Snapshot the clean pre-stroke layer canvas:
    if (!strokeSnapshotCanvas) strokeSnapshotCanvas = document.createElement('canvas');
    // Assigning width/height reallocates the backing store even for an identical
    // value, so only touch it when the size actually changes (it never does here,
    // since the document size is fixed) â€” avoids a per-stroke GPU realloc.
    if (strokeSnapshotCanvas.width !== w) strokeSnapshotCanvas.width = w;
    if (strokeSnapshotCanvas.height !== h) strokeSnapshotCanvas.height = h;
    const snapCtx = strokeSnapshotCanvas.getContext('2d');
    snapCtx.setTransform(1, 0, 0, 1, 0, 0);
    snapCtx.clearRect(0, 0, w, h);
    snapCtx.drawImage(layer.canvas, 0, 0);

    // 2. Prepare the clean off-screen stroke buffer:
    if (!strokeBufferCanvas) strokeBufferCanvas = document.createElement('canvas');
    if (strokeBufferCanvas.width !== w) strokeBufferCanvas.width = w;
    if (strokeBufferCanvas.height !== h) strokeBufferCanvas.height = h;
    strokeBufferCtx = strokeBufferCanvas.getContext('2d');
    strokeBufferCtx.setTransform(1, 0, 0, 1, 0, 0);
    strokeBufferCtx.clearRect(0, 0, w, h);

    if (fadeActive) {
      fadeBBox = null;
      if (fadeRAF != null) { cancelAnimationFrame(fadeRAF); fadeRAF = null; }
      fadePending = false;
      renderFadeStroke(layer);
      return;
    }

    if (isStampStroke()) {
      beginStampStroke(docX, docY, layer);
      return;
    }

    // Standard brush: draw starting circle on buffer at 100% opacity.
    // The buffer context is configured once here and reused for the whole
    // stroke, so the per-point hot loop never touches style state again.
    const size = safeBrushSize();
    const radius = size / 2;
    strokeBufferCtx.globalAlpha = 1.0;
    strokeBufferCtx.globalCompositeOperation = 'source-over';
    strokeBufferCtx.fillStyle = state.tool === 'eraser' ? '#000000' : state.brushColor;
    strokeBufferCtx.beginPath();
    strokeBufferCtx.arc(docX, docY, radius, 0, Math.PI * 2);
    strokeBufferCtx.fill('nonzero');

    compositeStrokeBufferToLayer(layer);
  }

  function continueStroke(rawX, rawY, deferRender) {
    if (!state.isDrawing) return;
    const layer = getActiveLayer();
    if (!layer) return;

    const fadeActive = isFadeStroke();

    let x, y;
    if (stabilizer.raw) {
      x = rawX;
      y = rawY;
    } else {
      const p = updateStabilizer(rawX, rawY);
      x = p.x;
      y = p.y;
    }
    state.smoothPoint.x = x;
    state.smoothPoint.y = y;

    const pts = state.points;
    if (pts.length >= MAX_ACTIVE_STROKE_POINTS) capStrokePoints(pts);
    const last = pts[pts.length - 1];
    const ox = x - last.x;
    const oy = y - last.y;
    // Squared distance avoids a sqrt on every (possibly sub-pixel) pointer move.
    const distSq = ox * ox + oy * oy;
    // Do NOT drop points on desktop or during fade strokes:
    // Only skip exact duplicates to avoid 0-length segments;
    // ensure state.points continuously receives valid coordinates so paintFadeStroke
    // gets the necessary arc-length geometry for tapered profiles.
    const minDistSq = fadeActive ? 0.0001 : 0.04;
    if (distSq < minDistSq) return;
    const dist = Math.sqrt(distSq);
    pts.push(allocPoint(x, y));
    emitStroke('move', { x, y });

    if (fadeActive) {
      if (!deferRender) {
        renderFadeStroke(layer);
        if (renderQueued) flushRender();
      }
      return;
    }

    if (isStampStroke()) {
      continueStampStroke(x, y, deferRender);
      return;
    }

    const size = safeBrushSize();
    const radius = size / 2;
    expandStrokeBBox(last.x - radius, last.y - radius, x + radius, y + radius);
    expandStrokeFrameBBox(last.x - radius, last.y - radius, x + radius, y + radius);
    // Step is a small fraction of radius (step = radius * 0.1) so stamps overlap densely into a smooth solid ribbon
    const step = Math.max(0.5, radius * 0.1);
    const steps = Math.max(1, Math.ceil(dist / step));
    const dx = ox / steps;
    const dy = oy / steps;

    // Context styles were cached at beginStroke(); only path ops here.
    for (let k = 1; k <= steps; k++) {
      const cx = last.x + dx * k;
      const cy = last.y + dy * k;
      strokeBufferCtx.beginPath();
      strokeBufferCtx.arc(cx, cy, radius, 0, Math.PI * 2);
      strokeBufferCtx.fill('nonzero');
    }

    if (!deferRender) {
      compositeStrokeBufferToLayer(layer);
      if (renderQueued) flushRender();
    }
  }

  function endStroke() {
    if (!state.isDrawing) return;
    // Draw the last frame of queued samples before committing the stroke, so
    // lifting the finger never clips the tail of a fast flick.
    if (strokeInputCount > 0) processStrokeFrame();
    const wasPlain = isPlainStroke();
    const layer = getActiveLayer();
    emitStroke('end');
    currentStrokeSid = null;
    let restoreBox = null;
    if (isFadeStroke()) {
      flushFadeStroke();
      restoreBox = unionBox(strokeBBox, fadeBBox);
    } else if (stampState.active) {
      restoreBox = endStampStroke();
    }

    state.isDrawing = false;
    clearStrokeInput();
    releasePoints(state.points);
    state.points = [];
    strokeBBox = null;
    strokeFrameBBox = null;
    fadeRAF = null;
    fadePending = false;
    fadeBBox = null;
    // Non-plain strokes (stamp brushes, force-fade, selection/wand clips) were
    // never replayed on the peer, so ship the exact pixels we just committed.
    if (!wasPlain && layer && !isGroupNode(layer) &&
        (state.tool === 'brush' || state.tool === 'eraser')) {
      sendRestore(layer, restoreBox, layer.canvas);
    }
    updateLayerThumbnail(state.activeLayerId);
    scheduleRender();
  }

  // A pinch starts with one finger down, which begins a stroke and paints a dot
  // before the second finger arrives. If that first touch never moved, drop the
  // dot: reuse endStroke for cleanup, then restore the pre-dot region and tell
  // the peer to do the same, so zooming leaves no mark.
  function cancelStroke() {
    if (!state.isDrawing) return;
    clearStrokeInput();
    const layer = getActiveLayer();
    const top = state.undoStack.length ? state.undoStack[state.undoStack.length - 1] : null;
    endStroke();
    if (top && layer && top.layerId === layer.id) {
      state.undoStack.pop();
      restoreLayerFrom(layer, top.snap, top.bbox);
      updateLayerThumbnail(layer.id);
      scheduleRender();
      sendRestore(layer, top.bbox, top.snap);
    }
    updateHistoryButtons();
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     BRUSH TYPES  (per-type stroke behaviour & texture)
     Each non-Pen brush is stamped from a pre-rendered tip
     sprite, so every type has a genuinely different feel.
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  const BRUSH_TYPES = {
    pen: {
      name: 'Pen', hint: 'Clean, solid, sharp strokes.',
      hardness: 1, spacing: 0.06, flow: 1, scatter: 0, alphaMul: 1,
      texture: 'none', taper: 0, fields: [],
    },
    hard: {
      name: 'Hard', hint: 'Completely solid strokes with sharp edges.',
      hardness: 1, spacing: 0.05, flow: 1, scatter: 0, alphaMul: 1,
      texture: 'none', taper: 0, fields: ['hardness'],
    },
    soft: {
      name: 'Soft', hint: 'Smooth brush with fading, feathered edges.',
      hardness: 0.12, spacing: 0.05, flow: 0.75, scatter: 0, alphaMul: 1,
      texture: 'none', taper: 0, fields: ['hardness', 'flow'],
    },
    ink: {
      name: 'Ink', hint: 'Smooth ink-style strokes that thin with speed.',
      hardness: 0.95, spacing: 0.04, flow: 1, scatter: 0.02, alphaMul: 1,
      texture: 'none', taper: 0.35, fields: ['hardness', 'spacing'],
    },
    marker: {
      name: 'Marker', hint: 'Smooth marker strokes with slight transparency.',
      hardness: 0.85, spacing: 0.05, flow: 1, scatter: 0, alphaMul: 0.68,
      texture: 'none', taper: 0.08, fields: ['hardness', 'flow'],
    },
    pencil: {
      name: 'Pencil', hint: 'Textured pencil-like strokes with light grain.',
      hardness: 0.6, spacing: 0.09, flow: 0.9, scatter: 0.14, alphaMul: 1,
      texture: 'grain', taper: 0.12, fields: ['hardness', 'spacing', 'scatter', 'texture'],
    },
    airbrush: {
      name: 'Airbrush', hint: 'Soft, feathered spray that builds up gradually.',
      hardness: 0.02, spacing: 0.05, flow: 0.05, scatter: 0.18, alphaMul: 1,
      texture: 'spray', taper: 0, fields: ['hardness', 'flow', 'spacing', 'scatter'],
    },
    chalk: {
      name: 'Chalk', hint: 'Rough, grainy chalk texture.',
      hardness: 0.5, spacing: 0.16, flow: 0.7, scatter: 0.4, alphaMul: 0.95,
      texture: 'chalk', taper: 0, fields: ['hardness', 'spacing', 'flow', 'scatter', 'texture'],
    },
    crayon: {
      name: 'Crayon', hint: 'Textured crayon-like strokes with waxy grain.',
      hardness: 0.68, spacing: 0.14, flow: 0.85, scatter: 0.26, alphaMul: 0.92,
      texture: 'crayon', taper: 0.05, fields: ['hardness', 'spacing', 'scatter', 'texture'],
    },
    watercolor: {
      name: 'Watercolor', hint: 'Soft, transparent, blended washes.',
      hardness: 0.1, spacing: 0.1, flow: 0.3, scatter: 0.2, alphaMul: 0.55,
      texture: 'watercolor', taper: 0, fields: ['hardness', 'flow', 'spacing', 'scatter', 'texture'],
    },
    paint: {
      name: 'Paint', hint: 'Natural painted texture with bristle streaks.',
      hardness: 0.55, spacing: 0.1, flow: 0.9, scatter: 0.12, alphaMul: 0.88,
      texture: 'paint', taper: 0.08, fields: ['hardness', 'spacing', 'scatter', 'texture'],
    },
  };

  const TEXTURE_OPTIONS = [
    ['none', 'None'], ['grain', 'Grain'], ['chalk', 'Chalk'],
    ['crayon', 'Crayon'], ['watercolor', 'Wash'], ['paint', 'Paint'], ['spray', 'Spray'],
  ];

  function getBrushTypeCfg() {
    return BRUSH_TYPES[state.brushType] || BRUSH_TYPES.pen;
  }

  // Returns the (lazily created) tweakable settings for the active brush type.
  function getBrushState() {
    const t = state.brushType;
    const def = BRUSH_TYPES[t] || BRUSH_TYPES.pen;
    if (!state.brushSettings[t]) {
      state.brushSettings[t] = {
        hardness: def.hardness, spacing: def.spacing,
        flow: def.flow, scatter: def.scatter, texture: def.texture,
      };
    }
    return state.brushSettings[t];
  }

  function isStampStroke() {
    if (isFadeStroke()) return false;
    return (state.tool === 'brush' || state.tool === 'eraser') && state.brushType !== 'pen';
  }

  // Only plain pen strokes are broadcast incrementally: every other brush
  // (textures, force-fade, selection/wand clips) can't be reproduced by
  // replaying hard dots on the peer, so those strokes ship their final pixels
  // as a restore when they end (see endStroke).
  function isPlainStroke() {
    return (state.tool === 'brush' || state.tool === 'eraser') &&
      state.brushType === 'pen' && !isFadeStroke() &&
      !selectState.active && !wandActive();
  }

  // â”€â”€â”€ Tip sprite generation (radial profile + texture) â”€â”€â”€

  function punchNoise(ctx, cx, cy, R, count, maxA, minR, maxR) {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.sqrt(Math.random()) * R * 0.98;
      const x = cx + Math.cos(ang) * rad;
      const y = cy + Math.sin(ang) * rad;
      const rr = minR + Math.random() * (maxR - minR);
      ctx.globalAlpha = maxA * (0.35 + Math.random() * 0.65);
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function punchStreaks(ctx, cx, cy, R, count, maxA) {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineCap = 'round';
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.sqrt(Math.random()) * R * 0.7;
      const sx = cx + Math.cos(ang) * rad;
      const sy = cy + Math.sin(ang) * rad;
      const dir = (Math.random() * 0.5 - 0.25);
      const len = R * (0.4 + Math.random() * 0.8);
      ctx.globalAlpha = maxA * (0.3 + Math.random() * 0.7);
      ctx.lineWidth = Math.max(0.4, R * (0.04 + Math.random() * 0.1));
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + Math.cos(dir) * len, sy + Math.sin(dir) * len);
      ctx.stroke();
    }
    ctx.restore();
  }

  function makeBrushSprite(size, color, hardness, texture) {
    const s = Math.max(1.5, size);
    const R = s / 2;
    const pad = Math.max(1, R * 0.35 + 1);
    const dim = Math.ceil(s + pad * 2);
    const c = document.createElement('canvas');
    c.width = dim; c.height = dim;
    const ctx = c.getContext('2d');
    const cx = dim / 2, cy = dim / 2;
    const hard = Math.max(0, Math.min(0.98, hardness));
    const rgb = hexToRgb(color);
    const col = (a) => 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a + ')';

    if (texture === 'spray') {
      // Sparse dot spray builds up soft, speckled coverage.
      const dots = Math.round(30 + R * 7);
      for (let i = 0; i < dots; i++) {
        const ang = Math.random() * Math.PI * 2;
        const rad = Math.sqrt(Math.random()) * R;
        const rr = Math.max(0.4, R * (0.03 + Math.random() * 0.08));
        ctx.globalAlpha = 0.05 + Math.random() * 0.28;
        ctx.fillStyle = col(1);
        ctx.beginPath();
        ctx.arc(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad, rr, 0, Math.PI * 2);
        ctx.fill();
      }
      return c;
    }

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    grad.addColorStop(0, col(1));
    if (hard > 0.001) grad.addColorStop(hard, col(1));
    grad.addColorStop(1, col(0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();

    if (texture === 'grain') {
      punchNoise(ctx, cx, cy, R, Math.round(R * 9), 0.5, R * 0.03, R * 0.09);
    } else if (texture === 'chalk') {
      punchNoise(ctx, cx, cy, R, Math.round(R * 14), 0.8, R * 0.05, R * 0.18);
    } else if (texture === 'crayon') {
      punchNoise(ctx, cx, cy, R, Math.round(R * 11), 0.55, R * 0.05, R * 0.14);
      punchStreaks(ctx, cx, cy, R, Math.round(R * 2 + 6), 0.35);
    } else if (texture === 'watercolor') {
      punchNoise(ctx, cx, cy, R, Math.round(R * 8), 0.42, R * 0.1, R * 0.3);
    } else if (texture === 'paint') {
      punchStreaks(ctx, cx, cy, R, Math.round(R * 3 + 8), 0.5);
    }
    return c;
  }

  // â”€â”€â”€ Live stamp stroke (snapshot + stroke buffer compositing) â”€â”€â”€

  const stampState = {
    active: false,
    strokeCanvas: null,
    sctx: null,
    snapshot: null,
    sprite: null,
    cfg: null,
    bs: null,
    color: '#000',
    erase: false,
    size: 5,
    spacingPx: 1,
    flow: 1,
    scatter: 0,
    texture: 'none',
    taper: 0,
    fade: null,      // Force Fade settings while a fade stroke is in progress
    fadeStamps: null, // cached stamp descriptors for fade re-rendering
    fadeArc: 0,      // arc length travelled by the fade stroke (for the ramp)
    bbox: null,
    raf: null,
    pending: false,
    lastX: 0, lastY: 0,
    prevX: 0, prevY: 0,
  };

  // Fade stamp descriptors are also kept bounded; otherwise repaintFadeStamps()
  // would redraw every stamp ever placed on a very long stroke, every frame.
  const MAX_FADE_STAMPS = 2048;
  function capFadeStamps(list) {
    if (list.length <= MAX_FADE_STAMPS) return;
    const last = list[list.length - 1];
    let w = 1;
    for (let r = 2; r < list.length - 1; r += 2) list[w++] = list[r];
    list[w++] = last;
    list.length = w;
  }

  function stampComposite(layer, box) {
    const ss = stampState;
    if (!ss.snapshot || !ss.strokeCanvas) return;
    const ctx = layer.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Reset alpha/composite to known-good values before restoring the snapshot
    // so the restored canvas is always an exact opaque copy of the layer.
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    applySelectionClip(ctx);
    const amulRaw = Number(ss.cfg && ss.cfg.alphaMul);
    const amul = isFinite(amulRaw) ? Math.max(0, Math.min(1, amulRaw)) : 1;
    const strokeA = safeBrushOpacity() * (ss.erase ? 1 : amul);
    const alpha = Math.max(0, Math.min(1, strokeA));
    const op = ss.erase ? 'destination-out' : 'source-over';
    if (wandActive()) {
      // A soft wand mask needs the whole canvas; fall back to a full re-composite.
      ctx.clearRect(0, 0, state.docWidth, state.docHeight);
      ctx.drawImage(ss.snapshot, 0, 0);
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = op;
      drawDeltaMasked(ctx, ss.strokeCanvas);
    } else {
      compositeStrokeRegion(ctx, ss.snapshot, box, alpha, op, ss.strokeCanvas);
    }
    ctx.restore();
  }

  function stampRenderNow(box) {
    const ss = stampState;
    if (!ss.bbox) return;
    const layer = getActiveLayer();
    if (!layer) return;
    const target = box || ss.bbox;
    try {
      stampComposite(layer, target);
    } catch (e) {}
    try {
      scheduleRender(bboxToRect(target), true);
    } catch (e) {}
  }

  function scheduleStampRender() {
    const ss = stampState;
    if (!ss.active || ss.raf != null) return;
    ss.pending = true;
    ss.raf = requestAnimationFrame(() => {
      ss.raf = null;
      ss.pending = false;
      if (!ss.active) return;
      if (ss.fade) repaintFadeStamps();
      stampRenderNow();
      if (renderQueued) flushRender();
    });
  }

  function addStamp(x, y, sizeMul) {
    const ss = stampState;
    if (!ss.sctx || !ss.sprite) return;
    let dim = ss.sprite.width * (sizeMul || 1);
    if (!isFinite(dim) || dim <= 0) dim = ss.sprite.width;
    if (!isFinite(x) || !isFinite(y)) return;
    const scat = ss.scatter * ss.size;
    const px = x + (Math.random() * 2 - 1) * scat;
    const py = y + (Math.random() * 2 - 1) * scat;
    const ctx = ss.sctx;
    if (ss.texture !== 'none' && ss.texture !== 'spray') {
      const rot = Math.random() * Math.PI * 2;
      const c = Math.cos(rot), s = Math.sin(rot);
      ctx.setTransform(c, s, -s, c, px, py);
      ctx.drawImage(ss.sprite, -dim / 2, -dim / 2, dim, dim);
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(ss.sprite, px - dim / 2, py - dim / 2, dim, dim);
    }
    const nb = { x0: px - dim / 2, y0: py - dim / 2, x1: px + dim / 2, y1: py + dim / 2 };
    ss.bbox = ss.bbox ? unionBox(ss.bbox, nb) : nb;
    // The undo entry holds a reference to the live strokeBBox, so growing it
    // here makes the eventual undo restore the full stamp extent, not just the
    // seed circle captured at beginStroke.
    expandStrokeBBox(nb.x0, nb.y0, nb.x1, nb.y1);
    expandStrokeFrameBBox(nb.x0, nb.y0, nb.x1, nb.y1);
  }

  // Draws one stamp from a cached descriptor. Used by the fade re-render so
  // scatter offsets and rotations stay fixed between frames (no shimmer).
  function stampAt(desc, sizeMul, alphaMul) {
    const ss = stampState;
    if (!ss.sctx || !ss.sprite) return;
    let dim = ss.sprite.width * (sizeMul || 1);
    if (!isFinite(dim) || dim <= 0) dim = ss.sprite.width;
    const px = desc.x + desc.ox;
    const py = desc.y + desc.oy;
    if (!isFinite(px) || !isFinite(py)) return;
    const aMul = (alphaMul !== undefined && isFinite(alphaMul)) ? Math.max(0, Math.min(1, alphaMul)) : 1;
    const ctx = ss.sctx;
    ctx.globalAlpha = Math.max(0, Math.min(1, ss.flow * aMul));
    if (ss.texture !== 'none' && ss.texture !== 'spray') {
      const c = Math.cos(desc.rot), s = Math.sin(desc.rot);
      ctx.setTransform(c, s, -s, c, px, py);
      ctx.drawImage(ss.sprite, -dim / 2, -dim / 2, dim, dim);
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(ss.sprite, px - dim / 2, py - dim / 2, dim, dim);
    }
    const nb = { x0: px - dim / 2, y0: py - dim / 2, x1: px + dim / 2, y1: py + dim / 2 };
    ss.bbox = ss.bbox ? unionBox(ss.bbox, nb) : nb;
    expandStrokeBBox(nb.x0, nb.y0, nb.x1, nb.y1);
    expandStrokeFrameBBox(nb.x0, nb.y0, nb.x1, nb.y1);
  }

  // A stamp descriptor keeps its random scatter/rotation frozen so repeated
  // fade re-renders produce an identical path (only size/opacity change).
  function makeFadeStamp(x, y, arc) {
    const ss = stampState;
    const scat = ss.scatter * ss.size;
    return {
      x, y, arc,
      ox: (Math.random() * 2 - 1) * scat,
      oy: (Math.random() * 2 - 1) * scat,
      rot: Math.random() * Math.PI * 2,
    };
  }

  // Rebuilds the whole stroke buffer from the cached stamps, applying the fade
  // size and opacity ramp per stamp along the stroke path (no planar gradients).
  function repaintFadeStamps() {
    const ss = stampState;
    if (!ss.sctx || !ss.fadeStamps) return;
    const ctx = ss.sctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, state.docWidth, state.docHeight);
    ss.bbox = null;
    const list = ss.fadeStamps;
    if (!list.length) return;
    const total = ss.fadeArc > 0.0001 ? ss.fadeArc : 1;
    const cfg = ss.fade;
    const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
    const f = Math.max(0.001, Math.min(1, num(cfg.length, 35) / 100));
    const fadeDist = Math.max(ss.size * 1.5 * f, total * f);
    for (let i = 0; i < list.length; i++) {
      const dStart = list[i].arc;
      const dEnd = total - list[i].arc;
      const s = Math.min(1, Math.max(0, list[i].arc / total));
      const prof = fadeProfile(s, cfg, dStart, dEnd, fadeDist);
      stampAt(list[i], prof.w, prof.o);
    }
  }

  function beginStampStroke(docX, docY, layer) {
    const ss = stampState;
    const cfg = getBrushTypeCfg();
    const bs = getBrushState();
    ss.active = true;
    ss.cfg = getBrushTypeCfg();
    ss.bs = bs;
    ss.erase = state.tool === 'eraser';
    ss.color = state.brushColor;
    ss.size = safeBrushSize();
    ss.spacingPx = Math.max(0.6, (bs.spacing || 0.06) * ss.size);
    ss.flow = Math.max(0.02, Math.min(1, bs.flow));
    ss.scatter = bs.scatter || 0;
    ss.texture = bs.texture || 'none';
    ss.taper = ss.cfg.taper || 0;
    ss.fade = isFadeStroke() ? getFadeSettings() : null;
    ss.fadeStamps = ss.fade ? [] : null;
    ss.fadeArc = 0;
    ss.lastX = ss.prevX = state.smoothPoint.x;
    ss.lastY = ss.prevY = state.smoothPoint.y;
    ss.bbox = null;
    ss.sprite = makeBrushSprite(ss.size, ss.erase ? '#000' : state.brushColor, bs.hardness, ss.texture);

    if (!ss.snapshot) ss.snapshot = document.createElement('canvas');
    ss.snapshot.width = state.docWidth;
    ss.snapshot.height = state.docHeight;
    const snapCtx = ss.snapshot.getContext('2d');
    snapCtx.setTransform(1, 0, 0, 1, 0, 0);
    snapCtx.clearRect(0, 0, state.docWidth, state.docHeight);
    snapCtx.drawImage(layer.canvas, 0, 0);

    if (!ss.strokeCanvas) ss.strokeCanvas = document.createElement('canvas');
    ss.strokeCanvas.width = state.docWidth;
    ss.strokeCanvas.height = state.docHeight;
    ss.sctx = ss.strokeCanvas.getContext('2d');
    ss.sctx.setTransform(1, 0, 0, 1, 0, 0);
    ss.sctx.clearRect(0, 0, state.docWidth, state.docHeight);
    // Cached once per stroke; addStamp()/stampAt() only change the transform.
    ss.sctx.globalCompositeOperation = 'source-over';
    ss.sctx.globalAlpha = ss.flow;

    if (ss.fade) {
      ss.fadeStamps.push(makeFadeStamp(ss.lastX, ss.lastY, 0));
      repaintFadeStamps();
    } else {
      addStamp(ss.lastX, ss.lastY, 1);
    }
    stampRenderNow();
  }

  function continueStampStroke(x, y, deferRender) {
    const ss = stampState;
    if (!ss.active) return;
    const seg = Math.hypot(x - ss.prevX, y - ss.prevY);
    ss.prevX = x; ss.prevY = y;

    const dx = x - ss.lastX, dy = y - ss.lastY;
    const d = Math.hypot(dx, dy);
    if (d < ss.spacingPx) return;
    const steps = Math.floor(d / ss.spacingPx);
    const ux = dx / d, uy = dy / d;

    let sizeMul = 1;
    if (ss.taper) sizeMul = Math.max(0.4, 1 - ss.taper * Math.min(1, seg / Math.max(1, ss.size * 1.5)));

    for (let k = 1; k <= steps; k++) {
      ss.lastX += ux * ss.spacingPx;
      ss.lastY += uy * ss.spacingPx;
      if (ss.fade) {
        ss.fadeArc += ss.spacingPx;
        ss.fadeStamps.push(makeFadeStamp(ss.lastX, ss.lastY, ss.fadeArc));
      } else {
        addStamp(ss.lastX, ss.lastY, sizeMul);
      }
    }
    if (ss.fade && ss.fadeStamps.length > MAX_FADE_STAMPS) capFadeStamps(ss.fadeStamps);
    if (!deferRender) scheduleStampRender();
  }

  function endStampStroke() {
    const ss = stampState;
    if (ss.raf != null) { cancelAnimationFrame(ss.raf); ss.raf = null; }
    ss.pending = false;
    if (ss.fade) repaintFadeStamps();
    const layer = getActiveLayer();
    if (layer) {
      stampComposite(layer, ss.bbox);
      scheduleRender();
    }
    const finalBox = unionBox(ss.bbox, strokeBBox);
    ss.active = false;
    ss.strokeCanvas = null;
    ss.sctx = null;
    ss.snapshot = null;
    ss.sprite = null;
    ss.bbox = null;
    ss.fade = null;
    ss.fadeStamps = null;
    ss.fadeArc = 0;
    return finalBox;
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     FLOOD FILL
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function hexToRgb(hex) {
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const n = parseInt(c, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // Grows a binary mask by `r` pixels (8-connected). Implemented as two
  // separable 1D passes (horizontal then vertical): r iterations of an 8-way
  // dilation are identical to a square of side 2r+1, and separable passes are
  // ~4x cheaper than the naive 2D pass. Used to seal boundary pinholes before
  // flooding and to reach anti-aliased edges afterwards.
  function dilateMask(src, w, h, r) {
    if (r <= 0) return src;
    const n = w * h;
    const hbuf = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      const base = y * w;
      for (let x = 0; x < w; x++) {
        const x0 = x - r < 0 ? 0 : x - r;
        const x1 = x + r > w - 1 ? w - 1 : x + r;
        let hit = 0;
        for (let xx = x0; xx <= x1; xx++) {
          if (src[base + xx]) { hit = 1; break; }
        }
        hbuf[base + x] = hit;
      }
    }
    const out = new Uint8Array(n);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        const y0 = y - r < 0 ? 0 : y - r;
        const y1 = y + r > h - 1 ? h - 1 : y + r;
        let hit = 0;
        for (let yy = y0; yy <= y1; yy++) {
          if (hbuf[yy * w + x]) { hit = 1; break; }
        }
        out[y * w + x] = hit;
      }
    }
    return out;
  }

  // Reused flood-fill stack (grown to the largest document seen) to avoid
  // reallocating a large Int32Array on every fill.
  let floodRegionStack = null;

  // Span (scanline) flood fill through pixels where `member` is 1, following
  // 4-way connectivity â€” or 8-way (diagonals) when `eightWay` is set.
  //
  // Iterative and allocation-bounded: a typed Int32Array stack is sized to the
  // pixel count and every push claims at least one previously-unclaimed pixel,
  // so the stack can never grow past `n` and there is no call-stack recursion
  // (safe for 1080p+ documents). Filling whole horizontal runs instead of
  // individual pixels keeps it fast and avoids per-pixel division/modulo.
  function floodRegion(member, w, h, sx, sy, eightWay) {
    const n = w * h;
    const filled = new Uint8Array(n);
    const seeded = new Uint8Array(n);   // runs already queued, to avoid re-queuing
    const start = sy * w + sx;
    if (!member[start]) return filled;

    // Reused across calls: at 1080p a fresh Int32Array(n) is ~8MB, so keeping one
    // around avoids repeated large allocations / GC churn on every fill.
    if (!floodRegionStack || floodRegionStack.length < n) floodRegionStack = new Int32Array(n);
    const stack = floodRegionStack;
    let sp = 0;
    stack[sp++] = start;
    seeded[start] = 1;
    const pad = eightWay ? 1 : 0;       // diagonals reach one column further

    while (sp > 0) {
      const idx = stack[--sp];
      if (filled[idx]) continue;
      const y = (idx / w) | 0;
      const base = y * w;
      // Grow the run to its maximal horizontal extent, then fill it in one go.
      let xl = idx - base;
      let xr = xl;
      while (xl > 0 && member[base + xl - 1] && !filled[base + xl - 1]) xl--;
      while (xr < w - 1 && member[base + xr + 1] && !filled[base + xr + 1]) xr++;
      for (let x = xl; x <= xr; x++) filled[base + x] = 1;

      const lo = xl - pad < 0 ? 0 : xl - pad;
      const hi = xr + pad > w - 1 ? w - 1 : xr + pad;

      // Queue every unclaimed run touching this span on the rows just above and
      // below. Scanning the full run (not just the overlap window) prevents
      // neighbouring spans from queuing the same run again.
      for (let which = 0; which < 2; which++) {
        const row = which === 0 ? y - 1 : y + 1;
        if (row < 0 || row > h - 1) continue;
        const rbase = row * w;
        let x = lo;
        while (x <= hi) {
          const k = rbase + x;
          if (filled[k] || seeded[k] || !member[k]) { x++; continue; }
          let a = x;
          while (a > 0 && member[rbase + a - 1] && !filled[rbase + a - 1] && !seeded[rbase + a - 1]) a--;
          let b = x;
          while (b < w - 1 && member[rbase + b + 1] && !filled[rbase + b + 1] && !seeded[rbase + b + 1]) b++;
          stack[sp++] = rbase + a;
          for (let i = a; i <= b; i++) seeded[rbase + i] = 1;
          x = b + 1;
        }
      }
    }
    return filled;
  }

  // Reusable scratch for compositing visible layers when sampling "all layers".
  let fillSampleCanvas = null;
  let fillSampleCtx = null;

  // Composites every visible artwork layer (respecting visibility, opacity and
  // nested groups) into one RGBA snapshot for boundary sampling. The reference
  // image, selection overlay and tool cursors are not layers, so they are
  // naturally excluded. Read-only: source layers are never modified.
  function sampleAllLayers(bx, by, bw, bh) {
    if (!fillSampleCanvas) {
      fillSampleCanvas = createOffscreenCanvas();
      fillSampleCtx = fillSampleCanvas.getContext('2d');
    }
    const ctx = fillSampleCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, state.docWidth, state.docHeight);
    // Offset so the document region (bx,by,bw,bh) lands at scratch (0,0).
    ctx.setTransform(1, 0, 0, 1, -bx, -by);
    drawNodes(ctx, state.layers, 0);
    return ctx.getImageData(0, 0, bw, bh);
  }

  // True if a filled region reaches any edge of the (possibly selection-cropped)
  // work area â€” the signal that the outline is open and the fill could leak.
  function regionTouchesBorder(region, w, h) {
    for (let x = 0; x < w; x++) if (region[x] || region[(h - 1) * w + x]) return true;
    for (let y = 0; y < h; y++) if (region[y * w] || region[y * w + w - 1]) return true;
    return false;
  }

  function floodFill(docX, docY) {
    if (!canEditActive()) return;
    const layer = getActiveLayer();
    if (!layer) return;
    const x0 = Math.round(docX), y0 = Math.round(docY);
    const w = state.docWidth, h = state.docHeight;
    if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return;

    // Respect selection bounds â€” crop the work area to it for speed.
    let bx = 0, by = 0, bx2 = w, by2 = h;
    if (selectState.active) {
      bx = Math.max(0, Math.floor(selectState.x));
      by = Math.max(0, Math.floor(selectState.y));
      bx2 = Math.min(w, Math.ceil(selectState.x + selectState.w));
      by2 = Math.min(h, Math.ceil(selectState.y + selectState.h));
      if (x0 < bx || y0 < by || x0 >= bx2 || y0 >= by2) return;
    }
    const bw = bx2 - bx, bh = by2 - by;
    if (bw <= 0 || bh <= 0) return;

    const sx = x0 - bx, sy = y0 - by;

    // The active layer is always where the fill is painted.
    const activeImg = layer.ctx.getImageData(bx, by, bw, bh);
    const activeData = activeImg.data;

    // Boundary detection samples either the active layer alone or the composite
    // of every visible layer â€” so outlines on other layers still contain the
    // fill without those layers being modified.
    const sampleImg = fillState.sampleAll ? sampleAllLayers(bx, by, bw, bh) : activeImg;
    const data = sampleImg.data;

    const n = bw * bh;
    const seedIdx = (sy * bw + sx) * 4;
    const tR = data[seedIdx], tG = data[seedIdx + 1], tB = data[seedIdx + 2], tA = data[seedIdx + 3];

    const fill = hexToRgb(state.brushColor);
    const fR = fill[0], fG = fill[1], fB = fill[2];
    const a = Math.max(0, Math.min(1, state.brushOpacity));
    const fA = Math.round(a * 255);

    const pixelArt = fillState.pixelArt;
    const eightWay = fillState.eightWay;
    const tol = pixelArt ? 0 : fillState.tolerance;
    const GAP_CLOSE = pixelArt ? 0 : 1;   // seal hairline gaps before flooding

    if (Math.abs(fR - tR) <= tol && Math.abs(fG - tG) <= tol &&
      Math.abs(fB - tB) <= tol && Math.abs(fA - tA) <= tol) {
      showToast('Area already filled', 'error');
      return;
    }

    // Per-pixel distance from the sampled color (max channel diff, incl. alpha).
    // Alpha matters because drawing layers are transparent between strokes.
    const dist = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      let d = Math.abs(data[j] - tR);
      const dg = Math.abs(data[j + 1] - tG); if (dg > d) d = dg;
      const db = Math.abs(data[j + 2] - tB); if (db > d) d = db;
      const da = Math.abs(data[j + 3] - tA); if (da > d) d = da;
      dist[i] = d;
    }

    const barrier = new Uint8Array(n);
    for (let i = 0; i < n; i++) barrier[i] = dist[i] > tol ? 1 : 0;

    // If the tap lands on ink that belongs to another layer (visible in the
    // composite but not on the active layer) there is nothing to fill here â€”
    // avoid duplicating that line/fill onto the active layer.
    if (data[seedIdx + 3] > 0 && activeData[seedIdx + 3] === 0) return;

    let region;
    if (fillState.contiguous) {
      // Flood the raw free space first: this reaches every corner and narrow
      // tip with no shrinkage. Only if that region runs to the canvas edge
      // (an open outline or a gap) do we seal hairline gaps and refill
      // conservatively so the fill cannot leak out.
      const free = new Uint8Array(n);
      for (let i = 0; i < n; i++) free[i] = barrier[i] ? 0 : 1;
      region = floodRegion(free, bw, bh, sx, sy, eightWay);
      if (regionTouchesBorder(region, bw, bh)) {
        const closed = dilateMask(barrier, bw, bh, GAP_CLOSE);
        const sealed = new Uint8Array(n);
        for (let i = 0; i < n; i++) sealed[i] = closed[i] ? 0 : 1;
        region = floodRegion(sealed, bw, bh, sx, sy, eightWay);
      }
    } else {
      region = new Uint8Array(n);
      for (let i = 0; i < n; i++) if (dist[i] <= tol) region[i] = 1;
      region[sy * bw + sx] = 1;
    }

    // Nothing fillable â€” bail before recording an undo step or repainting.
    if (!region[sy * bw + sx]) return;

    // Rim = pixels immediately adjacent to the filled region. A partially
    // transparent rim pixel on the active layer is an anti-aliased outline edge;
    // converting it to an opaque "line over fill" blend keeps the outline's
    // apparent thickness and colour while removing the halo â€” the fill sits
    // behind the line instead of painting over it.
    let rim = null;
    if (!pixelArt) {
      rim = dilateMask(region, bw, bh, 1);
      for (let i = 0; i < n; i++) if (region[i]) rim[i] = 0;
    }

    pushUndo(layer);
    const ctx = layer.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (selectState.active) {
      ctx.beginPath();
      ctx.rect(bx, by, bw, bh);
      ctx.clip();
    }

    const tmp = document.createElement('canvas');
    tmp.width = bw;
    tmp.height = bh;
    const tmpCtx = tmp.getContext('2d');
    const outImg = tmpCtx.createImageData(bw, bh);
    const out = outImg.data;

    for (let i = 0, j = 0; i < n; i++, j += 4) {
      if (region[i]) {
        out[j] = fR; out[j + 1] = fG; out[j + 2] = fB; out[j + 3] = fA;
      } else if (rim && rim[i]) {
        const aj = activeData[j + 3];
        if (aj > 0 && aj < 255) {
          const alpha = aj / 255;
          out[j]     = Math.round(activeData[j]     * alpha + fR * (1 - alpha));
          out[j + 1] = Math.round(activeData[j + 1] * alpha + fG * (1 - alpha));
          out[j + 2] = Math.round(activeData[j + 2] * alpha + fB * (1 - alpha));
          out[j + 3] = 255;
        }
      }
    }

    tmpCtx.putImageData(outImg, 0, 0);
    // A soft wand selection multiplies the fill through the mask so the filled
    // region follows the selection's smooth, anti-aliased boundary.
    if (wandActive()) {
      tmpCtx.globalCompositeOperation = 'destination-in';
      tmpCtx.drawImage(selectState.maskCanvas, -bx, -by);
      tmpCtx.globalCompositeOperation = 'source-over';
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(tmp, bx, by);
    ctx.restore();

    // Sync the filled region to other devices (fills are pixel edits, not
    // incremental strokes). Ship only the affected bbox to keep payloads small.
    try {
      const fillBBox = { x0: bx, y0: by, x1: bx + bw, y1: by + bh };
      sendRestore(layer, fillBBox, snapshotLayer(layer, fillBBox));
    } catch (e) { /* ignore */ }

    updateLayerThumbnail(layer.id);
    scheduleRender();
    showToast('Filled');
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     TEXT TOOL
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function beginText(clientX, clientY) {
    const doc = screenToDoc(clientX, clientY);
    textState.docX = doc.x;
    textState.docY = doc.y;
    const input = $('#textInput');
    const rect = canvasArea.getBoundingClientRect();
    input.style.left = Math.max(4, clientX - rect.left) + 'px';
    input.style.top = Math.max(4, clientY - rect.top) + 'px';
    input.style.fontSize = Math.min(24, Math.max(12, textState.size * state.zoom)) + 'px';
    input.value = '';
    input.classList.remove('hidden');
    textState.editing = true;
    textState.committing = false;
    setTimeout(() => input.focus(), 0);
  }

  function commitText() {
    if (textState.committing) return;
    textState.committing = true;
    const input = $('#textInput');
    const txt = input.value;
    input.classList.add('hidden');
    input.blur();
    textState.editing = false;
    if (!txt.trim()) { textState.committing = false; return; }

    const layer = getActiveLayer();
    if (!layer) { textState.committing = false; return; }
    if (!canEditActive()) { textState.committing = false; return; }

    pushUndo(layer);
    // Measure before paintDelta: it reuses the shared scratch canvas, so the
    // font must be applied (and the metrics read) before the paint callback.
    const mstyle = textState.style;
    const mweight = mstyle === 'bold' ? '700' : '400';
    const mitalic = mstyle === 'italic' ? 'italic ' : '';
    const mctx = getWandPaintScratch().getContext('2d');
    mctx.font = `${mitalic}${mweight} ${textState.size}px Inter, sans-serif`;
    mctx.textBaseline = 'top';
    const metrics = mctx.measureText(txt);
    const textBBox = {
      x0: textState.docX - 2, y0: textState.docY - 2,
      x1: textState.docX + Math.max(0, metrics.width) + 2,
      y1: textState.docY + textState.size * 1.4 + 2,
    };
    paintDelta(layer, (c) => {
      c.globalCompositeOperation = 'source-over';
      c.globalAlpha = safeBrushOpacity();
      c.fillStyle = state.brushColor;
      const style = textState.style;
      const weight = style === 'bold' ? '700' : '400';
      const italic = style === 'italic' ? 'italic ' : '';
      c.font = `${italic}${weight} ${textState.size}px Inter, sans-serif`;
      c.textBaseline = 'top';
      c.fillText(txt, textState.docX, textState.docY);
    });
    sendRestore(layer, textBBox, layer.canvas);
    updateLayerThumbnail(layer.id);
    scheduleRender();
    showToast('Text placed', 'success');
    textState.committing = false;
  }

  function cancelText() {
    const input = $('#textInput');
    input.value = '';
    input.classList.add('hidden');
    textState.editing = false;
    textState.committing = false;
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     EYEDROPPER
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function pickColor(docX, docY) {
    const px = Math.round(docX), py = Math.round(docY);
    if (px < 0 || py < 0 || px >= state.docWidth || py >= state.docHeight) return;
    const data = displayCtx.getImageData(px, py, 1, 1).data;
    const hex = '#' + [data[0], data[1], data[2]].map(v => v.toString(16).padStart(2, '0')).join('');
    setColor(hex);
    showToast(`Picked ${hex.toUpperCase()}`);
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     HISTORY (UNDO/REDO)
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function pushUndo(layer, meta) {
    state.undoStack.push({
      layerId: layer.id,
      bbox: meta && meta.bbox ? meta.bbox : null,
      // Always snapshot the full layer. snapshotLayer already allocates a
      // full-size canvas either way (bbox only limits the blit), so this costs
      // nothing extra â€” but it makes undo exact even when the live stroke bbox
      // outgrew the seed box the entry was created with.
      snap: snapshotLayer(layer),
    });
    if (state.undoStack.length > state.maxHistory) state.undoStack.shift();
    state.redoStack = [];
    markLayerDirty(layer.id);
    updateHistoryButtons();
  }

  function clampBBox(bbox) {
    const W = state.docWidth, H = state.docHeight;
    if (!bbox) return { x0: 0, y0: 0, x1: W, y1: H };
    const x0 = Math.max(0, Math.floor(bbox.x0));
    const y0 = Math.max(0, Math.floor(bbox.y0));
    const x1 = Math.min(W, Math.ceil(bbox.x1));
    const y1 = Math.min(H, Math.ceil(bbox.y1));
    return (x1 > x0 && y1 > y0) ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 0, y1: 0 };
  }

  // Copies the layer (optionally only `bbox`) into an off-screen canvas. Used
  // for history snapshots â€” a canvas blit stays on the GPU, unlike getImageData
  // which forces an 8 MB CPU read-back on every stroke and stalls iOS.
  function snapshotLayer(layer, bbox) {
    const c = document.createElement('canvas');
    c.width = state.docWidth;
    c.height = state.docHeight;
    const cx = c.getContext('2d');
    cx.setTransform(1, 0, 0, 1, 0, 0);
    cx.globalAlpha = 1;
    cx.globalCompositeOperation = 'source-over';
    if (!bbox) {
      cx.drawImage(layer.canvas, 0, 0);
    } else {
      const r = clampBBox(bbox);
      if (r.x1 > r.x0 && r.y1 > r.y0)
        cx.drawImage(layer.canvas, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    }
    return c;
  }

  // Writes `snap` back onto the layer, replacing exactly `bbox` (or all of it).
  function restoreLayerFrom(layer, snap, bbox) {
    const ctx = layer.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (!bbox) {
      ctx.clearRect(0, 0, state.docWidth, state.docHeight);
      ctx.drawImage(snap, 0, 0);
    } else {
      const r = clampBBox(bbox);
      if (r.x1 > r.x0 && r.y1 > r.y0) {
        ctx.clearRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
        ctx.drawImage(snap, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      }
    }
    ctx.restore();
  }

  // â”€â”€ Undo/redo â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // History is per-device and holds only this device's own edits. To keep the
  // two screens identical, every undo/redo also ships the restored pixels to
  // the peer (see sendRestore). Converging on pixels â€” instead of assuming two
  // independently-fed history stacks stay in lock-step â€” means a diverged or
  // overflowing stack can never leave the devices permanently out of sync.
  function undo() {
    if (!state.undoStack.length) return;
    const entry = state.undoStack.pop();
    const layer = findNode(entry.layerId);
    if (layer) {
      state.redoStack.push({ layerId: layer.id, bbox: entry.bbox, snap: snapshotLayer(layer) });
      restoreLayerFrom(layer, entry.snap, entry.bbox);
      updateLayerThumbnail(layer.id);
      scheduleRender();
      sendRestore(layer, entry.bbox, entry.snap);
    }
    updateHistoryButtons();
  }

  function redo() {
    if (!state.redoStack.length) return;
    const entry = state.redoStack.pop();
    const layer = findNode(entry.layerId);
    if (layer) {
      state.undoStack.push({ layerId: layer.id, bbox: entry.bbox, snap: snapshotLayer(layer) });
      restoreLayerFrom(layer, entry.snap, entry.bbox);
      updateLayerThumbnail(layer.id);
      scheduleRender();
      sendRestore(layer, entry.bbox, entry.snap);
    }
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    const hasUndo = state.undoStack.length > 0;
    const hasRedo = state.redoStack.length > 0;
    ['#btnUndo', '#btnUndo2'].forEach(s => { const el = $(s); if (el) el.disabled = !hasUndo; });
    ['#btnRedo', '#btnRedo2'].forEach(s => { const el = $(s); if (el) el.disabled = !hasRedo; });
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     REFERENCE IMAGE
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function importReference() {
    $('#refImageInput').click();
  }

  function insertImage() {
    $('#insertImageInput').click();
  }

  function handleInsertImageLoad(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const layerName = file.name.replace(/\.[^.]+$/, '').slice(0, 24) || 'Image';
        const layer = createLayer(layerName);
        const iw = img.naturalWidth, ih = img.naturalHeight;
        if (iw > 0 && ih > 0) {
          const scale = Math.min(1, state.docWidth / iw, state.docHeight / ih);
          const dw = iw * scale, dh = ih * scale;
          const dx = (state.docWidth - dw) / 2;
          const dy = (state.docHeight - dh) / 2;
          const ctx = layer.ctx;
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(img, dx, dy, dw, dh);
          ctx.restore();
        }
        updateLayerThumbnail(layer.id);
        scheduleRender();
        selectTool('layer-transform');
        showToast(`Inserted "${layerName}" â€” drag, scale & rotate to place it`, 'success');
      };
      img.onerror = () => showToast('Could not load that image', 'error');
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  function handleRefImageLoad(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        state.refImage = img;
        state.refVisible = true;
        state.refLocked = false;
        fitRefToCanvas(true);
        $('#refInfo').textContent = `${file.name} (${img.naturalWidth}Ã—${img.naturalHeight})`;
        const lockChk = $('#checkRefLocked'); if (lockChk) lockChk.checked = false;
        updateRefToggleIcon();
        updateLayerList();
        scheduleRender();
        renderOverlay();
        publishReference(true);
        showToast('Reference loaded â€” it will not appear in exports', 'success');
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  function fitRefToCanvas(recenter) {
    if (!state.refImage) return;
    const iw = state.refImage.naturalWidth, ih = state.refImage.naturalHeight;
    state.refScale = Math.min(state.docWidth / iw, state.docHeight / ih);
    if (recenter) {
      state.refX = state.docWidth / 2;
      state.refY = state.docHeight / 2;
      state.refRotation = 0;
    }
  }

  function resetRefTransform() {
    if (!state.refImage) { showToast('No reference image loaded', 'error'); return; }
    fitRefToCanvas(true);
    scheduleRender();
    renderOverlay();
    publishReference(false);
    showToast('Reference transform reset');
  }

  function toggleReference() {
    if (!state.refImage) { showToast('No reference image loaded', 'error'); return; }
    // If it's popped out into its own window, toggling brings it back to the canvas
    if (referenceIsPoppedOut()) { closeReferenceWindow(false); return; }
    state.refVisible = !state.refVisible;
    updateRefToggleIcon();
    updateLayerList();
    scheduleRender();
    publishReference(false);
    showToast(state.refVisible ? 'Reference visible (viewers WILL see this while sharing)' : 'Reference hidden');
  }

  function updateRefToggleIcon() {
    const btn = $('#btnToggleRef');
    if (btn) btn.classList.toggle('active', state.refVisible && !!state.refImage);
    const pBtn = $('#btnPrivacyRef');
    if (pBtn) pBtn.classList.toggle('active', state.refVisible && !!state.refImage);
    updateRefShareStatus();
  }

  function updateRefShareStatus() {
    const el = $('#refShareStatus');
    if (!el) return;
    if (!state.refImage) { el.textContent = 'No reference loaded.'; el.className = 'ref-info'; return; }
    if (referenceIsPoppedOut()) {
      el.textContent = 'Reference is in a separate window â€” it is NOT in the shared canvas.';
      el.className = 'ref-info ref-safe';
    } else if (state.refVisible) {
      el.textContent = 'Reference is on the canvas â€” viewers WILL see it while sharing.';
      el.className = 'ref-info ref-warn';
    } else {
      el.textContent = 'Reference is hidden.';
      el.className = 'ref-info';
    }
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     REFERENCE POPOUT  (keeps the reference OUT of the
     window you share in Discord, so viewers see only the
     white canvas and your brush strokes)
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  let refPopWin = null;   // separate browser window (popup)
  let refPipWin = null;   // Document Picture-in-Picture window

  function buildRefViewer(doc, pct) {
    doc.body.innerHTML = '';
    const style = doc.createElement('style');
    style.textContent =
      'html,body{margin:0;height:100%;background:#0e0e10;color:#ddd;font-family:Segoe UI,Inter,sans-serif;overflow:hidden}' +
      '#bar{position:fixed;top:0;left:0;right:0;height:34px;display:flex;align-items:center;gap:10px;padding:0 12px;background:#1a1a1c;border-bottom:1px solid #2a2a2e;font-size:12px;z-index:2;box-sizing:border-box}' +
      '#bar input{flex:1;accent-color:#35a3e8}' +
      '#stage{position:absolute;inset:34px 0 0 0;display:flex;align-items:center;justify-content:center;overflow:hidden}' +
      'img{max-width:100%;max-height:100%;-webkit-user-select:none;user-select:none;pointer-events:none}';
    doc.head.appendChild(style);

    const bar = doc.createElement('div'); bar.id = 'bar';
    const label = doc.createElement('span'); label.textContent = 'Opacity';
    const op = doc.createElement('input'); op.type = 'range'; op.min = 10; op.max = 100; op.value = pct;
    const opv = doc.createElement('span'); opv.textContent = pct + '%';
    const img = doc.createElement('img'); img.src = state.refImage.src; img.style.opacity = (pct / 100);
    op.addEventListener('input', () => { img.style.opacity = op.value / 100; opv.textContent = op.value + '%'; });
    bar.appendChild(label); bar.appendChild(op); bar.appendChild(opv);

    const stage = doc.createElement('div'); stage.id = 'stage';
    stage.appendChild(img);
    doc.body.appendChild(bar); doc.body.appendChild(stage);
  }

  function referenceIsPoppedOut() {
    return (refPipWin && !refPipWin.closed) || (refPopWin && !refPopWin.closed);
  }

  function closeReferenceWindow(silent) {
    try { if (refPipWin && !refPipWin.closed) refPipWin.close(); } catch (e) { }
    try { if (refPopWin && !refPopWin.closed) refPopWin.close(); } catch (e) { }
    refPipWin = null;
    refPopWin = null;
    state.refVisible = true;
    updateRefToggleIcon();
    updateLayerList();
    scheduleRender();
    if (!silent) showToast('Reference brought back onto the canvas');
  }

  async function openReferenceWindow() {
    if (!state.refImage) { showToast('Import a reference image first', 'error'); return; }

    // Click again to bring it back
    if (referenceIsPoppedOut()) { closeReferenceWindow(false); return; }

    const pct = Math.max(10, Math.round(state.refOpacity * 100));
    let opened = false;

    // Preferred: Document Picture-in-Picture (a real separate, always-on-top window)
    if ('documentPictureInPicture' in window) {
      try {
        refPipWin = await documentPictureInPicture.requestWindow({ width: 520, height: 380 });
        buildRefViewer(refPipWin.document, pct);
        refPipWin.addEventListener('pagehide', () => { refPipWin = null; });
        opened = true;
      } catch (e) {
        refPipWin = null;
      }
    }

    // Fallback: classic separate popup window (self-contained HTML)
    if (!opened) {
      const html =
        '<!doctype html><html><head><meta charset="utf-8"><title>Artee - Reference</title>' +
        '<style>' +
        'html,body{margin:0;height:100%;background:#0e0e10;color:#ddd;font-family:Segoe UI,Inter,sans-serif;overflow:hidden}' +
        '#bar{position:fixed;top:0;left:0;right:0;height:34px;display:flex;align-items:center;gap:10px;padding:0 12px;background:#1a1a1c;border-bottom:1px solid #2a2a2e;font-size:12px;z-index:2;box-sizing:border-box}' +
        '#bar input{flex:1;accent-color:#35a3e8}' +
        '#stage{position:absolute;inset:34px 0 0 0;display:flex;align-items:center;justify-content:center;overflow:hidden}' +
        '#img{max-width:100%;max-height:100%;-webkit-user-select:none;user-select:none;pointer-events:none}' +
        '</style></head><body>' +
        '<div id="bar"><span>Reference opacity</span><input id="op" type="range" min="10" max="100" value="' + pct + '"><span id="opv">' + pct + '%</span></div>' +
        '<div id="stage"><img id="img" src="' + state.refImage.src + '" style="opacity:' + (pct / 100) + '"></div>' +
        '<script>' +
        'var img=document.getElementById("img"),op=document.getElementById("op"),opv=document.getElementById("opv");' +
        'op.addEventListener("input",function(){img.style.opacity=op.value/100;opv.textContent=op.value+"%";});' +
        '<\/script></body></html>';
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      refPopWin = window.open(url, 'arteeReference',
        'popup=yes,width=680,height=460,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=no');
      if (!refPopWin) {
        URL.revokeObjectURL(url);
        showToast('Allow pop-ups for this page, then try again', 'error');
        return;
      }
      setTimeout(() => URL.revokeObjectURL(url), 15000);
    }

    // Hide the reference from the canvas so the shared window is only the white canvas
    state.refVisible = false;
    updateRefToggleIcon();
    updateLayerList();
    scheduleRender();
    showToast('Reference is now in a separate window â€” the shared canvas shows only your drawing', 'success');
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     OUTPUT WINDOW  (share THIS in Discord)
     You keep tracing on the main canvas with the reference
     visible; this second window shows ONLY the white canvas
     + your drawing, so viewers never see the reference.
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  let outWin = null;
  let outMode = null;          // 'direct' (drive a same-origin window's canvas) | 'post' (blob + postMessage)
  let outCanvas = null;
  let outCtx = null;
  let outOff = null;
  let outOffCtx = null;
  let outFallbackCanvas = null;
  let outFallbackCtx = null;
  let outScratchCanvas = null;
  let outScratchCtx = null;
  let outputUpdateQueued = false;

  // Throttled update (used when panning/zooming so the Output tracks the view smoothly).
  function scheduleOutputUpdate() {
    if (outputUpdateQueued) return;
    outputUpdateQueued = true;
    try {
      requestAnimationFrame(() => { outputUpdateQueued = false; try { updateOutputWindow(); } catch (e) {} });
    } catch (e) {
      outputUpdateQueued = false;
      try { updateOutputWindow(); } catch (e) {}
    }
  }

  // The region of the document the Output should show: the visible viewport
  // (so viewers see where you're zoomed in) or the whole canvas.
  function outputSourceRect() {
    const whole = { x: 0, y: 0, w: state.docWidth, h: state.docHeight };
    if (!state.outputFollowView) return whole;
    try {
      const vp = canvasViewport.getBoundingClientRect();
      const cv = displayCanvas.getBoundingClientRect();
      const left = Math.max(vp.left, cv.left);
      const top = Math.max(vp.top, cv.top);
      const right = Math.min(vp.right, cv.right);
      const bottom = Math.min(vp.bottom, cv.bottom);
      if (right <= left || bottom <= top) return whole;
      const a = screenToDoc(left, top);
      const b = screenToDoc(right, bottom);
      const x = Math.max(0, Math.min(state.docWidth - 1, a.x));
      const y = Math.max(0, Math.min(state.docHeight - 1, a.y));
      const w = Math.min(state.docWidth, b.x) - x;
      const h = Math.min(state.docHeight, b.y) - y;
      if (w <= 1 || h <= 1) return whole;
      return { x, y, w, h };
    } catch (e) { return whole; }
  }

  // Builds a canvas-only page inside an accessible (same-origin) document.
  function writeOutputDoc(doc) {
    doc.body.style.cssText = 'margin:0;height:100%;background:#0e0e10;overflow:hidden';
    const st = doc.createElement('style');
    st.textContent = 'canvas{width:100%;height:100%;object-fit:contain;display:block}';
    doc.head.appendChild(st);
    doc.body.innerHTML = '';
    const c = doc.createElement('canvas');
    c.id = 'out';
    c.width = state.docWidth;
    c.height = state.docHeight;
    doc.body.appendChild(c);
    return c;
  }

  function resetOutputRefs() {
    outWin = null; outCanvas = null; outCtx = null;
    outOff = null; outOffCtx = null; outFallbackCanvas = null; outFallbackCtx = null; outMode = null;
  }

  // A blank page used only for the cross-origin blob fallback.
  const OUTPUT_PAGE_HTML =
    '<!doctype html><html><head><meta charset="utf-8"><title>Artee Output</title>' +
    '<style>html,body{margin:0;height:100%;background:#0e0e10;overflow:hidden}' +
    'canvas{width:100%;height:100%;object-fit:contain;display:block}</style>' +
    '</head><body><canvas id="out" width="1920" height="1080"></canvas></body></html>';

  function openOutputWindow() {
    if (outWin && !outWin.closed) { try { outWin.focus(); } catch (e) { } return; }

    // A plain blank window. It does NOT reveal your local file path or a blob: URL.
    outWin = window.open('about:blank', 'arteeOutput',
      'width=1000,height=580,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=no');

    let direct = false;
    if (outWin) {
      try {
        outCanvas = writeOutputDoc(outWin.document);
        outCtx = outCanvas.getContext('2d');
        try { outWin.document.title = 'Artee Output'; } catch (e) { }
        direct = true;
      } catch (e) { direct = false; }
    }

    if (!direct) {
      // Last resort: self-contained blob page updated via postMessage (cross-origin safe).
      if (outWin && !outWin.closed) { try { outWin.close(); } catch (e) { } }
      outWin = null;
      outCanvas = null;
      outCtx = null;
      const html = OUTPUT_PAGE_HTML.replace('</body>',
        '<script>' +
        'var c=document.getElementById("out"),ctx=c.getContext("2d");' +
        'window.addEventListener("message",function(e){var d=e.data;if(!d||d.type!=="artee-frame")return;' +
        'if(d.w&&c.width!==d.w){c.width=d.w;c.height=d.h;}' +
        'if(d.bmp){ctx.clearRect(0,0,c.width,c.height);ctx.drawImage(d.bmp,0,0);if(d.bmp.close)d.bmp.close();}});' +
        '<\/script></body>');
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      outWin = window.open(url, 'arteeOutput',
        'width=1000,height=580,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=no');
      setTimeout(() => URL.revokeObjectURL(url), 15000);
      if (!outWin) { showToast('Allow pop-ups for this page, then open the output window', 'error'); return; }
      if (typeof OffscreenCanvas !== 'undefined') {
        outOff = new OffscreenCanvas(state.docWidth, state.docHeight);
        outOffCtx = outOff.getContext('2d');
      } else {
        outFallbackCanvas = createOffscreenCanvas();
        outFallbackCtx = outFallbackCanvas.getContext('2d');
      }
    }

    outMode = direct ? 'direct' : 'post';
    outWin.addEventListener('pagehide', resetOutputRefs);
    updateOutputWindow();
    showToast('Output window open â€” share it in Discord', 'success');
  }

  function updateOutputWindow() {
    if (!outWin || outWin.closed) return;
    try {
      const src = outputSourceRect();

      // Composite the FULL drawing into a scratch canvas once.
      if (!outScratchCtx) {
        outScratchCanvas = createOffscreenCanvas();
        outScratchCtx = outScratchCanvas.getContext('2d');
      }
      compositeDrawingOnly(outScratchCtx);

      // Render the visible region at a fixed high resolution (so zooming in stays
      // crisp and fills the window, instead of shrinking to a tiny box).
      const long = 1920;
      let tw, th;
      if (src.w >= src.h) { tw = long; th = Math.max(1, Math.round(long * src.h / src.w)); }
      else { th = long; tw = Math.max(1, Math.round(long * src.w / src.h)); }

      if (outMode === 'direct' && outCtx) {
        if (outCanvas.width !== tw || outCanvas.height !== th) { outCanvas.width = tw; outCanvas.height = th; }
        outCtx.drawImage(outScratchCanvas, src.x, src.y, src.w, src.h, 0, 0, tw, th);
      } else if (outOff && outOffCtx) {
        if (outOff.width !== tw || outOff.height !== th) { outOff.width = tw; outOff.height = th; }
        outOffCtx.drawImage(outScratchCanvas, src.x, src.y, src.w, src.h, 0, 0, tw, th);
        const bmp = outOff.transferToImageBitmap();
        outWin.postMessage({ type: 'artee-frame', bmp, w: tw, h: th }, '*', [bmp]);
      } else if (outFallbackCtx) {
        if (outFallbackCanvas.width !== tw || outFallbackCanvas.height !== th) {
          outFallbackCanvas.width = tw;
          outFallbackCanvas.height = th;
        }
        outFallbackCtx.drawImage(outScratchCanvas, src.x, src.y, src.w, src.h, 0, 0, tw, th);
        createImageBitmap(outFallbackCanvas).then((bmp) => {
          if (outWin && !outWin.closed) {
            outWin.postMessage({ type: 'artee-frame', bmp, w: tw, h: th }, '*', [bmp]);
          }
        }).catch(() => { });
      }
    } catch (e) { /* window unloaded */ }
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     REFERENCE TRANSFORM (move / scale / rotate)
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function transformHandlePoints() {
    const img = state.refImage;
    if (!img) return null;
    const hw = img.naturalWidth * state.refScale / 2;
    const hh = img.naturalHeight * state.refScale / 2;
    const cos = Math.cos(state.refRotation), sin = Math.sin(state.refRotation);
    const cx = state.refX, cy = state.refY;
    const local = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    const corners = local.map((pt) => ({
      x: cx + pt[0] * cos - pt[1] * sin,
      y: cy + pt[0] * sin + pt[1] * cos,
    }));
    const topMid = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
    const ox = topMid.x - cx, oy = topMid.y - cy;
    const ol = Math.hypot(ox, oy) || 1;
    const off = 30 / state.zoom;
    const rotate = { x: topMid.x + (ox / ol) * off, y: topMid.y + (oy / ol) * off };
    return { corners, rotate, center: { x: cx, y: cy }, hw, hh };
  }

  function pointInRefRect(docX, docY) {
    const img = state.refImage;
    if (!img) return false;
    const hw = img.naturalWidth * state.refScale / 2;
    const hh = img.naturalHeight * state.refScale / 2;
    const cos = Math.cos(-state.refRotation), sin = Math.sin(-state.refRotation);
    const dx = docX - state.refX, dy = docY - state.refY;
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    return Math.abs(lx) <= hw && Math.abs(ly) <= hh;
  }

  function hitTransformHandle(clientX, clientY) {
    const g = transformHandlePoints();
    if (!g) return null;
    for (let i = 0; i < 4; i++) {
      const s = docToScreen(g.corners[i].x, g.corners[i].y);
      if (Math.hypot(clientX - s.x, clientY - s.y) <= 14) return { type: 'scale', corner: i };
    }
    const rs = docToScreen(g.rotate.x, g.rotate.y);
    if (Math.hypot(clientX - rs.x, clientY - rs.y) <= 14) return { type: 'rotate' };
    const doc = screenToDoc(clientX, clientY);
    if (pointInRefRect(doc.x, doc.y)) return { type: 'move' };
    return null;
  }

  function drawTransformOverlay() {
    if (!overlayCtx) return;
    const g = transformHandlePoints();
    if (!g) return;
    const sc = 1 / state.zoom;
    overlayCtx.save();
    overlayCtx.strokeStyle = 'rgba(53,163,232,0.95)';
    overlayCtx.lineWidth = 1.6 * sc;
    overlayCtx.beginPath();
    overlayCtx.moveTo(g.corners[0].x, g.corners[0].y);
    for (let i = 1; i < 4; i++) overlayCtx.lineTo(g.corners[i].x, g.corners[i].y);
    overlayCtx.closePath();
    overlayCtx.stroke();

    overlayCtx.beginPath();
    overlayCtx.moveTo((g.corners[0].x + g.corners[1].x) / 2, (g.corners[0].y + g.corners[1].y) / 2);
    overlayCtx.lineTo(g.rotate.x, g.rotate.y);
    overlayCtx.stroke();

    const r = 6 * sc;
    g.corners.forEach(c => {
      overlayCtx.beginPath();
      overlayCtx.rect(c.x - r, c.y - r, r * 2, r * 2);
      overlayCtx.fillStyle = '#ffffff';
      overlayCtx.fill();
      overlayCtx.lineWidth = 2 * sc;
      overlayCtx.strokeStyle = '#35a3e8';
      overlayCtx.stroke();
    });
    overlayCtx.beginPath();
    overlayCtx.arc(g.rotate.x, g.rotate.y, r * 1.1, 0, Math.PI * 2);
    overlayCtx.fillStyle = '#35a3e8';
    overlayCtx.fill();
    overlayCtx.lineWidth = 2 * sc;
    overlayCtx.strokeStyle = '#ffffff';
    overlayCtx.stroke();
    overlayCtx.restore();
  }

  function startTransformDrag(clientX, clientY) {
    if (!state.refImage) { showToast('Import a reference image first', 'error'); return; }
    if (state.refLocked) { showToast('Reference is locked', 'error'); return; }
    const hit = hitTransformHandle(clientX, clientY);
    if (!hit) return;
    const doc = screenToDoc(clientX, clientY);
    transformState.dragging = true;
    transformState.type = hit.type;
    transformState.corner = hit.corner;
    transformState.startDocX = doc.x;
    transformState.startDocY = doc.y;
    transformState.lastDocX = doc.x;
    transformState.lastDocY = doc.y;
    transformState.startScale = state.refScale;
    transformState.startRot = state.refRotation;
    transformState.startAngle = Math.atan2(doc.y - state.refY, doc.x - state.refX);
  }

  function updateTransformDrag(clientX, clientY) {
    if (!transformState.dragging) return;
    const doc = screenToDoc(clientX, clientY);
    if (transformState.type === 'move') {
      state.refX += doc.x - transformState.lastDocX;
      state.refY += doc.y - transformState.lastDocY;
      transformState.lastDocX = doc.x;
      transformState.lastDocY = doc.y;
    } else if (transformState.type === 'rotate') {
      const ang = Math.atan2(doc.y - state.refY, doc.x - state.refX);
      state.refRotation = transformState.startRot + (ang - transformState.startAngle);
    } else if (transformState.type === 'scale') {
      const d = Math.hypot(doc.x - state.refX, doc.y - state.refY);
      const d0 = Math.hypot(transformState.startDocX - state.refX, transformState.startDocY - state.refY) || 1;
      state.refScale = Math.max(0.02, Math.min(30, transformState.startScale * (d / d0)));
    }
    scheduleRender();
    renderOverlay();
  }

  function endTransformDrag() {
    transformState.dragging = false;
    transformState.type = null;
    publishReference(false);
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     LAYER TRANSFORM  (move / scale / rotate active layer)
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function copyLayerCanvas(layer) {
    const c = createOffscreenCanvas();
    c.getContext('2d').drawImage(layer.canvas, 0, 0);
    return c;
  }

  // Bounding box of non-transparent pixels (doc space). null if empty.
  function computeLayerBounds(layer) {
    const w = state.docWidth, h = state.docHeight;
    let data;
    try { data = layer.ctx.getImageData(0, 0, w, h).data; }
    catch (err) { return null; }
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      let row = y * w;
      let rowHit = false;
      for (let x = 0; x < w; x++) {
        if (data[(row + x) * 4 + 3] !== 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          rowHit = true;
        }
      }
      if (rowHit) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  function layerTransformCenter() {
    const b = layerTransform.bounds;
    return { x: b.x + b.w / 2 + layerTransform.tx, y: b.y + b.h / 2 + layerTransform.ty };
  }

  function layerTransformGeometry() {
    if (!layerTransform.active || !layerTransform.bounds) return null;
    const b = layerTransform.bounds;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const s = layerTransform.scale;
    const cos = Math.cos(layerTransform.rotation), sin = Math.sin(layerTransform.rotation);
    const tx = layerTransform.tx, ty = layerTransform.ty;
    const map = (px, py) => {
      const dx = (px - cx) * s, dy = (py - cy) * s;
      return { x: cx + tx + dx * cos - dy * sin, y: cy + ty + dx * sin + dy * cos };
    };
    const corners = [
      map(b.x, b.y), map(b.x + b.w, b.y), map(b.x + b.w, b.y + b.h), map(b.x, b.y + b.h),
    ];
    const topMid = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
    const center = map(cx, cy);
    const ox = topMid.x - center.x, oy = topMid.y - center.y;
    const ol = Math.hypot(ox, oy) || 1;
    const off = 30 / state.zoom;
    const rotate = { x: topMid.x + (ox / ol) * off, y: topMid.y + (oy / ol) * off };
    return { corners, topMid, center, rotate };
  }

  function pointInLayerBox(docX, docY) {
    const b = layerTransform.bounds;
    if (!b) return false;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const px = docX - (cx + layerTransform.tx);
    const py = docY - (cy + layerTransform.ty);
    const cos = Math.cos(layerTransform.rotation), sin = Math.sin(layerTransform.rotation);
    const s = layerTransform.scale || 1;
    const lx = (px * cos + py * sin) / s;
    const ly = (-px * sin + py * cos) / s;
    return Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2;
  }

  function hitLayerTransformHandle(clientX, clientY) {
    const g = layerTransformGeometry();
    if (!g) return null;
    for (let i = 0; i < 4; i++) {
      const sp = docToScreen(g.corners[i].x, g.corners[i].y);
      if (Math.hypot(clientX - sp.x, clientY - sp.y) <= 14) return { type: 'scale', corner: i };
    }
    const rs = docToScreen(g.rotate.x, g.rotate.y);
    if (Math.hypot(clientX - rs.x, clientY - rs.y) <= 14) return { type: 'rotate' };
    const doc = screenToDoc(clientX, clientY);
    if (pointInLayerBox(doc.x, doc.y)) return { type: 'move' };
    return null;
  }

  function beginLayerTransform() {
    const layer = getActiveLayer();
    if (!layer) return;
    if (layerTransform.active && layerTransform.layerId === layer.id) return;
    if (layerTransform.active) endLayerTransform(true);
    if (nodeLocked(layer.id)) { showToast('Layer is locked', 'error'); return; }
    const bounds = computeLayerBounds(layer);
    if (!bounds) { showToast('Nothing to move on this layer', 'error'); return; }
    layerTransform.active = true;
    layerTransform.layerId = layer.id;
    layerTransform.snapshot = copyLayerCanvas(layer);
    layerTransform.bounds = bounds;
    layerTransform.tx = 0; layerTransform.ty = 0;
    layerTransform.scale = 1; layerTransform.rotation = 0;
    layerTransform.dragging = false; layerTransform.type = null; layerTransform.corner = -1;
    layerTransform.undoPushed = false;
    syncLayerTransformUI();
  }

  function applyLayerTransformToLayer() {
    if (!layerTransform.active || !layerTransform.snapshot) return;
    const layer = findNode(layerTransform.layerId);
    if (!layer) return;
    if (!layerTransform.undoPushed) { pushUndo(layer); layerTransform.undoPushed = true; }
    const b = layerTransform.bounds;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const ctx = layer.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, state.docWidth, state.docHeight);
    ctx.save();
    ctx.translate(cx + layerTransform.tx, cy + layerTransform.ty);
    ctx.rotate(layerTransform.rotation);
    ctx.scale(layerTransform.scale, layerTransform.scale);
    ctx.translate(-cx, -cy);
    ctx.drawImage(layerTransform.snapshot, 0, 0);
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    scheduleRender();
  }

  function scheduleLayerTransformRender() {
    if (layerTransformRAF) return;
    layerTransformRAF = requestAnimationFrame(() => {
      layerTransformRAF = 0;
      applyLayerTransformToLayer();
    });
  }

  function endLayerTransform(commit) {
    if (!layerTransform.active) return;
    if (layerTransformRAF) { cancelAnimationFrame(layerTransformRAF); layerTransformRAF = 0; }
    const layer = findNode(layerTransform.layerId);
    const snap = layerTransform.snapshot;
    if (layer && !commit && snap) {
      layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
      layer.ctx.clearRect(0, 0, state.docWidth, state.docHeight);
      layer.ctx.drawImage(snap, 0, 0);
      if (layerTransform.undoPushed && state.undoStack.length &&
        state.undoStack[state.undoStack.length - 1].layerId === layer.id) {
        state.undoStack.pop();
        updateHistoryButtons();
      }
      // The layer went back to its pre-drag pixels â€” tell the peers the same.
      if (layerTransform.undoPushed) sendRestore(layer, null, snap);
    }
    if (layer && (commit || layerTransform.undoPushed)) {
      updateLayerThumbnail(layer.id);
      if (commit) sendRestore(layer, null, layer.canvas);
    }
    layerTransform.active = false;
    layerTransform.dragging = false;
    layerTransform.type = null;
    layerTransform.snapshot = null;
    layerTransform.bounds = null;
    layerTransform.layerId = null;
    layerTransform.undoPushed = false;
    scheduleRender();
    renderOverlay();
  }

  function resetLayerTransform() {
    if (!layerTransform.active) return;
    layerTransform.tx = 0; layerTransform.ty = 0;
    layerTransform.scale = 1; layerTransform.rotation = 0;
    if (layerTransform.undoPushed) applyLayerTransformToLayer();
    syncLayerTransformUI();
    renderOverlay();
  }

  function startLayerTransformDrag(clientX, clientY) {
    if (!layerTransform.active) beginLayerTransform();
    if (!layerTransform.active) return;
    const hit = hitLayerTransformHandle(clientX, clientY);
    if (!hit) return;
    const doc = screenToDoc(clientX, clientY);
    layerTransform.dragging = true;
    layerTransform.type = hit.type;
    layerTransform.corner = (hit.corner != null ? hit.corner : -1);
    layerTransform.startDocX = doc.x; layerTransform.startDocY = doc.y;
    layerTransform.lastDocX = doc.x; layerTransform.lastDocY = doc.y;
    layerTransform.startScale = layerTransform.scale;
    layerTransform.startRotation = layerTransform.rotation;
    const ctr = layerTransformCenter();
    layerTransform.startAngle = Math.atan2(doc.y - ctr.y, doc.x - ctr.x);
  }

  function updateLayerTransformDrag(clientX, clientY) {
    if (!layerTransform.active || !layerTransform.dragging) return;
    const doc = screenToDoc(clientX, clientY);
    if (layerTransform.type === 'move') {
      layerTransform.tx += doc.x - layerTransform.lastDocX;
      layerTransform.ty += doc.y - layerTransform.lastDocY;
      layerTransform.lastDocX = doc.x;
      layerTransform.lastDocY = doc.y;
    } else if (layerTransform.type === 'rotate') {
      const ctr = layerTransformCenter();
      const ang = Math.atan2(doc.y - ctr.y, doc.x - ctr.x);
      layerTransform.rotation = layerTransform.startRotation + (ang - layerTransform.startAngle);
    } else if (layerTransform.type === 'scale') {
      const ctr = layerTransformCenter();
      const d = Math.hypot(doc.x - ctr.x, doc.y - ctr.y);
      const d0 = Math.hypot(layerTransform.startDocX - ctr.x, layerTransform.startDocY - ctr.y) || 1;
      layerTransform.scale = Math.max(0.05, Math.min(20, layerTransform.startScale * (d / d0)));
    }
    scheduleLayerTransformRender();
    syncLayerTransformUI();
    renderOverlay();
  }

  function endLayerTransformDrag() {
    if (!layerTransform.dragging) return;
    layerTransform.dragging = false;
    layerTransform.type = null;
    applyLayerTransformToLayer();
  }

  function cancelLayerTransformEdit() {
    endLayerTransform(false);
    beginLayerTransform();
    updateCanvasHint();
    renderOverlay();
  }

  function applyLayerTransformEdit() {
    endLayerTransform(true);
    beginLayerTransform();
    updateCanvasHint();
    renderOverlay();
  }

  function drawLayerTransformOverlay() {
    if (!overlayCtx || !layerTransform.active) return;
    const g = layerTransformGeometry();
    if (!g) return;
    const sc = 1 / state.zoom;
    overlayCtx.save();
    overlayCtx.strokeStyle = 'rgba(53,163,232,0.95)';
    overlayCtx.lineWidth = 1.6 * sc;
    overlayCtx.beginPath();
    overlayCtx.moveTo(g.corners[0].x, g.corners[0].y);
    for (let i = 1; i < 4; i++) overlayCtx.lineTo(g.corners[i].x, g.corners[i].y);
    overlayCtx.closePath();
    overlayCtx.stroke();

    overlayCtx.beginPath();
    overlayCtx.moveTo(g.topMid.x, g.topMid.y);
    overlayCtx.lineTo(g.rotate.x, g.rotate.y);
    overlayCtx.stroke();

    const r = 6 * sc;
    g.corners.forEach(c => {
      overlayCtx.beginPath();
      overlayCtx.rect(c.x - r, c.y - r, r * 2, r * 2);
      overlayCtx.fillStyle = '#ffffff';
      overlayCtx.fill();
      overlayCtx.lineWidth = 2 * sc;
      overlayCtx.strokeStyle = '#35a3e8';
      overlayCtx.stroke();
    });
    overlayCtx.beginPath();
    overlayCtx.arc(g.rotate.x, g.rotate.y, r * 1.1, 0, Math.PI * 2);
    overlayCtx.fillStyle = '#35a3e8';
    overlayCtx.fill();
    overlayCtx.lineWidth = 2 * sc;
    overlayCtx.strokeStyle = '#ffffff';
    overlayCtx.stroke();
    overlayCtx.restore();
  }

  function syncLayerTransformUI() {
    const scaleEl = $('#layerScale');
    if (scaleEl) {
      const pct = Math.round(layerTransform.scale * 100);
      if (scaleEl.value !== String(pct)) scaleEl.value = pct;
      const v = $('#layerScaleVal'); if (v) v.textContent = pct + '%';
    }
    const rotEl = $('#layerRotation');
    if (rotEl) {
      let deg = Math.round(layerTransform.rotation * 180 / Math.PI);
      deg = Math.max(-180, Math.min(180, deg));
      if (rotEl.value !== String(deg)) rotEl.value = deg;
      const v = $('#layerRotationVal'); if (v) v.innerHTML = deg + '&deg;';
    }
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     SELECTION (rectangular marquee)
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function normalizeSelection() {
    const x1 = Math.min(selectState.startX, selectState.x);
    const y1 = Math.min(selectState.startY, selectState.y);
    const x2 = Math.max(selectState.startX, selectState.x);
    const y2 = Math.max(selectState.startY, selectState.y);
    selectState.x = x1; selectState.y = y1;
    selectState.w = x2 - x1; selectState.h = y2 - y1;
  }

  function clearSelection() {
    selectState.active = false;
    selectState.isSelecting = false;
    selectState.kind = 'rect';
    selectState.maskCanvas = null;
    selectState.maskEdgeCanvas = null;
    selectState.pixelCount = 0;
    stopSelectionAnimation();
    updateSelectStatus();
    updateWandStatus();
    renderOverlay();
  }

  function updateSelectStatus() {
    const el = $('#selectStatusText');
    if (!el) return;
    if (!selectState.active) { el.textContent = 'No selection'; return; }
    if (selectState.kind === 'wand') {
      el.textContent = selectState.pixelCount.toLocaleString() + ' px (colour)';
    } else {
      el.textContent = `${Math.round(selectState.w)} Ã— ${Math.round(selectState.h)} px selected`;
    }
  }

  function drawSelectPreview() {
    if (!overlayCtx) return;
    const sc = 1 / state.zoom;
    overlayCtx.save();
    overlayCtx.setLineDash([4 * sc, 4 * sc]);
    overlayCtx.strokeStyle = 'rgba(53,163,232,0.9)';
    overlayCtx.lineWidth = 1.5 * sc;
    overlayCtx.strokeRect(selectState.x, selectState.y, selectState.w, selectState.h);
    overlayCtx.restore();
  }

  function drawSelectionAnts() {
    if (!overlayCtx || !selectState.active) return;
    const sc = 1 / state.zoom;
    overlayCtx.save();
    overlayCtx.lineWidth = 1.5 * sc;
    overlayCtx.setLineDash([6 * sc, 6 * sc]);
    overlayCtx.lineDashOffset = selectState.antOffset * sc;
    overlayCtx.strokeStyle = '#ffffff';
    overlayCtx.strokeRect(selectState.x, selectState.y, selectState.w, selectState.h);
    overlayCtx.lineDashOffset = (selectState.antOffset + 6) * sc;
    overlayCtx.strokeStyle = '#000000';
    overlayCtx.strokeRect(selectState.x, selectState.y, selectState.w, selectState.h);
    overlayCtx.restore();
  }

  function startSelectionAnimation() {
    if (selectState.animId) return;
    const tick = () => {
      selectState.antOffset = (selectState.antOffset + 0.4) % 12;
      renderOverlay();
      selectState.animId = requestAnimationFrame(tick);
    };
    selectState.animId = requestAnimationFrame(tick);
  }

  function stopSelectionAnimation() {
    if (selectState.animId) { cancelAnimationFrame(selectState.animId); selectState.animId = null; }
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     RECORDING  (reference image is NEVER recorded)
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function startRecording() {
    if (state.isRecording) return;

    recordingCanvas.width = state.docWidth;
    recordingCanvas.height = state.docHeight;

    const stream = recordingCanvas.captureStream(30);
    const mimeTypes = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
    let mimeType = '';
    for (const mt of mimeTypes) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(mt)) { mimeType = mt; break; }
    }
    if (!mimeType) { showToast('Recording not supported in this browser', 'error'); return; }

    state.recordedChunks = [];
    state.mediaRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5000000 });

    state.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) state.recordedChunks.push(e.data);
    };
    state.mediaRecorder.onstop = () => { exportRecording(); };

    state.mediaRecorder.start(100);
    state.isRecording = true;

    function renderRecFrame() {
      if (!state.isRecording) return;
      compositeDrawingOnly(recordingCtx);
      state.recAnimFrame = requestAnimationFrame(renderRecFrame);
    }
    renderRecFrame();

    $('#btnStartRecord').classList.add('hidden');
    $('#btnStopRecord').classList.remove('hidden');
    $('#recordingIndicator').classList.remove('hidden');
    showToast('Recording started â€” reference image is excluded', 'success');
  }

  function stopRecording() {
    if (!state.isRecording) return;
    state.isRecording = false;
    if (state.recAnimFrame) cancelAnimationFrame(state.recAnimFrame);
    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
      state.mediaRecorder.stop();
    }
    $('#btnStartRecord').classList.remove('hidden');
    $('#btnStopRecord').classList.add('hidden');
    $('#recordingIndicator').classList.add('hidden');
  }

  function exportRecording() {
    if (!state.recordedChunks.length) { showToast('No recording data', 'error'); return; }
    const blob = new Blob(state.recordedChunks, { type: state.recordedChunks[0].type || 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `artee-recording-${Date.now()}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast('Recording saved!', 'success');
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     EXPORT PNG  (drawing only â€” no reference)
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function exportPNG() {
    const exportCanvas = createOffscreenCanvas();
    const ectx = exportCanvas.getContext('2d');
    compositeDrawingOnly(ectx);

    exportCanvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `artee-drawing-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      showToast('PNG exported (drawing only, no reference)', 'success');
    }, 'image/png');
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     UI â€” LAYER LIST
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  // Flattened order of the currently visible rows (respecting collapsed
  // folders) â€” used for shift-click range selection.
  let uiOrder = [];

  function updateLayerList() {
    const list = $('#layerList');
    if (!list) return;
    list.innerHTML = '';

    if (state.refImage) {
      list.appendChild(createRefLayerItem());
      const sep = document.createElement('div');
      sep.style.cssText = 'height:1px;background:var(--border);margin:3px 0;';
      list.appendChild(sep);
    }

    uiOrder = [];
    (function walk(nodes, depth) {
      for (const node of nodes) {
        list.appendChild(createLayerItem(node, depth));
        uiOrder.push(node.id);
        if (isGroupNode(node) && node.expanded) walk(node.children, depth + 1);
      }
    })(state.layers, 0);

    updateActiveLayerOpacitySlider();
  }

  function createRefLayerItem() {
    const item = document.createElement('div');
    item.className = 'layer-item reference' + (state.refVisible ? '' : ' hidden-ref');
    item.innerHTML =
      '<span class="layer-caret-spacer"></span>' +
      '<div class="layer-thumb" style="background:var(--bg-raised);"><canvas width="48" height="32"></canvas></div>' +
      '<span class="layer-name" style="color:var(--purple);">Reference Image</span>' +
      '<div class="layer-icons">' +
      '<button class="layer-icon-btn ' + (state.refVisible ? 'on' : '') + '" data-action="toggle-ref" title="Visibility">' +
      '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" fill="currentColor"/></svg>' +
      '</button>' +
      '<button class="layer-icon-btn ' + (state.refLocked ? 'locked' : '') + '" data-action="toggle-ref-lock" title="Lock reference">' +
      '<svg viewBox="0 0 24 24" width="14" height="14"><path d="' + (state.refLocked
        ? 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z'
        : 'M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z'
      ) + '" fill="currentColor"/></svg>' +
      '</button>' +
      '</div>';

    const thumbCanvas = item.querySelector('canvas');
    if (state.refImage) thumbCanvas.getContext('2d').drawImage(state.refImage, 0, 0, 48, 32);

    item.querySelector('[data-action="toggle-ref"]').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleReference();
    });
    item.querySelector('[data-action="toggle-ref-lock"]').addEventListener('click', (e) => {
      e.stopPropagation();
      state.refLocked = !state.refLocked;
      const chk = $('#checkRefLocked');
      if (chk) chk.checked = state.refLocked;
      updateLayerList();
      renderOverlay();
      publishReference(false);
      showToast(state.refLocked ? 'Reference locked' : 'Reference unlocked');
    });
    return item;
  }

  const EYE_SVG = {
    on: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" fill="currentColor"/></svg>',
    off: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46A11.804 11.804 0 001 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z" fill="currentColor"/></svg>',
  };
  const LOCK_SVG = {
    on: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z" fill="currentColor"/></svg>',
    off: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z" fill="currentColor"/></svg>',
  };
  const KEBAB_SVG = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" fill="currentColor"/></svg>';
  const CARET_SVG = '<svg viewBox="0 0 24 24" width="12" height="12"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z" fill="currentColor"/></svg>';
  const FOLDER_SVG = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" fill="currentColor"/></svg>';

  function createLayerItem(node, depth) {
    const item = document.createElement('div');
    const group = isGroupNode(node);
    const isActive = node.id === state.activeLayerId;
    const isSelected = state.selectedNodeIds.has(node.id);
    let cls = 'layer-item';
    if (group) cls += ' group';
    if (isActive) cls += ' active';
    if (isSelected && !isActive) cls += ' selected';
    if (node.visible === false) cls += ' layer-hidden';
    item.className = cls;
    item.dataset.layerId = node.id;
    item.dataset.nodeType = group ? 'group' : 'layer';
    item.style.paddingLeft = (7 + depth * 14) + 'px';

    const caret = group
      ? '<button class="layer-caret' + (node.expanded ? '' : ' collapsed') + '" data-action="toggle-expand" title="Expand / Collapse">' + CARET_SVG + '</button>'
      : '<span class="layer-caret-spacer"></span>';
    const thumb = group
      ? '<div class="layer-thumb folder">' + FOLDER_SVG + '</div>'
      : '<div class="layer-thumb"><canvas width="48" height="32"></canvas></div>';

    item.innerHTML =
      caret + thumb +
      '<span class="layer-name">' + escapeHtml(node.name) + '</span>' +
      '<div class="layer-icons">' +
      '<button class="layer-icon-btn ' + (node.visible ? 'on' : '') + '" data-action="toggle-vis" title="Show / Hide">' + (node.visible ? EYE_SVG.on : EYE_SVG.off) + '</button>' +
      '<button class="layer-icon-btn ' + (node.locked ? 'locked' : '') + '" data-action="toggle-lock" title="Lock / Unlock">' + (node.locked ? LOCK_SVG.on : LOCK_SVG.off) + '</button>' +
      '<button class="layer-icon-btn" data-action="menu" title="More options">' + KEBAB_SVG + '</button>' +
      '</div>';

    if (!group) drawLayerThumbnail(item.querySelector('.layer-thumb canvas'), node);

    item.addEventListener('click', (e) => {
      if (e.target.closest('.layer-icon-btn') || e.target.closest('.layer-caret')) return;
      const additive = e.ctrlKey || e.metaKey;
      const range = e.shiftKey;
      if (additive) {
        if (state.selectedNodeIds.has(node.id) && state.selectedNodeIds.size > 1) {
          state.selectedNodeIds.delete(node.id);
          if (state.activeLayerId === node.id) {
            state.activeLayerId = Array.from(state.selectedNodeIds)[state.selectedNodeIds.size - 1];
          }
        } else {
          state.selectedNodeIds.add(node.id);
          state.activeLayerId = node.id;
        }
      } else if (range && uiOrder.indexOf(state.activeLayerId) !== -1) {
        const a = uiOrder.indexOf(state.activeLayerId);
        const b = uiOrder.indexOf(node.id);
        const lo = Math.min(a, b), hi = Math.max(a, b);
        state.selectedNodeIds = new Set(uiOrder.slice(lo, hi + 1));
        state.activeLayerId = node.id;
      } else {
        state.selectedNodeIds = new Set([node.id]);
        state.activeLayerId = node.id;
      }
      updateLayerList();
      if (state.tool === 'layer-transform') { beginLayerTransform(); if (typeof updateCanvasHint === 'function') updateCanvasHint(); }
      renderOverlay();
    });

    const nameEl = item.querySelector('.layer-name');
    nameEl.addEventListener('dblclick', (e) => { e.stopPropagation(); startRenameLayer(item, node); });

    item.querySelector('[data-action="toggle-expand"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleNodeExpanded(node.id);
    });
    item.querySelector('[data-action="toggle-vis"]').addEventListener('click', (e) => {
      e.stopPropagation();
      setNodeVisible(node.id, !node.visible);
    });
    item.querySelector('[data-action="toggle-lock"]').addEventListener('click', (e) => {
      e.stopPropagation();
      setNodeLocked(node.id, !node.locked);
    });
    item.querySelector('[data-action="menu"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      openLayerContextMenu(r.left, r.bottom + 2, node.id);
    });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openLayerContextMenu(e.clientX, e.clientY, node.id);
    });
    item.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.layer-icon-btn') || e.target.closest('.layer-caret') || e.target.closest('input')) return;
      startLayerDrag(e, node.id);
    });

    return item;
  }

  function startRenameLayer(item, node) {
    const nameEl = item.querySelector('.layer-name');
    if (!nameEl) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'layer-name-input';
    input.value = node.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (commit) renameNode(node.id, input.value);
      else updateLayerList();
    };
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
  }

  function revealNode(id) {
    let loc = findParentOf(id);
    while (loc && loc.parent) { loc.parent.expanded = true; loc = findParentOf(loc.parent.id); }
  }

  function startRenameById(id) {
    revealNode(id);
    updateLayerList();
    const item = document.querySelector('.layer-item[data-layer-id="' + id + '"]');
    const node = findNode(id);
    if (item && node) startRenameLayer(item, node);
  }

  function drawLayerThumbnail(thumbCanvas, layer) {
    if (!thumbCanvas || !layer || isGroupNode(layer)) return;
    const tc = thumbCanvas.getContext('2d');
    tc.clearRect(0, 0, 48, 32);
    tc.fillStyle = '#ffffff';
    tc.fillRect(0, 0, 48, 32);
    tc.drawImage(layer.canvas, 0, 0, 48, 32);
  }

  function updateLayerThumbnail(nodeId) {
    markLayerDirty(nodeId);
    const node = findNode(nodeId);
    if (!node || isGroupNode(node)) return;
    const item = $('.layer-item[data-layer-id="' + nodeId + '"]');
    if (!item) return;
    const tc = item.querySelector('.layer-thumb canvas');
    if (tc) drawLayerThumbnail(tc, node);
  }

  function updateActiveLayerOpacitySlider() {
    const node = getActiveNode();
    const slider = $('#activeLayerOpacity');
    if (!slider) return;
    const val = node ? Math.round(node.opacity * 100) : 100;
    slider.value = val;
    setNumVal($('#activeLayerOpacityVal'), val);
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     UI â€” LAYER DRAG & DROP REORDER
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  let layerDragState = null;

  function startLayerDrag(e, id) {
    layerDragState = { id, startX: e.clientX, startY: e.clientY, active: false, drop: null };
    window.addEventListener('pointermove', onLayerDragMove);
    window.addEventListener('pointerup', onLayerDragUp);
    window.addEventListener('pointercancel', onLayerDragUp);
  }

  function onLayerDragMove(e) {
    const d = layerDragState;
    if (!d) return;
    if (!d.active) {
      if (Math.abs(e.clientX - d.startX) < 5 && Math.abs(e.clientY - d.startY) < 5) return;
      d.active = true;
      document.body.classList.add('layer-dragging');
      const src = document.querySelector('.layer-item[data-layer-id="' + d.id + '"]');
      if (src) src.classList.add('dragging');
    }
    e.preventDefault();
    updateLayerDropIndicator(e.clientX, e.clientY);
  }

  function updateLayerDropIndicator(x, y) {
    const d = layerDragState;
    if (!d) return;
    clearLayerDropClasses();
    const el = document.elementFromPoint(x, y);
    const item = el && el.closest ? el.closest('.layer-item') : null;
    if (!item || !item.dataset.layerId) { d.drop = null; return; }
    const targetId = parseInt(item.dataset.layerId, 10);
    if (targetId === d.id || isDescendantOf(targetId, d.id)) { d.drop = null; return; }
    const rect = item.getBoundingClientRect();
    const rel = (y - rect.top) / rect.height;
    const isFolder = item.dataset.nodeType === 'group';
    let position;
    if (isFolder && rel > 0.28 && rel < 0.72) position = 'inside';
    else position = rel < 0.5 ? 'before' : 'after';
    item.classList.add('drop-' + position);
    d.drop = { targetId, position };
  }

  function clearLayerDropClasses() {
    document.querySelectorAll('.layer-item.drop-before, .layer-item.drop-after, .layer-item.drop-inside')
      .forEach(el => el.classList.remove('drop-before', 'drop-after', 'drop-inside'));
  }

  function clearLayerDrag() {
    document.body.classList.remove('layer-dragging');
    document.querySelectorAll('.layer-item.dragging').forEach(el => el.classList.remove('dragging'));
    clearLayerDropClasses();
  }

  function onLayerDragUp() {
    window.removeEventListener('pointermove', onLayerDragMove);
    window.removeEventListener('pointerup', onLayerDragUp);
    window.removeEventListener('pointercancel', onLayerDragUp);
    const d = layerDragState;
    layerDragState = null;
    clearLayerDrag();
    if (d && d.active && d.drop) reorderNode(d.id, d.drop.targetId, d.drop.position);
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     UI â€” LAYER CONTEXT MENU
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  let layerMenuEl = null;

  function nodeDepth(id) {
    let depth = 0;
    let loc = findParentOf(id);
    while (loc && loc.parent) { depth++; loc = findParentOf(loc.parent.id); }
    return depth;
  }

  function deleteSelectionOr(id) {
    let ids = (state.selectedNodeIds.size > 1 && state.selectedNodeIds.has(id))
      ? Array.from(state.selectedNodeIds)
      : [id];
    ids.sort((a, b) => nodeDepth(b) - nodeDepth(a)); // deepest first
    for (const i of ids) if (findNode(i)) deleteNode(i);
    state.selectedNodeIds = new Set(state.activeLayerId != null ? [state.activeLayerId] : []);
  }

  function groupSelectedLayers() {
    const ids = Array.from(state.selectedNodeIds).filter(id => findNode(id));
    if (!ids.length) { showToast('Nothing selected', 'error'); return; }
    const locs = ids.map(id => findParentOf(id));
    if (!locs.every(l => l && l.arr === locs[0].arr)) { showToast('Selected items must share the same folder', 'error'); return; }
    const arr = locs[0].arr;
    const entries = locs.map((l, i) => ({ id: ids[i], index: l.index })).sort((a, b) => a.index - b.index);
    const insertAt = entries[0].index;
    const nodes = [];
    const desc = entries.slice().sort((a, b) => b.index - a.index);
    for (const e of desc) { nodes.unshift(arr[e.index]); arr.splice(e.index, 1); }
    const group = {
      id: state.nextLayerId++,
      type: 'group',
      name: 'Folder',
      visible: true, locked: false, opacity: 1, expanded: true,
      children: nodes,
    };
    arr.splice(Math.min(insertAt, arr.length), 0, group);
    state.activeLayerId = group.id;
    state.selectedNodeIds = new Set([group.id]);
    updateLayerList();
    scheduleRender();
    queueSave();
    showToast('Grouped ' + nodes.length + ' item' + (nodes.length > 1 ? 's' : ''));
  }

  function closeLayerMenu() {
    if (!layerMenuEl) return;
    layerMenuEl.remove();
    layerMenuEl = null;
    document.removeEventListener('mousedown', onDocDownCloseMenu, true);
    document.removeEventListener('keydown', onDocKeyCloseMenu, true);
    window.removeEventListener('resize', closeLayerMenu);
    window.removeEventListener('blur', closeLayerMenu);
    const ll = $('#layerList'); if (ll) ll.removeEventListener('scroll', closeLayerMenu);
  }

  function onDocDownCloseMenu(e) {
    if (layerMenuEl && !layerMenuEl.contains(e.target)) closeLayerMenu();
  }

  function onDocKeyCloseMenu(e) { if (e.key === 'Escape') closeLayerMenu(); }

  function showLayerMenu(items, x, y) {
    closeLayerMenu();
    const menu = document.createElement('div');
    menu.className = 'layer-menu';
    items.forEach(it => {
      if (it.sep) { const s = document.createElement('div'); s.className = 'layer-menu-sep'; menu.appendChild(s); return; }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'layer-menu-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
      b.textContent = it.label;
      if (it.disabled) b.disabled = true;
      else b.addEventListener('click', () => { closeLayerMenu(); it.action(); });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let px = x, py = y;
    if (px + r.width > vw - 6) px = vw - r.width - 6;
    if (py + r.height > vh - 6) py = vh - r.height - 6;
    menu.style.left = Math.max(6, px) + 'px';
    menu.style.top = Math.max(6, py) + 'px';
    layerMenuEl = menu;
    setTimeout(() => {
      document.addEventListener('mousedown', onDocDownCloseMenu, true);
      document.addEventListener('keydown', onDocKeyCloseMenu, true);
      window.addEventListener('resize', closeLayerMenu);
      window.addEventListener('blur', closeLayerMenu);
      const ll = $('#layerList'); if (ll) ll.addEventListener('scroll', closeLayerMenu, { passive: true });
    }, 0);
  }

  function openLayerContextMenu(x, y, nodeId) {
    const node = findNode(nodeId);
    if (!node) return;
    if (!state.selectedNodeIds.has(nodeId)) {
      state.selectedNodeIds = new Set([nodeId]);
      state.activeLayerId = nodeId;
      updateLayerList();
    }
    const group = isGroupNode(node);
    const loc = findParentOf(nodeId);
    const inFolder = !!(loc && loc.parent);
    const selCount = Array.from(state.selectedNodeIds).filter(id => findNode(id)).length;

    showLayerMenu([
      { label: 'Rename', action: () => startRenameById(nodeId) },
      { label: 'Duplicate', action: () => duplicateNode(nodeId) },
      { label: 'Delete', danger: true, action: () => deleteSelectionOr(nodeId) },
      { sep: true },
      { label: 'Merge Down', disabled: group, action: () => mergeDown(nodeId) },
      { label: 'Merge Selected', disabled: selCount < 2, action: mergeSelectedLayers },
      { label: 'Clear', action: () => clearNode(nodeId) },
      { sep: true },
      { label: 'Move Up', action: () => moveNode(nodeId, -1) },
      { label: 'Move Down', action: () => moveNode(nodeId, 1) },
      {
        label: inFolder ? 'Move Out of Folder' : 'Group into New Folder',
        action: inFolder ? () => moveNodeIntoGroup(nodeId, null) : groupSelectedLayers
      },
      { sep: true },
      { label: node.locked ? 'Unlock' : 'Lock', action: () => setNodeLocked(nodeId, !node.locked) },
      { label: node.visible ? 'Hide' : 'Show', action: () => setNodeVisible(nodeId, !node.visible) },
      { sep: true },
      { label: 'New Layer', action: () => createLayer(undefined, inFolder ? findParentOf(nodeId).parent : null) },
      { label: 'New Folder', action: () => createGroup(undefined, inFolder ? findParentOf(nodeId).parent : (group ? node : null)) },
    ], x, y);
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     UI â€” COLOR
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function createColorPresets() {
    const container = $('#colorPresets');
    if (!container) return;
    PRESET_COLORS.forEach(color => {
      const btn = document.createElement('button');
      btn.className = 'color-preset';
      btn.style.background = color;
      btn.title = color.toUpperCase();
      btn.addEventListener('click', () => setColor(color));
      container.appendChild(btn);
    });
  }

  function setColor(hex) {
    state.brushColor = hex;
    $('#colorPicker').value = hex;
    $('#colorHex').value = hex.toUpperCase();
    $('#colorSwatch').style.background = hex;
    updateBrushPreview();
    drawFadePreview();
    drawBrushTipPreview();
    if (state.tool === 'curve') renderOverlay();
    queueSave();
  }

  function updateBrushPreview() {
    const fill = $('.brush-preview-fill');
    if (!fill) return;
    fill.style.background = state.tool === 'eraser'
      ? 'repeating-linear-gradient(45deg,#fff 0 6px,#dcdcdc 6px 12px)'
      : state.brushColor;
  }

  // â”€â”€â”€ Force Fade UI â”€â”€â”€

  function syncFadeUI() {
    const cfg = getFadeSettings();
    const chk = $('#checkFadeEnds');
    if (chk) chk.checked = !!cfg.enabled;
    FADE_SLIDERS.forEach(([sel, key, valSel]) => {
      const el = $(sel);
      if (el) el.value = cfg[key];
      setNumVal($(valSel), cfg[key]);
    });
    drawFadePreview();
  }

  function drawFadePreview() {
    const cv = $('#fadePreviewCanvas');
    if (!cv) return;
    const cssW = cv.clientWidth;
    if (!cssW) return;
    const cssH = 64;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    // Checkerboard so both light and dark sample colors stay visible.
    const sq = 8;
    for (let y = 0; y < cssH; y += sq) {
      for (let x = 0; x < cssW; x += sq) {
        ctx.fillStyle = ((((x / sq) | 0) + ((y / sq) | 0)) % 2) ? '#6f6f6f' : '#8c8c8c';
        ctx.fillRect(x, y, sq, sq);
      }
    }
    const cfg = getFadeSettings();
    if (!cfg.enabled) return;
    const pad = 16;
    const N = 64;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      pts.push({
        x: pad + t * (cssW - pad * 2),
        y: cssH / 2 + Math.sin(t * Math.PI * 1.15) * (cssH * 0.20),
      });
    }
    const baseSize = Math.min(26, Math.max(10, Math.round(cssH * 0.42)));
    const baseA = state.tool === 'eraser' ? 1 : state.brushOpacity;
    paintFadeStroke(ctx, pts, cfg, baseSize, baseA, state.brushColor, false);
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     UI â€” ACCORDIONS & DROPDOWNS
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function closeDropdowns() {
    $$('#panelRight .select-menu').forEach((m) => m.classList.add('hidden'));
    $$('#panelRight .select-dropdown').forEach((d) => d.classList.remove('open'));
  }

  // Wires up the right-panel accordion sections (state persisted to
  // localStorage) and the compact Brush Type / Filters dropdowns.
  function initAccordions() {
    const KEY = 'artee.acc';
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { saved = {}; }

    $$('#panelRight .collapsible > .collapsible-head').forEach((head) => {
      const sec = head.parentElement;
      const key = sec.dataset.acc;
      if (key && saved[key]) sec.classList.add('collapsed');
      head.addEventListener('click', (e) => {
        if (e.target.closest('.layer-btns')) return;
        sec.classList.toggle('collapsed');
        if (key) {
          saved[key] = sec.classList.contains('collapsed');
          try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (err) { }
        }
      });
    });

    const wire = (btnSel, menuSel, wrapSel) => {
      const btn = $(btnSel), menu = $(menuSel), wrap = $(wrapSel);
      if (!btn || !menu) return;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = !menu.classList.contains('hidden');
        closeDropdowns();
        if (!isOpen) {
          menu.classList.remove('hidden');
          if (wrap) wrap.classList.add('open');
        }
      });
    };
    wire('#brushTypeBtn', '#brushTypeGrid', '#brushTypeDropdown');
    wire('#filterMenuBtn', '#filterGrid', '#filterDropdown');

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.select-dropdown')) closeDropdowns();
    });
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     UI â€” BRUSH TYPE
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function buildBrushTypeGrid() {
    const grid = $('#brushTypeGrid');
    if (!grid) return;
    grid.innerHTML = '';
    Object.keys(BRUSH_TYPES).forEach((id) => {
      const def = BRUSH_TYPES[id];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'brush-type-btn';
      btn.dataset.brush = id;
      btn.textContent = def.name;
      btn.title = def.hint;
      btn.addEventListener('click', () => { setBrushType(id); closeDropdowns(); });
      grid.appendChild(btn);
    });
  }

  function buildTextureChips() {
    const box = $('#brushTextureChips');
    if (!box) return;
    box.innerHTML = '';
    TEXTURE_OPTIONS.forEach(([id, label]) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.texture = id;
      chip.textContent = label;
      chip.addEventListener('click', () => {
        getBrushState().texture = id;
        syncBrushTypeUI();
        drawBrushTipPreview();
        queueSave();
      });
      box.appendChild(chip);
    });
  }

  function setBrushType(id) {
    if (!BRUSH_TYPES[id] || state.brushType === id) return;
    state.brushType = id;
    getBrushState();
    syncBrushTypeUI();
    drawBrushTipPreview();
    queueSave();
  }

  // Shows/hides the brush-specific controls relevant to the active brush.
  function syncBrushTypeUI() {
    const cfg = getBrushTypeCfg();
    const bs = getBrushState();
    const fields = cfg.fields || [];
    const has = (f) => fields.indexOf(f) >= 0;

    $$('#brushTypeGrid .brush-type-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.brush === state.brushType);
    });

    const cur = $('#brushTypeCurrent');
    if (cur) cur.textContent = cfg.name;

    const hint = $('#brushTypeHint');
    if (hint) hint.textContent = cfg.hint;

    const rowMap = {
      hardness: '#hardnessRow', spacing: '#spacingRow',
      flow: '#flowRow', scatter: '#scatterRow', texture: '#textureRow',
    };
    Object.keys(rowMap).forEach((f) => {
      const el = $(rowMap[f]);
      if (el) el.classList.toggle('hidden', !has(f));
    });

    const syncRange = (sel, numSel, val) => {
      const r = $(sel);
      if (!r) return;
      r.value = val;
      setNumVal($(numSel), val);
    };
    syncRange('#brushHardness', '#brushHardnessVal', Math.round(bs.hardness * 100));
    syncRange('#brushSpacing', '#brushSpacingVal', Math.round(bs.spacing * 100));
    syncRange('#brushFlow', '#brushFlowVal', Math.round(bs.flow * 100));
    syncRange('#brushScatter', '#brushScatterVal', Math.round(bs.scatter * 100));

    $$('#brushTextureChips .chip').forEach((c) => {
      c.classList.toggle('active', c.dataset.texture === bs.texture);
    });
  }

  function brushUIView() {
    const on = state.tool === 'brush' || state.tool === 'eraser';
    ['#brushPropsGroup', '#forceFadeGroup'].forEach((s) => {
      const el = $(s);
      if (el) el.classList.toggle('hidden', !on);
    });
    return on;
  }

  let brushPreviewBuf = null;

  // Draws a small live sample stroke of the current brush into the preview canvas.
  function drawBrushTipPreview() {
    const cv = $('#brushTipPreview');
    if (!cv || !brushUIView()) return;
    const cssW = cv.clientWidth || 200;
    const cssH = 56;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const sq = 8;
    for (let y = 0; y < cssH; y += sq) {
      for (let x = 0; x < cssW; x += sq) {
        ctx.fillStyle = ((((x / sq) | 0) + ((y / sq) | 0)) % 2) ? '#6f6f6f' : '#8c8c8c';
        ctx.fillRect(x, y, sq, sq);
      }
    }

    const pad = 14;
    const N = 90;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      pts.push({
        x: pad + t * (cssW - pad * 2),
        y: cssH / 2 + Math.sin(t * Math.PI * 1.15) * (cssH * 0.22),
      });
    }

    const cfg = getBrushTypeCfg();
    const bs = getBrushState();
    const sampleSize = Math.max(6, Math.min(30, Math.round(cssH * 0.42)));
    const eraser = state.tool === 'eraser';
    const color = eraser ? '#c8c8c8' : state.brushColor;

    if (state.brushType === 'pen') {
      ctx.strokeStyle = color;
      ctx.globalAlpha = eraser ? 1 : state.brushOpacity;
      ctx.lineWidth = sampleSize;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      ctx.stroke();
      return;
    }

    if (!brushPreviewBuf) brushPreviewBuf = document.createElement('canvas');
    brushPreviewBuf.width = bw;
    brushPreviewBuf.height = bh;
    const bctx = brushPreviewBuf.getContext('2d');
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.clearRect(0, 0, cssW, cssH);

    const sprite = makeBrushSprite(Math.round(sampleSize * dpr), color, bs.hardness, bs.texture);
    const spacing = Math.max(0.6, (bs.spacing || 0.06) * sampleSize);
    const scatter = (bs.scatter || 0) * sampleSize;
    bctx.globalAlpha = Math.max(0.02, Math.min(1, bs.flow));

    const stamp = (x, y) => {
      const px = x + (Math.random() * 2 - 1) * scatter;
      const py = y + (Math.random() * 2 - 1) * scatter;
      bctx.save();
      if (bs.texture !== 'none' && bs.texture !== 'spray') {
        bctx.translate(px, py);
        bctx.rotate(Math.random() * Math.PI * 2);
        bctx.drawImage(sprite, -sampleSize / 2, -sampleSize / 2, sampleSize, sampleSize);
      } else {
        bctx.drawImage(sprite, px - sampleSize / 2, py - sampleSize / 2, sampleSize, sampleSize);
      }
      bctx.restore();
    };

    stamp(pts[0].x, pts[0].y);
    let sx = pts[0].x, sy = pts[0].y;
    for (let i = 1; i < pts.length; i++) {
      let dx = pts[i].x - sx, dy = pts[i].y - sy;
      let d = Math.hypot(dx, dy);
      let guard = 0;
      while (d >= spacing && guard++ < 2000) {
        const ux = dx / d, uy = dy / d;
        sx += ux * spacing; sy += uy * spacing;
        stamp(sx, sy);
        dx = pts[i].x - sx; dy = pts[i].y - sy; d = Math.hypot(dx, dy);
      }
    }

    ctx.globalAlpha = eraser ? 0.9 : Math.min(1, state.brushOpacity * cfg.alphaMul);
    ctx.drawImage(brushPreviewBuf, 0, 0, bw, bh, 0, 0, cssW, cssH);
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     FILTERS / EFFECTS ENGINE
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  const FILTERS = [
    { id: 'blur', name: 'Blur', min: 1, max: 100, def: 12, unit: '', label: 'Radius' },
    { id: 'gaussian', name: 'Gaussian', min: 1, max: 100, def: 10, unit: '', label: 'Radius' },
    { id: 'sharpen', name: 'Sharpen', min: 1, max: 100, def: 30, unit: '', label: 'Amount' },
    { id: 'brightness', name: 'Brightness', min: -100, max: 100, def: 0, unit: '', label: 'Level' },
    { id: 'contrast', name: 'Contrast', min: -100, max: 100, def: 0, unit: '', label: 'Level' },
    { id: 'saturation', name: 'Saturation', min: -100, max: 100, def: 0, unit: '', label: 'Level' },
    { id: 'hue', name: 'Hue', min: -180, max: 180, def: 0, unit: '\u00b0', label: 'Angle' },
    { id: 'exposure', name: 'Exposure', min: -100, max: 100, def: 0, unit: '', label: 'Level' },
    { id: 'grayscale', name: 'Grayscale', min: 0, max: 100, def: 100, unit: '%', label: 'Amount' },
    { id: 'invert', name: 'Invert', min: 0, max: 100, def: 100, unit: '%', label: 'Amount' },
    { id: 'sepia', name: 'Sepia', min: 0, max: 100, def: 100, unit: '%', label: 'Amount' },
    { id: 'pixelate', name: 'Pixelate', min: 2, max: 64, def: 10, unit: 'px', label: 'Block' },
    { id: 'noise', name: 'Noise', min: 0, max: 100, def: 22, unit: '', label: 'Amount' },
    { id: 'posterize', name: 'Posterize', min: 2, max: 32, def: 6, unit: '', label: 'Levels' },
  ];

  const filterState = {
    id: null,        // active filter id
    layerId: null,   // layer being edited
    original: null,  // ImageData before the filter
    work: null,      // scratch ImageData
    value: 0,
  };

  function getFilterCfg(id) {
    return FILTERS.find((f) => f.id === id) || null;
  }

  function cloneImageData(img) {
    return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  }

  function buildFilterGrid() {
    const grid = $('#filterGrid');
    if (!grid) return;
    grid.innerHTML = '';
    FILTERS.forEach((f) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.dataset.filter = f.id;
      btn.textContent = f.name;
      btn.title = f.name + ' â€” preview then Apply';
      btn.addEventListener('click', () => { beginFilterSession(f.id); closeDropdowns(); });
      grid.appendChild(btn);
    });
  }

  function renderFilterPreview() {
    if (!filterState.id) return;
    const layer = findNode(filterState.layerId);
    if (!layer || isGroupNode(layer)) return;
    filterState.work.data.set(filterState.original.data);
    applyFilterImageData(filterState.work, filterState.id, filterState.value);
    layer.ctx.putImageData(filterState.work, 0, 0);
    updateLayerThumbnail(filterState.layerId);
    scheduleRender();
  }

  function applyFilterSession() {
    if (!filterState.id) { showToast('Choose a filter first', 'error'); return; }
    const layer = findNode(filterState.layerId);
    if (layer && !isGroupNode(layer)) {
      // Keep the previewed pixels, but record the original so Apply is undoable.
      // The undo stack expects {snap, bbox} (a canvas), not ImageData â€” the old
      // shape made undo() call drawImage(undefined) after wiping the layer.
      const snap = document.createElement('canvas');
      snap.width = state.docWidth;
      snap.height = state.docHeight;
      snap.getContext('2d').putImageData(filterState.original, 0, 0);
      state.undoStack.push({ layerId: layer.id, bbox: null, snap });
      if (state.undoStack.length > state.maxHistory) state.undoStack.shift();
      state.redoStack = [];
      markLayerDirty(layer.id);
      updateHistoryButtons();
      updateLayerThumbnail(layer.id);
      sendRestore(layer, null, layer.canvas);
    }
    clearFilterSession();
    scheduleRender();
    showToast('Filter applied', 'success');
  }

  function resetFilterSession() {
    if (!filterState.id) return;
    const cfg = getFilterCfg(filterState.id);
    filterState.value = cfg.def;
    const slider = $('#filterValue');
    if (slider) slider.value = cfg.def;
    setNumVal($('#filterValueVal'), cfg.def);
    renderFilterPreview();
  }

  function cancelFilterSession() {
    if (!filterState.id) return;
    const layer = findNode(filterState.layerId);
    if (layer && !isGroupNode(layer)) {
      layer.ctx.putImageData(filterState.original, 0, 0);
      updateLayerThumbnail(layer.id);
      scheduleRender();
    }
    clearFilterSession();
  }

  function clearFilterSession() {
    filterState.id = null;
    filterState.layerId = null;
    filterState.original = null;
    filterState.work = null;
    updateFilterUI();
  }

  function updateFilterUI() {
    const active = !!filterState.id;
    const controls = $('#filterControls');
    if (controls) controls.classList.toggle('hidden', !active);
    const idle = $('#filterIdleHint');
    if (idle) idle.classList.toggle('hidden', active);
    const cfg = getFilterCfg(filterState.id);
    const cur = $('#filterMenuCurrent');
    if (cur) cur.textContent = cfg ? cfg.name : 'Choose an effect';
    $$('#filterGrid .chip').forEach((c) => {
      c.classList.toggle('active', c.dataset.filter === filterState.id);
    });
  }

  function beginFilterSession(id) {
    const cfg = getFilterCfg(id);
    if (!cfg) return;
    if (filterState.id === id) return; // already active â€” keep the current session
    if (filterState.id) cancelFilterSession();

    const layer = getActiveLayer();
    if (!layer) { showToast('Select a layer to filter', 'error'); return; }
    if (layer.type === 'group') { showToast('Select a paint layer', 'error'); return; }
    if (nodeLocked(layer.id)) { showToast('Layer is locked', 'error'); return; }
    if (nodeHidden(layer.id)) { showToast('Layer is hidden', 'error'); return; }

    const w = state.docWidth, h = state.docHeight;
    const cur = layer.ctx.getImageData(0, 0, w, h);
    filterState.id = cfg.id;
    filterState.layerId = layer.id;
    filterState.original = new ImageData(new Uint8ClampedArray(cur.data), w, h);
    filterState.work = new ImageData(new Uint8ClampedArray(cur.data), w, h);
    filterState.value = cfg.def;

    const slider = $('#filterValue');
    if (slider) { slider.min = cfg.min; slider.max = cfg.max; slider.step = 1; slider.value = cfg.def; }
    const num = $('#filterValueVal');
    if (num) { num.min = cfg.min; num.max = cfg.max; num.step = 1; setNumVal(num, cfg.def); }
    const unit = $('#filterUnit');
    if (unit) unit.textContent = cfg.unit || '';
    const lbl = $('#filterValueLabel');
    if (lbl) lbl.textContent = cfg.label || 'Amount';
    updateFilterUI();
    renderFilterPreview();
  }

  function applyFilterImageData(img, id, amount) {
    const w = img.width, h = img.height, d = img.data;
    switch (id) {
      case 'brightness': {
        const add = amount * 2.55;
        for (let i = 0; i < d.length; i += 4) { d[i] += add; d[i + 1] += add; d[i + 2] += add; }
        break;
      }
      case 'contrast': {
        const c = amount * 2.55;
        const f = (259 * (c + 255)) / (255 * (259 - c));
        for (let i = 0; i < d.length; i += 4) {
          d[i] = f * (d[i] - 128) + 128;
          d[i + 1] = f * (d[i + 1] - 128) + 128;
          d[i + 2] = f * (d[i + 2] - 128) + 128;
        }
        break;
      }
      case 'saturation': {
        const s = 1 + amount / 100;
        for (let i = 0; i < d.length; i += 4) {
          const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          d[i] = lum + (d[i] - lum) * s;
          d[i + 1] = lum + (d[i + 1] - lum) * s;
          d[i + 2] = lum + (d[i + 2] - lum) * s;
        }
        break;
      }
      case 'hue': hueRotateImageData(d, amount); break;
      case 'exposure': {
        const m = Math.pow(2, (amount / 100) * 1.5);
        for (let i = 0; i < d.length; i += 4) { d[i] *= m; d[i + 1] *= m; d[i + 2] *= m; }
        break;
      }
      case 'grayscale': {
        const t = amount / 100;
        for (let i = 0; i < d.length; i += 4) {
          const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          d[i] += (lum - d[i]) * t;
          d[i + 1] += (lum - d[i + 1]) * t;
          d[i + 2] += (lum - d[i + 2]) * t;
        }
        break;
      }
      case 'invert': {
        const t = amount / 100;
        for (let i = 0; i < d.length; i += 4) {
          d[i] += t * (255 - 2 * d[i]);
          d[i + 1] += t * (255 - 2 * d[i + 1]);
          d[i + 2] += t * (255 - 2 * d[i + 2]);
        }
        break;
      }
      case 'sepia': {
        const t = amount / 100;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const sr = 0.393 * r + 0.769 * g + 0.189 * b;
          const sg = 0.349 * r + 0.686 * g + 0.168 * b;
          const sb = 0.272 * r + 0.534 * g + 0.131 * b;
          d[i] = r + (sr - r) * t;
          d[i + 1] = g + (sg - g) * t;
          d[i + 2] = b + (sb - b) * t;
        }
        break;
      }
      case 'noise': {
        const amt = amount * 2.55;
        for (let i = 0; i < d.length; i += 4) {
          const n = (Math.random() * 2 - 1) * amt;
          d[i] += n; d[i + 1] += n; d[i + 2] += n;
        }
        break;
      }
      case 'posterize': {
        const levels = Math.max(2, Math.round(amount));
        const step = 255 / (levels - 1);
        for (let i = 0; i < d.length; i += 4) {
          d[i] = Math.round(d[i] / step) * step;
          d[i + 1] = Math.round(d[i + 1] / step) * step;
          d[i + 2] = Math.round(d[i + 2] / step) * step;
        }
        break;
      }
      case 'pixelate': pixelateImageData(img, Math.max(2, Math.round(amount))); break;
      case 'blur': blurImageData(d, img.width, img.height, Math.max(1, Math.round(amount / 6)), 1); break;
      case 'gaussian': blurImageData(d, img.width, img.height, Math.max(1, Math.round(amount / 14)), 3); break;
      case 'sharpen': sharpenImageData(img, amount); break;
    }
  }

  function hueRotateImageData(d, angleDeg) {
    const a = (angleDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const m00 = 0.213 + c * 0.787 - s * 0.213, m01 = 0.715 - c * 0.715 - s * 0.715, m02 = 0.072 - c * 0.072 + s * 0.928;
    const m10 = 0.213 - c * 0.213 + s * 0.143, m11 = 0.715 + c * 0.285 + s * 0.140, m12 = 0.072 - c * 0.072 - s * 0.283;
    const m20 = 0.213 - c * 0.213 - s * 0.787, m21 = 0.715 - c * 0.715 + s * 0.715, m22 = 0.072 + c * 0.928 + s * 0.072;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      d[i] = m00 * r + m01 * g + m02 * b;
      d[i + 1] = m10 * r + m11 * g + m12 * b;
      d[i + 2] = m20 * r + m21 * g + m22 * b;
    }
  }

  function blurImageData(data, w, h, radius, iterations) {
    if (radius < 1) return;
    const N = w * h * 4;
    const a = new Float32Array(N);
    const b = new Float32Array(N);
    for (let i = 0; i < N; i += 4) {
      const al = data[i + 3] / 255;
      a[i] = data[i] * al;
      a[i + 1] = data[i + 1] * al;
      a[i + 2] = data[i + 2] * al;
      a[i + 3] = data[i + 3];
    }
    for (let it = 0; it < iterations; it++) {
      boxPassH(a, b, w, h, radius);
      boxPassV(b, a, w, h, radius);
    }
    for (let i = 0; i < N; i += 4) {
      const al255 = a[i + 3];
      if (al255 > 0.5) {
        const inv = 255 / al255;
        data[i] = a[i] * inv;
        data[i + 1] = a[i + 1] * inv;
        data[i + 2] = a[i + 2] * inv;
      } else {
        data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;
      }
      data[i + 3] = al255;
    }
  }

  function boxPassH(src, dst, w, h, r) {
    const iarr = 1 / (r + r + 1);
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      let r0 = 0, g0 = 0, b0 = 0, a0 = 0;
      for (let j = -r; j <= r; j++) {
        const x = j < 0 ? 0 : (j >= w ? w - 1 : j);
        const i = row + x * 4;
        r0 += src[i]; g0 += src[i + 1]; b0 += src[i + 2]; a0 += src[i + 3];
      }
      for (let x = 0; x < w; x++) {
        const i = row + x * 4;
        dst[i] = r0 * iarr; dst[i + 1] = g0 * iarr; dst[i + 2] = b0 * iarr; dst[i + 3] = a0 * iarr;
        if (x < w - 1) {
          const addX = Math.min(w - 1, x + 1 + r);
          const remX = Math.max(0, x - r);
          const ai = row + addX * 4, ri = row + remX * 4;
          r0 += src[ai] - src[ri]; g0 += src[ai + 1] - src[ri + 1];
          b0 += src[ai + 2] - src[ri + 2]; a0 += src[ai + 3] - src[ri + 3];
        }
      }
    }
  }

  function boxPassV(src, dst, w, h, r) {
    const iarr = 1 / (r + r + 1);
    for (let x = 0; x < w; x++) {
      let r0 = 0, g0 = 0, b0 = 0, a0 = 0;
      for (let j = -r; j <= r; j++) {
        const y = j < 0 ? 0 : (j >= h ? h - 1 : j);
        const i = (y * w + x) * 4;
        r0 += src[i]; g0 += src[i + 1]; b0 += src[i + 2]; a0 += src[i + 3];
      }
      for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4;
        dst[i] = r0 * iarr; dst[i + 1] = g0 * iarr; dst[i + 2] = b0 * iarr; dst[i + 3] = a0 * iarr;
        if (y < h - 1) {
          const addY = Math.min(h - 1, y + 1 + r);
          const remY = Math.max(0, y - r);
          const ai = (addY * w + x) * 4, ri = (remY * w + x) * 4;
          r0 += src[ai] - src[ri]; g0 += src[ai + 1] - src[ri + 1];
          b0 += src[ai + 2] - src[ri + 2]; a0 += src[ai + 3] - src[ri + 3];
        }
      }
    }
  }

  function pixelateImageData(img, block) {
    const w = img.width, h = img.height, d = img.data;
    block = Math.max(2, Math.round(block));
    for (let by = 0; by < h; by += block) {
      for (let bx = 0; bx < w; bx += block) {
        const bw = Math.min(block, w - bx);
        const bh = Math.min(block, h - by);
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let y = by; y < by + bh; y++) {
          let i = (y * w + bx) * 4;
          for (let x = bx; x < bx + bw; x++, i += 4) {
            r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3]; n++;
          }
        }
        r /= n; g /= n; b /= n; a /= n;
        for (let y = by; y < by + bh; y++) {
          let i = (y * w + bx) * 4;
          for (let x = bx; x < bx + bw; x++, i += 4) {
            d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
          }
        }
      }
    }
  }

  function sharpenImageData(img, amount) {
    const w = img.width, h = img.height, d = img.data;
    const copy = new Uint8ClampedArray(d);
    blurImageData(d, w, h, 1, 1);
    const k = (amount / 100) * 1.8;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = copy[i] + k * (copy[i] - d[i]);
      d[i + 1] = copy[i + 1] + k * (copy[i + 1] - d[i + 1]);
      d[i + 2] = copy[i + 2] + k * (copy[i + 2] - d[i + 2]);
      d[i + 3] = copy[i + 3];
    }
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     UI â€” TOOL SELECTION & DYNAMIC SETTINGS
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function selectTool(tool) {
    if (state.tool === 'layer-transform' && tool !== 'layer-transform' && layerTransform.active) {
      endLayerTransform(true);
    }
    if ((state.tool === 'rect' || state.tool === 'ellipse' || state.tool === 'line') && shapeState.isDrawing) {
      shapeState.isDrawing = false;
      renderOverlay();
    }
    if (state.tool === 'curve' && tool !== 'curve') {
      clearCurve();
    }
    state.tool = tool;
    $$('.tool-btn[data-tool]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === tool);
    });
    canvasArea.setAttribute('data-tool', tool);
    if (tool === 'layer-transform') beginLayerTransform();
    updateBrushCursor();
    updateToolSettingsPanel();
    updateBrushPreview();
    updateCanvasHint();
    if (textState.editing && tool !== 'text') cancelText();
    renderOverlay();
  }

  function updateCanvasHint() {
    const hint = $('#canvasOverlayHint');
    if (!hint) return;
    let text = '';
    if (state.tool === 'transform' && !state.refImage) text = 'Import a <strong>reference image</strong> to transform it';
    else if (state.tool === 'transform' && state.refLocked) text = 'Reference is locked â€” unlock to transform';
    else if (state.tool === 'select') text = 'Drag to select an area. Drawing stays inside it.';
    else if (state.tool === 'wand') text = 'Click a colour to select the connected region that matches it';
    else if (state.tool === 'rect' || state.tool === 'ellipse' || state.tool === 'line') text = 'Drag to draw Â· hold <strong>Shift</strong> for square / circle / 45&deg; line';
    else if (state.tool === 'layer-transform' && !layerTransform.active) text = 'This layer is empty â€” nothing to move';
    else if (state.tool === 'layer-transform') text = 'Drag to move &middot; corners to scale &middot; top handle to rotate &middot; <strong>Enter</strong> apply &middot; <strong>Esc</strong> cancel';
    else if (state.tool === 'text') text = 'Click the canvas, type, then press <strong>Enter</strong>';
    if (text) { hint.innerHTML = text; hint.classList.remove('hidden'); }
    else hint.classList.add('hidden');
  }

  function updateToolSettingsPanel() {
    const title = $('#toolSettingsName');
    const panels = {
      fade: $('#fadeShapeControls'),
      bezier: $('#bezierControls'),
      general: $('#generalToolControls'),
      fill: $('#fillControls'),
      text: $('#textControls'),
      select: $('#selectControls'),
      wand: $('#wandControls'),
      shape: $('#shapeControls'),
      transform: $('#transformControls'),
      layerTransform: $('#layerTransformControls'),
    };
    Object.keys(panels).forEach(k => { if (panels[k]) panels[k].classList.add('hidden'); });
    const generalHint = $('#generalToolHint');

    switch (state.tool) {
      case 'fade-shape':
        title.textContent = 'Fade Shape Tool';
        panels.fade.classList.remove('hidden');
        break;
      case 'curve':
        title.textContent = 'BÃ©zier Curve Tool';
        panels.bezier.classList.remove('hidden');
        updateCurveStatus();
        break;
      case 'fill':
        title.textContent = 'Paint Bucket';
        panels.fill.classList.remove('hidden');
        break;
      case 'text':
        title.textContent = 'Text Tool';
        panels.text.classList.remove('hidden');
        break;
      case 'select':
        title.textContent = 'Selection';
        panels.select.classList.remove('hidden');
        updateSelectStatus();
        break;
      case 'wand':
        title.textContent = 'Magic Wand';
        panels.wand.classList.remove('hidden');
        updateWandStatus();
        break;
      case 'rect':
      case 'ellipse':
      case 'line':
        title.textContent = state.tool === 'line' ? 'Straight Line' : (state.tool === 'ellipse' ? 'Circle / Ellipse' : 'Rectangle');
        panels.shape.classList.remove('hidden');
        break;
      case 'transform':
        title.textContent = 'Transform Reference';
        panels.transform.classList.remove('hidden');
        { const chk = $('#checkRefLocked'); if (chk) chk.checked = state.refLocked; }
        break;
      case 'layer-transform':
        title.textContent = 'Move Layer';
        panels.layerTransform.classList.remove('hidden');
        syncLayerTransformUI();
        break;
      case 'brush':
        title.textContent = 'Brush Properties';
        panels.general.classList.remove('hidden');
        generalHint.textContent = 'Freehand brush active. Draw or trace over the reference image.';
        break;
      case 'eraser':
        title.textContent = 'Eraser Properties';
        panels.general.classList.remove('hidden');
        generalHint.textContent = 'Eraser active. Erase drawing marks on the active layer.';
        break;
      case 'eyedropper':
        title.textContent = 'Color Picker';
        panels.general.classList.remove('hidden');
        generalHint.textContent = 'Click on the canvas to sample a color from the composite.';
        break;
      case 'zoom':
        title.textContent = 'Zoom Tool';
        panels.general.classList.remove('hidden');
        generalHint.textContent = 'Click to zoom in. Hold Alt + click to zoom out. Scroll wheel also zooms.';
        break;
      case 'move':
        title.textContent = 'Move / Pan';
        panels.general.classList.remove('hidden');
        generalHint.textContent = 'Drag to pan the view. You can also hold Spacebar anywhere.';
        break;
      default:
        title.textContent = 'Tool Properties';
        panels.general.classList.remove('hidden');
    }
    const isPaint = state.tool === 'brush' || state.tool === 'eraser';
    const stabRow = $('#stabilizerRow');
    if (stabRow) stabRow.classList.toggle('hidden', !isPaint);
    const fadeGroup = $('#forceFadeGroup');
    if (fadeGroup) fadeGroup.classList.toggle('hidden', !isPaint);
    const fadeControls = $('#fadeControls');
    if (fadeControls) fadeControls.classList.toggle('hidden', !isPaint || !getFadeSettings().enabled);
    if (isPaint) syncFadeUI();
    if (brushUIView()) { syncBrushTypeUI(); drawBrushTipPreview(); }
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     OVERLAY RENDERING (unified)
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function renderOverlay() {
    if (!overlayCtx) return;
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.clearRect(0, 0, state.docWidth, state.docHeight);
    if (state.tool === 'curve') drawCurveOverlay();
    if (state.tool === 'transform') drawTransformOverlay();
    if (state.tool === 'layer-transform') drawLayerTransformOverlay();
    if (state.tool === 'select' && selectState.isSelecting) drawSelectPreview();
    if (state.tool === 'rect' || state.tool === 'ellipse' || state.tool === 'line') {
      if (shapeState.isDrawing) drawShapePreview();
    }
    if (selectState.active) {
      if (selectState.kind === 'wand') drawWandOverlay();
      else drawSelectionAnts();
    }
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     FADE SHAPE TOOL ENGINE
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function hexToRgba(hex, alpha) {
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const num = parseInt(c, 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + (alpha !== undefined ? alpha : 1) + ')';
  }

  function drawStarPath(ctx, cx, cy, spikes, outerRadius, innerRadius) {
    let rot = (Math.PI / 2) * 3;
    let x = cx, y = cy;
    const step = Math.PI / spikes;
    ctx.beginPath();
    ctx.moveTo(cx, cy - outerRadius);
    for (let i = 0; i < spikes; i++) {
      x = cx + Math.cos(rot) * outerRadius;
      y = cy + Math.sin(rot) * outerRadius;
      ctx.lineTo(x, y);
      rot += step;
      x = cx + Math.cos(rot) * innerRadius;
      y = cy + Math.sin(rot) * innerRadius;
      ctx.lineTo(x, y);
      rot += step;
    }
    ctx.lineTo(cx, cy - outerRadius);
    ctx.closePath();
  }

  function drawFadeShape(ctx, sx, sy, cx, cy, isPreview) {
    const x = Math.min(sx, cx);
    const y = Math.min(sy, cy);
    const w = Math.abs(cx - sx);
    const h = Math.abs(cy - sy);
    if (w < 2 && h < 2) return;

    const shape = fadeShapeState.shape;
    const mode = fadeShapeState.fillMode;
    const feather = fadeShapeState.feather;
    const color = state.brushColor;
    const opacity = safeBrushOpacity();

    ctx.save();
    if (shape === 'rect') {
      if (mode === 'feather') {
        ctx.globalAlpha = opacity;
        ctx.filter = 'blur(' + feather + 'px)';
        ctx.fillStyle = color;
        const pad = Math.min(feather * 0.4, Math.min(w, h) * 0.2);
        ctx.fillRect(x + pad, y + pad, Math.max(1, w - pad * 2), Math.max(1, h - pad * 2));
      } else {
        const grad = ctx.createLinearGradient(sx, sy, cx, cy);
        grad.addColorStop(0, hexToRgba(color, opacity));
        grad.addColorStop(1, hexToRgba(color, 0));
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, w, h);
      }
    } else if (shape === 'ellipse') {
      const rx = w / 2, ry = h / 2;
      const midX = x + rx, midY = y + ry;
      if (mode === 'feather') {
        ctx.globalAlpha = opacity;
        ctx.filter = 'blur(' + feather + 'px)';
        ctx.fillStyle = color;
        ctx.beginPath();
        const padX = Math.min(feather * 0.4, rx * 0.3);
        const padY = Math.min(feather * 0.4, ry * 0.3);
        ctx.ellipse(midX, midY, Math.max(1, rx - padX), Math.max(1, ry - padY), 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const grad = ctx.createRadialGradient(midX, midY, 0, midX, midY, Math.max(rx, ry));
        grad.addColorStop(0, hexToRgba(color, opacity));
        grad.addColorStop(1, hexToRgba(color, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(midX, midY, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (shape === 'radialFade') {
      const radius = Math.hypot(cx - sx, cy - sy);
      if (radius > 1) {
        const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, radius);
        grad.addColorStop(0, hexToRgba(color, opacity));
        grad.addColorStop(0.4, hexToRgba(color, opacity * 0.65));
        grad.addColorStop(0.8, hexToRgba(color, opacity * 0.2));
        grad.addColorStop(1, hexToRgba(color, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (shape === 'linearFade') {
      const grad = ctx.createLinearGradient(sx, sy, cx, cy);
      grad.addColorStop(0, hexToRgba(color, opacity));
      grad.addColorStop(0.5, hexToRgba(color, opacity * 0.5));
      grad.addColorStop(1, hexToRgba(color, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, w, h);
    } else if (shape === 'star') {
      const midX = x + w / 2, midY = y + h / 2;
      const outerR = Math.max(w, h) / 2;
      const innerR = outerR * 0.45;
      if (mode === 'feather') {
        ctx.globalAlpha = opacity;
        ctx.filter = 'blur(' + feather + 'px)';
        ctx.fillStyle = color;
        drawStarPath(ctx, midX, midY, 5, outerR, innerR);
        ctx.fill();
      } else {
        const grad = ctx.createRadialGradient(midX, midY, 0, midX, midY, outerR);
        grad.addColorStop(0, hexToRgba(color, opacity));
        grad.addColorStop(1, hexToRgba(color, 0));
        ctx.fillStyle = grad;
        drawStarPath(ctx, midX, midY, 5, outerR, innerR);
        ctx.fill();
      }
    }
    ctx.restore();

    if (isPreview && overlayCtx) {
      overlayCtx.save();
      const sc = 1 / state.zoom;
      overlayCtx.strokeStyle = 'rgba(53,163,232,0.5)';
      overlayCtx.lineWidth = 1.4 * sc;
      overlayCtx.setLineDash([4 * sc, 4 * sc]);
      overlayCtx.strokeRect(x, y, w, h);
      overlayCtx.restore();
    }
  }

  // Doc-space region a fade shape can touch, for shipping the committed pixels
  // to other devices. Radial fades paint a full circle and stars a circumscribed
  // disc, so those extend past the drag rect.
  function fadeShapeSyncBBox(sx, sy, cx, cy) {
    const fs = fadeShapeState;
    let x0 = Math.min(sx, cx), y0 = Math.min(sy, cy);
    let x1 = Math.max(sx, cx), y1 = Math.max(sy, cy);
    if (fs.shape === 'radialFade') {
      const r = Math.hypot(cx - sx, cy - sy);
      x0 = sx - r; y0 = sy - r; x1 = sx + r; y1 = sy + r;
    } else if (fs.shape === 'star') {
      const midX = (x0 + x1) / 2, midY = (y0 + y1) / 2;
      const R = Math.max(x1 - x0, y1 - y0) / 2;
      x0 = midX - R; y0 = midY - R; x1 = midX + R; y1 = midY + R;
    }
    const pad = (fs.feather || 0) + 2;
    return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     BÃ‰ZIER CURVE TOOL ENGINE (3-step state machine)
     Step 1: pointerdown to pick start point, drag to end point
     Step 2: pull to set control point curve
     Step 3: tap/release to commit to main canvas
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function hitTestCurveHandle(clientX, clientY) {
    return null;
  }

  function autoSmoothCurveHandles() {}

  function drawCurveOverlay() {
    if (!overlayCtx) return;
    if (curveState.step === 0) return;

    const { p0, p1, cp, step, isClosed, strokeShape, fillShape } = curveState;
    const handleScale = 1 / Math.max(0.05, state.zoom || 1);
    const anchorR = Math.max(5, 7 * handleScale);
    const handleR = Math.max(4, 5.5 * handleScale);
    const brushSize = safeBrushSize();
    const brushColor = state.brushColor;
    const brushOpacity = safeBrushOpacity();

    // 1. Live curve preview
    overlayCtx.save();
    overlayCtx.beginPath();
    overlayCtx.moveTo(p0.x, p0.y);
    if (step === 1) {
      overlayCtx.lineTo(p1.x, p1.y);
    } else {
      overlayCtx.quadraticCurveTo(cp.x, cp.y, p1.x, p1.y);
      if (isClosed) {
        overlayCtx.lineTo(p0.x, p0.y);
        overlayCtx.closePath();
        if (fillShape) {
          overlayCtx.fillStyle = brushColor;
          overlayCtx.globalAlpha = brushOpacity;
          overlayCtx.fill();
        }
      }
    }
    if (strokeShape) {
      overlayCtx.strokeStyle = brushColor;
      overlayCtx.lineWidth = brushSize;
      overlayCtx.lineCap = 'round';
      overlayCtx.lineJoin = 'round';
      overlayCtx.globalAlpha = brushOpacity;
      overlayCtx.stroke();
    }
    overlayCtx.restore();

    // 2. Control guidelines and handles
    overlayCtx.save();
    if (step === 2) {
      // Dashed control lines from anchors to the control point
      overlayCtx.beginPath();
      overlayCtx.setLineDash([4 * handleScale, 4 * handleScale]);
      overlayCtx.strokeStyle = 'rgba(255, 64, 129, 0.75)';
      overlayCtx.lineWidth = 1.5 * handleScale;
      overlayCtx.moveTo(p0.x, p0.y);
      overlayCtx.lineTo(cp.x, cp.y);
      overlayCtx.lineTo(p1.x, p1.y);
      overlayCtx.stroke();
      overlayCtx.setLineDash([]);

      // Control point handle (pink with white ring)
      overlayCtx.beginPath();
      overlayCtx.arc(cp.x, cp.y, handleR, 0, Math.PI * 2);
      overlayCtx.fillStyle = '#ff4081';
      overlayCtx.fill();
      overlayCtx.strokeStyle = '#ffffff';
      overlayCtx.lineWidth = 2 * handleScale;
      overlayCtx.stroke();
    }

    // Anchor handles (cyan at start point, yellow at end point)
    [p0, p1].forEach((p, idx) => {
      overlayCtx.beginPath();
      overlayCtx.arc(p.x, p.y, anchorR, 0, Math.PI * 2);
      overlayCtx.fillStyle = idx === 0 ? '#00e5ff' : '#ffeb3b';
      overlayCtx.fill();
      overlayCtx.strokeStyle = '#101018';
      overlayCtx.lineWidth = 2 * handleScale;
      overlayCtx.stroke();
    });

    overlayCtx.restore();
  }

  function commitCurveToLayer() {
    const layer = getActiveLayer();
    if (!layer || !canEditActive()) {
      clearCurve();
      return;
    }
    const { p0, p1, cp, isClosed, strokeShape, fillShape } = curveState;
    const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    if (dist < 2) {
      clearCurve();
      return;
    }

    const bSize = safeBrushSize();
    const bAlpha = safeBrushOpacity();
    const bColor = state.brushColor;

    pushUndo(layer);
    paintDelta(layer, (ctx) => {
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.quadraticCurveTo(cp.x, cp.y, p1.x, p1.y);
      if (isClosed) {
        ctx.lineTo(p0.x, p0.y);
        ctx.closePath();
        if (fillShape) {
          ctx.fillStyle = bColor;
          ctx.globalAlpha = bAlpha;
          ctx.fill();
        }
      }
      if (strokeShape) {
        ctx.strokeStyle = bColor;
        ctx.lineWidth = bSize;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = bAlpha;
        ctx.stroke();
      }
    });

    const minX = Math.min(p0.x, p1.x, cp.x) - bSize - 4;
    const minY = Math.min(p0.y, p1.y, cp.y) - bSize - 4;
    const maxX = Math.max(p0.x, p1.x, cp.x) + bSize + 4;
    const maxY = Math.max(p0.y, p1.y, cp.y) + bSize + 4;
    sendRestore(layer, { x0: minX, y0: minY, x1: maxX, y1: maxY }, layer.canvas);

    curveState.step = 0;
    curveState.isPulling = false;
    updateCurveStatus();
    updateLayerThumbnail(layer.id);
    scheduleRender();
    renderOverlay();
    showToast('BÃ©zier curve stamped to layer!', 'success');
  }

  function toggleCloseCurve() {
    curveState.isClosed = !curveState.isClosed;
    const btn = $('#btnToggleCloseCurve');
    if (btn) btn.textContent = curveState.isClosed ? 'Open' : 'Close';
    const modeShape = $('#btnCurveModeShape');
    if (modeShape) modeShape.classList.toggle('active', curveState.isClosed);
    const modeLine = $('#btnCurveModeLine');
    if (modeLine) modeLine.classList.toggle('active', !curveState.isClosed);
    renderOverlay();
  }

  function deleteLastCurvePoint() {
    clearCurve();
  }

  function clearCurve() {
    curveState.step = 0;
    curveState.isPulling = false;
    updateCurveStatus();
    renderOverlay();
    showToast('Curve cleared');
  }

  function updateCurveStatus() {
    const el = $('#curveStatusText');
    if (el) {
      if (curveState.step === 0) {
        el.textContent = 'Drag on canvas to place line';
      } else if (curveState.step === 1) {
        el.textContent = 'Dragging end point...';
      } else if (curveState.step === 2) {
        el.textContent = 'Pull to set curve, release to commit ' + (curveState.isClosed ? '(closed)' : '');
      }
    }
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     SHAPE / RULER TOOLS  (rectangle, ellipse, line)
     Drag to define, live preview on the overlay, stamp on release.
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function shapeRect(x0, y0, x1, y1, shift) {
    const x = Math.min(x0, x1);
    const y = Math.min(y0, y1);
    let w = Math.abs(x1 - x0);
    let h = Math.abs(y1 - y0);
    if (shift) {
      const s = Math.max(w, h);
      w = s;
      h = s;
    }
    return { x, y, w, h };
  }

  // Builds the canvas path for the active shape tool (no fill/stroke yet).
  function traceShape(ctx, tool, x0, y0, x1, y1, shift) {
    ctx.beginPath();
    if (tool === 'line') {
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      return;
    }
    const r = shapeRect(x0, y0, x1, y1, shift);
    if (tool === 'rect') {
      ctx.rect(r.x, r.y, r.w, r.h);
    } else if (tool === 'ellipse') {
      // With Shift, shapeRect already returns a square, so rx === ry (circle).
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    }
  }

  function drawShape(ctx, tool, x0, y0, x1, y1, shift, alphaScale) {
    const alpha = safeBrushOpacity() * (alphaScale === undefined ? 1 : alphaScale);
    traceShape(ctx, tool, x0, y0, x1, y1, shift);
    if (tool !== 'line' && shapeState.fill) {
      ctx.fillStyle = state.brushColor;
      ctx.globalAlpha = alpha;
      ctx.fill();
    }
    if (shapeState.stroke) {
      ctx.strokeStyle = state.brushColor;
      ctx.lineWidth = Math.max(1, shapeState.lineWidth);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.globalAlpha = alpha;
      ctx.stroke();
    }
  }

  function drawShapePreview() {
    if (!overlayCtx) return;
    const tool = state.tool;
    overlayCtx.save();
    overlayCtx.clearRect(0, 0, state.docWidth, state.docHeight);
    drawShape(overlayCtx, tool, shapeState.startX, shapeState.startY, shapeState.curX, shapeState.curY, shapeState.shift, 0.62);
    // Bounding guide (dashed) so the drag extent is obvious.
    const r = shapeRect(shapeState.startX, shapeState.startY, shapeState.curX, shapeState.curY, shapeState.shift);
    const sc = 1 / state.zoom;
    overlayCtx.setLineDash([5 * sc, 4 * sc]);
    overlayCtx.strokeStyle = 'rgba(255,255,255,0.75)';
    overlayCtx.lineWidth = 1.4 * sc;
    overlayCtx.strokeRect(r.x, r.y, r.w, r.h);
    overlayCtx.restore();
  }

  function commitShape() {
    const tool = state.tool;
    const x0 = shapeState.startX, y0 = shapeState.startY;
    const x1 = shapeState.curX, y1 = shapeState.curY;
    if (tool === 'line') {
      if (Math.hypot(x1 - x0, y1 - y0) < 3) return;
    } else {
      const r = shapeRect(x0, y0, x1, y1, shapeState.shift);
      if (r.w < 2 && r.h < 2) return;
    }
    if (!shapeState.stroke && !(shapeState.fill && tool !== 'line')) {
      showToast('Enable Fill or Stroke to draw a shape', 'error');
      return;
    }
    if (!canEditActive()) return;
    const layer = getActiveLayer();
    if (!layer) return;
    pushUndo(layer);
    paintDelta(layer, (c) => drawShape(c, tool, x0, y0, x1, y1, shapeState.shift, 1));
    const shapePad = Math.max(shapeState.lineWidth || 0, safeBrushSize()) / 2 + 2;
    let shapeBBox;
    if (tool === 'line') {
      shapeBBox = {
        x0: Math.min(x0, x1) - shapePad, y0: Math.min(y0, y1) - shapePad,
        x1: Math.max(x0, x1) + shapePad, y1: Math.max(y0, y1) + shapePad,
      };
    } else {
      const r = shapeRect(x0, y0, x1, y1, shapeState.shift);
      shapeBBox = {
        x0: r.x - shapePad, y0: r.y - shapePad,
        x1: r.x + r.w + shapePad, y1: r.y + r.h + shapePad,
      };
    }
    sendRestore(layer, shapeBBox, layer.canvas);
    updateLayerThumbnail(layer.id);
    scheduleRender();
    showToast('Shape drawn', 'success');
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     MAGIC WAND  (colour-based flood selection)
     Contiguous region growing by colour similarity, with a feathered
     alpha mask so edits keep smooth, anti-aliased edges.
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  // Separable box blur over a Uint8 buffer using prefix sums (O(n)), with
  // edge clamping. Feathering the binary flood region this way removes
  // stair-stepped / jagged edges at a fraction of the naive cost.
  function blurAlphaMask(src, w, h, radius) {
    if (radius <= 0) return src;
    const n = w * h;
    const tmp = new Float32Array(n);
    const out = new Uint8Array(n);
    const rowPrefix = new Float32Array(w + 1);
    for (let y = 0; y < h; y++) {
      const base = y * w;
      rowPrefix[0] = 0;
      for (let x = 0; x < w; x++) rowPrefix[x + 1] = rowPrefix[x] + src[base + x];
      for (let x = 0; x < w; x++) {
        const a = x - radius < 0 ? 0 : x - radius;
        const b = x + radius > w - 1 ? w - 1 : x + radius;
        tmp[base + x] = (rowPrefix[b + 1] - rowPrefix[a]) / (b - a + 1);
      }
    }
    const colPrefix = new Float32Array(h + 1);
    for (let x = 0; x < w; x++) {
      colPrefix[0] = 0;
      for (let y = 0; y < h; y++) colPrefix[y + 1] = colPrefix[y] + tmp[y * w + x];
      for (let y = 0; y < h; y++) {
        const a = y - radius < 0 ? 0 : y - radius;
        const b = y + radius > h - 1 ? h - 1 : y + radius;
        out[y * w + x] = Math.round((colPrefix[b + 1] - colPrefix[a]) / (b - a + 1));
      }
    }
    return out;
  }

  // 1px boundary of a binary region, drawn as white pixels for marching ants.
  function buildWandEdge(region, w, h) {
    const n = w * h;
    const img = new ImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!region[i]) continue;
        const up = y > 0 && region[i - w];
        const dn = y < h - 1 && region[i + w];
        const lf = x > 0 && region[i - 1];
        const rt = x < w - 1 && region[i + 1];
        if (!(up && dn && lf && rt)) {
          const j = i * 4;
          d[j] = 255; d[j + 1] = 255; d[j + 2] = 255; d[j + 3] = 255;
        }
      }
    }
    return img;
  }

  function magicWandSelect(docX, docY) {
    const w = state.docWidth, h = state.docHeight;
    const sx = Math.round(docX), sy = Math.round(docY);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;

    const layer = getActiveLayer();
    if (!layer) { showToast('Select a layer first', 'error'); return; }

    // Sample the composite of visible layers (or just the active layer).
    const img = wandState.sampleAll ? sampleAllLayers(0, 0, w, h) : layer.ctx.getImageData(0, 0, w, h);
    const data = img.data;
    const seedIdx = (sy * w + sx) * 4;
    const tR = data[seedIdx], tG = data[seedIdx + 1], tB = data[seedIdx + 2], tA = data[seedIdx + 3];

    const tol = Math.max(0, Math.min(255, wandState.tolerance));
    const n = w * h;
    const member = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      let d = Math.abs(data[j] - tR);
      const dg = Math.abs(data[j + 1] - tG); if (dg > d) d = dg;
      const db = Math.abs(data[j + 2] - tB); if (db > d) d = db;
      const da = Math.abs(data[j + 3] - tA); if (da > d) d = da;
      member[i] = d <= tol ? 1 : 0;
    }

    const region = floodRegion(member, w, h, sx, sy, false);
    if (!region[sy * w + sx]) { showToast('Nothing to select there', 'error'); return; }

    let minX = w, minY = h, maxX = -1, maxY = -1, count = 0;
    for (let y = 0; y < h; y++) {
      const base = y * w;
      for (let x = 0; x < w; x++) {
        if (region[base + x]) {
          count++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    const feather = Math.max(0, Math.min(8, wandState.feather));
    let alpha = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (region[i]) alpha[i] = 255;
    const soft = feather > 0 ? blurAlphaMask(alpha, w, h, feather) : alpha;

    // Soft mask (cyan tint; alpha = selection). Used for masking edits and as
    // the on-canvas tint.
    const maskImg = new ImageData(w, h);
    const md = maskImg.data;
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      md[j] = 53; md[j + 1] = 163; md[j + 2] = 232; md[j + 3] = soft[i];
    }
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = w; maskCanvas.height = h;
    maskCanvas.getContext('2d').putImageData(maskImg, 0, 0);

    // Boundary used for the marching-ants overlay.
    const edgeImg = buildWandEdge(region, w, h);
    const edgeCanvas = document.createElement('canvas');
    edgeCanvas.width = w; edgeCanvas.height = h;
    edgeCanvas.getContext('2d').putImageData(edgeImg, 0, 0);

    if (selectState.animId) stopSelectionAnimation();
    selectState.active = true;
    selectState.kind = 'wand';
    selectState.maskCanvas = maskCanvas;
    selectState.maskEdgeCanvas = edgeCanvas;
    selectState.pixelCount = count;
    selectState.x = minX;
    selectState.y = minY;
    selectState.w = maxX - minX + 1;
    selectState.h = maxY - minY + 1;
    startSelectionAnimation();
    updateSelectStatus();
    updateWandStatus();
    renderOverlay();
    showToast(count.toLocaleString() + ' px selected', 'success');
  }

  function drawWandOverlay() {
    if (!overlayCtx || !wandActive()) return;
    overlayCtx.save();
    overlayCtx.globalCompositeOperation = 'source-over';
    overlayCtx.globalAlpha = 0.22;
    overlayCtx.drawImage(selectState.maskCanvas, 0, 0);
    if (selectState.maskEdgeCanvas) {
      const sc = 1 / state.zoom;
      const off = (selectState.antOffset % 6) * sc;
      overlayCtx.globalAlpha = 1;
      overlayCtx.drawImage(selectState.maskEdgeCanvas, off, off);
      overlayCtx.globalAlpha = 0.5;
      overlayCtx.drawImage(selectState.maskEdgeCanvas, -off, -off);
    }
    overlayCtx.restore();
  }

  function updateWandStatus() {
    const el = $('#wandStatusText');
    if (!el) return;
    if (!selectState.active || selectState.kind !== 'wand') {
      el.textContent = 'Click a colour on the canvas to select it';
      return;
    }
    el.textContent = selectState.pixelCount.toLocaleString() + ' px selected Â· tol ' + wandState.tolerance +
      ' Â· soft ' + wandState.feather + 'px';
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     BRUSH CURSOR
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  let brushCursorEl = null;
  let pointerIsTouch = false;

  function createBrushCursor() {
    brushCursorEl = document.createElement('div');
    brushCursorEl.className = 'brush-cursor';
    document.body.appendChild(brushCursorEl);
  }

  function updateBrushCursor() {
    if (!brushCursorEl) return;
    const show = (state.tool === 'brush' || state.tool === 'eraser') && !state.isPanning && !pointerIsTouch;
    brushCursorEl.style.display = show ? 'block' : 'none';
    if (show) {
      const size = Math.max(4, state.brushSize);
      brushCursorEl.style.width = size + 'px';
      brushCursorEl.style.height = size + 'px';
      const active = getActiveLayer();
      brushCursorEl.classList.toggle('locked', !!(active && nodeLocked(active.id)));
    }
  }

  function moveBrushCursor(clientX, clientY) {
    if (!brushCursorEl || brushCursorEl.style.display === 'none') return;
    brushCursorEl.style.left = clientX + 'px';
    brushCursorEl.style.top = clientY + 'px';
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     EVENT BINDING
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function bindEvents() {
    $$('.tool-btn[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => selectTool(btn.dataset.tool));
    });

    // Top bar
    $('#btnUndo').addEventListener('click', () => undo());
    $('#btnRedo').addEventListener('click', () => redo());
    $('#btnUndo2').addEventListener('click', () => undo());
    $('#btnRedo2').addEventListener('click', () => redo());
    $('#btnClear').addEventListener('click', clearActiveLayer);
    $('#btnExportPNG').addEventListener('click', exportPNG);
    $('#btnSave').addEventListener('click', () => saveNow(false));
    $('#btnBackToGallery').addEventListener('click', backToGallery);
    $('#btnOutput').addEventListener('click', () => openOutputWindow());
    $('#btnOutputFollow').addEventListener('click', () => {
      state.outputFollowView = !state.outputFollowView;
      $('#btnOutputFollow').classList.toggle('active', state.outputFollowView);
      scheduleOutputUpdate();
      showToast(state.outputFollowView ? 'Output follows your zoom & pan' : 'Output shows the whole canvas');
    });
    $('#btnPrivacy').addEventListener('click', () => togglePrivacy());
    $('#btnExitPrivacy').addEventListener('click', () => togglePrivacy(false));
    $('#btnPrivacyRef').addEventListener('click', () => {
      toggleReference();
      const refBtn = $('#btnPrivacyRef');
      if (refBtn) refBtn.classList.toggle('active', state.refVisible && !!state.refImage);
    });
    $('#btnLayersToggle').addEventListener('click', () => {
      $('#panelRight').classList.toggle('collapsed');
    });

    // Keyboard shortcuts help
    const shortcutsBtn = $('#btnShortcuts');
    if (shortcutsBtn) shortcutsBtn.addEventListener('click', () => toggleShortcuts());
    const closeShortcuts = $('#btnCloseShortcuts');
    if (closeShortcuts) closeShortcuts.addEventListener('click', () => toggleShortcuts(false));
    document.addEventListener('mousedown', (e) => {
      if (shortcutsOpen && !e.target.closest('#shortcutsPanel') && !e.target.closest('#btnShortcuts')) {
        toggleShortcuts(false);
      }
    });

    // Reference
    $('#btnImportRef').addEventListener('click', importReference);
    $('#refImageInput').addEventListener('change', handleRefImageLoad);
    $('#btnInsertImage').addEventListener('click', insertImage);
    $('#insertImageInput').addEventListener('change', handleInsertImageLoad);
    $('#btnToggleRef').addEventListener('click', toggleReference);
    $('#btnRefPopout').addEventListener('click', openReferenceWindow);
    $('#refOpacity').addEventListener('input', (e) => {
      state.refOpacity = parseInt(e.target.value) / 100;
      $('#refOpacityVal').textContent = e.target.value + '%';
      scheduleRender();
      scheduleRefStatePublish();
    });

    // Recording
    $('#btnStartRecord').addEventListener('click', startRecording);
    $('#btnStopRecord').addEventListener('click', stopRecording);

    // Layers
    const activeParentGroup = () => {
      const n = getActiveNode();
      if (n && isGroupNode(n)) return n;
      const l = findParentOf(state.activeLayerId);
      return l ? l.parent : null;
    };
    $('#btnAddLayer').addEventListener('click', () => { createLayer(undefined, activeParentGroup()); showToast('Layer created'); });
    $('#btnAddFolder').addEventListener('click', () => { createGroup(undefined, null); showToast('Folder created'); });
    $('#btnDupLayer').addEventListener('click', () => { if (state.activeLayerId != null) duplicateNode(state.activeLayerId); });
    $('#btnDelLayer').addEventListener('click', () => { if (state.activeLayerId != null) deleteNode(state.activeLayerId); });
    $('#btnLayerUp').addEventListener('click', () => moveNode(state.activeLayerId, -1));
    $('#btnLayerDown').addEventListener('click', () => moveNode(state.activeLayerId, 1));
    $('#activeLayerOpacity').addEventListener('input', (e) => {
      const node = getActiveNode();
      if (!node) return;
      node.opacity = parseInt(e.target.value) / 100;
      setNumVal($('#activeLayerOpacityVal'), e.target.value);
      scheduleRender();
      queueSave();
    });

    // Link the layer opacity numeric field to its slider (two-way, validated)
    bindNumberPair('#activeLayerOpacityVal', '#activeLayerOpacity');

    // Color
    $('#colorPicker').addEventListener('input', (e) => setColor(e.target.value));
    $('#colorHex').addEventListener('change', (e) => {
      let v = e.target.value.trim();
      if (v.charAt(0) !== '#') v = '#' + v;
      if (/^#[0-9a-fA-F]{6}$/.test(v)) setColor(v);
      else e.target.value = state.brushColor.toUpperCase();
    });
    $('#colorSwatch').addEventListener('click', () => $('#colorPicker').click());
    $('#brushPreview').addEventListener('click', () => $('#colorPicker').click());

    // Brush size / opacity
    $('#brushSize').addEventListener('input', (e) => {
      state.brushSize = parseInt(e.target.value);
      setNumVal($('#brushSizeVal'), e.target.value);
      updateBrushCursor();
      drawFadePreview();
      drawBrushTipPreview();
      if (state.tool === 'curve') renderOverlay();
      queueSave();
    });
    $('#brushOpacity').addEventListener('input', (e) => {
      state.brushOpacity = parseInt(e.target.value) / 100;
      setNumVal($('#brushOpacityVal'), e.target.value);
      drawFadePreview();
      drawBrushTipPreview();
      if (state.tool === 'curve') renderOverlay();
      queueSave();
    });
    $('#brushStabilizer').addEventListener('input', (e) => {
      state.stabilization = parseInt(e.target.value) / 100;
      $('#brushStabilizerVal').textContent = e.target.value + '%';
      queueSave();
    });
    $('#checkFadeEnds').addEventListener('change', (e) => {
      const on = e.target.checked;
      if (state.fade) {
        if (state.fade.brush) state.fade.brush.enabled = on;
        if (state.fade.eraser) state.fade.eraser.enabled = on;
      }
      getFadeSettings().enabled = on;
      try { if (typeof localStorage !== 'undefined') localStorage.setItem('artee.forceFade', on ? '1' : '0'); } catch (ex) {}
      updateToolSettingsPanel();
      drawFadePreview();
      queueSave();
    });
    FADE_SLIDERS.forEach(([sel, key, valSel]) => {
      const el = $(sel);
      if (!el) return;
      el.addEventListener('input', (e) => {
      const v = parseInt(e.target.value);
      getFadeSettings()[key] = v;
      setNumVal($(valSel), v);
      drawFadePreview();
      try {
        if (typeof localStorage !== 'undefined') {
          if (key === 'start') localStorage.setItem('artee.fadeStart', String(v));
          else if (key === 'end') localStorage.setItem('artee.fadeEnd', String(v));
          else if (key === 'length') localStorage.setItem('artee.fadeLength', String(v));
          else if (key === 'minThickness') localStorage.setItem('artee.fadeMinThickness', String(v));
          else if (key === 'minOpacity') localStorage.setItem('artee.fadeMinOpacity', String(v));
        }
      } catch (ex) {}
      queueSave();
    });
    });

    // Link each numeric field to its slider (two-way, range-validated)
    [
      ['#brushSizeVal', '#brushSize'],
      ['#brushOpacityVal', '#brushOpacity'],
      ['#fadeStartVal', '#fadeStart'],
      ['#fadeEndVal', '#fadeEnd'],
      ['#fadeLengthVal', '#fadeLength'],
      ['#fadeMinThicknessVal', '#fadeMinThickness'],
      ['#fadeMinOpacityVal', '#fadeMinOpacity'],
      ['#fillToleranceVal', '#fillTolerance'],
      ['#shapeLineWidthVal', '#shapeLineWidth'],
      ['#wandToleranceVal', '#wandTolerance'],
      ['#wandFeatherVal', '#wandFeather'],
    ].forEach(([num, range]) => bindNumberPair(num, range));

    // Brush-type specific controls
    [
      ['#brushHardness', 'hardness', '#brushHardnessVal'],
      ['#brushSpacing', 'spacing', '#brushSpacingVal'],
      ['#brushFlow', 'flow', '#brushFlowVal'],
      ['#brushScatter', 'scatter', '#brushScatterVal'],
    ].forEach(([sel, key, valSel]) => {
      const el = $(sel);
      if (!el) return;
      el.addEventListener('input', (e) => {
        const v = parseInt(e.target.value);
        getBrushState()[key] = v / 100;
        setNumVal($(valSel), v);
        drawBrushTipPreview();
        queueSave();
      });
    });
    [
      ['#brushHardnessVal', '#brushHardness'],
      ['#brushSpacingVal', '#brushSpacing'],
      ['#brushFlowVal', '#brushFlow'],
      ['#brushScatterVal', '#brushScatter'],
    ].forEach(([num, range]) => bindNumberPair(num, range));

    // Filters / Effects
    const filterValue = $('#filterValue');
    if (filterValue) {
      filterValue.addEventListener('input', (e) => {
        const v = parseInt(e.target.value);
        filterState.value = v;
        setNumVal($('#filterValueVal'), v);
        renderFilterPreview();
      });
    }
    bindNumberPair('#filterValueVal', '#filterValue');
    { const b = $('#btnFilterPreview'); if (b) b.addEventListener('click', () => { renderFilterPreview(); showToast('Preview updated'); }); }
    { const b = $('#btnFilterApply'); if (b) b.addEventListener('click', applyFilterSession); }
    { const b = $('#btnFilterReset'); if (b) b.addEventListener('click', resetFilterSession); }
    { const b = $('#btnFilterCancel'); if (b) b.addEventListener('click', cancelFilterSession); }

    // Fade Shape controls
    $$('#fadeShapeControls [data-fshape]').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('#fadeShapeControls [data-fshape]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        fadeShapeState.shape = btn.dataset.fshape;
      });
    });
    $$('#fadeShapeControls [data-fmode]').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('#fadeShapeControls [data-fmode]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        fadeShapeState.fillMode = btn.dataset.fmode;
      });
    });
    $('#fadeSoftness').addEventListener('input', (e) => {
      fadeShapeState.feather = parseInt(e.target.value);
      $('#fadeSoftnessVal').textContent = e.target.value + ' px';
    });

    // BÃ©zier controls
    $('#btnCurveModeLine').addEventListener('click', () => {
      curveState.isClosed = false;
      $('#btnCurveModeLine').classList.add('active');
      $('#btnCurveModeShape').classList.remove('active');
      $('#btnToggleCloseCurve').textContent = 'Close';
      renderOverlay();
    });
    $('#btnCurveModeShape').addEventListener('click', () => {
      curveState.isClosed = true;
      $('#btnCurveModeShape').classList.add('active');
      $('#btnCurveModeLine').classList.remove('active');
      $('#btnToggleCloseCurve').textContent = 'Open';
      renderOverlay();
    });
    $('#checkCurveStroke').addEventListener('change', (e) => { curveState.strokeShape = e.target.checked; renderOverlay(); });
    $('#checkCurveFill').addEventListener('change', (e) => { curveState.fillShape = e.target.checked; renderOverlay(); });
    $('#btnCommitCurve').addEventListener('click', commitCurveToLayer);
    $('#btnToggleCloseCurve').addEventListener('click', toggleCloseCurve);
    $('#btnDeleteLastCurvePoint').addEventListener('click', deleteLastCurvePoint);
    $('#btnClearCurve').addEventListener('click', clearCurve);

    // Shape / ruler controls
    $('#shapeFill').addEventListener('change', (e) => { shapeState.fill = e.target.checked; });
    $('#shapeStroke').addEventListener('change', (e) => { shapeState.stroke = e.target.checked; });
    $('#shapeLineWidth').addEventListener('input', (e) => {
      shapeState.lineWidth = parseInt(e.target.value);
      setNumVal($('#shapeLineWidthVal'), e.target.value);
    });

    // Magic wand controls
    $('#wandTolerance').addEventListener('input', (e) => {
      wandState.tolerance = parseInt(e.target.value);
      setNumVal($('#wandToleranceVal'), e.target.value);
      updateWandStatus();
    });
    $('#wandFeather').addEventListener('input', (e) => {
      wandState.feather = parseInt(e.target.value);
      setNumVal($('#wandFeatherVal'), e.target.value);
      updateWandStatus();
    });
    $$('#wandSampleChips .chip').forEach(chip => {
      chip.addEventListener('click', () => {
        $$('#wandSampleChips .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        wandState.sampleAll = chip.dataset.sample === 'all';
      });
    });
    const wandDeselect = $('#btnWandDeselect');
    if (wandDeselect) wandDeselect.addEventListener('click', clearSelection);

    // Fill controls
    $('#fillTolerance').addEventListener('input', (e) => {
      fillState.tolerance = parseInt(e.target.value);
      setNumVal($('#fillToleranceVal'), e.target.value);
    });
    $('#fillContiguous').addEventListener('change', (e) => { fillState.contiguous = e.target.checked; });
    $('#fillEightWay').addEventListener('change', (e) => { fillState.eightWay = e.target.checked; });
    $('#fillPixelArt').addEventListener('change', (e) => {
      fillState.pixelArt = e.target.checked;
      const tol = $('#fillTolerance'), tolVal = $('#fillToleranceVal');
      if (tol) tol.disabled = e.target.checked;
      if (tolVal) tolVal.disabled = e.target.checked;
    });
    $$('#fillSampleChips .chip').forEach(chip => {
      chip.addEventListener('click', () => {
        $$('#fillSampleChips .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        fillState.sampleAll = chip.dataset.sample === 'all';
      });
    });

    // Text controls
    $('#textSize').addEventListener('input', (e) => {
      textState.size = parseInt(e.target.value);
      $('#textSizeVal').textContent = e.target.value + ' px';
    });
    $$('#textControls [data-textstyle]').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('#textControls [data-textstyle]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        textState.style = btn.dataset.textstyle;
      });
    });
    const textInput = $('#textInput');
    textInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commitText(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelText(); }
    });
    textInput.addEventListener('blur', () => { if (textState.editing) commitText(); });

    // Selection controls
    $('#btnDeselect').addEventListener('click', clearSelection);

    // Transform controls
    $('#checkRefLocked').addEventListener('change', (e) => {
      state.refLocked = e.target.checked;
      updateLayerList();
      updateCanvasHint();
      renderOverlay();
    });
    $('#btnRefResetTransform').addEventListener('click', resetRefTransform);
    $('#btnRefFitTransform').addEventListener('click', () => {
      if (!state.refImage) { showToast('No reference image loaded', 'error'); return; }
      fitRefToCanvas(false);
      state.refX = state.docWidth / 2;
      state.refY = state.docHeight / 2;
      scheduleRender();
      renderOverlay();
    });

    // Move Layer controls
    const layerScaleInput = $('#layerScale');
    if (layerScaleInput) layerScaleInput.addEventListener('input', (e) => {
      if (!layerTransform.active) return;
      layerTransform.scale = Math.max(0.05, Math.min(20, Number(e.target.value) / 100));
      applyLayerTransformToLayer();
      syncLayerTransformUI();
      renderOverlay();
    });
    const layerRotInput = $('#layerRotation');
    if (layerRotInput) layerRotInput.addEventListener('input', (e) => {
      if (!layerTransform.active) return;
      layerTransform.rotation = Number(e.target.value) * Math.PI / 180;
      applyLayerTransformToLayer();
      syncLayerTransformUI();
      renderOverlay();
    });
    const btnLayerApply = $('#btnLayerApply');
    if (btnLayerApply) btnLayerApply.addEventListener('click', applyLayerTransformEdit);
    const btnLayerReset = $('#btnLayerReset');
    if (btnLayerReset) btnLayerReset.addEventListener('click', resetLayerTransform);
    const btnLayerCancel = $('#btnLayerCancel');
    if (btnLayerCancel) btnLayerCancel.addEventListener('click', cancelLayerTransformEdit);

    // Zoom
    $('#btnZoomIn').addEventListener('click', () => {
      const rect = canvasViewport.getBoundingClientRect();
      setZoom(state.zoom * 1.25, rect.width / 2, rect.height / 2);
    });
    $('#btnZoomOut').addEventListener('click', () => {
      const rect = canvasViewport.getBoundingClientRect();
      setZoom(state.zoom / 1.25, rect.width / 2, rect.height / 2);
    });
    $('#btnZoomFit').addEventListener('click', fitCanvasToView);
    $('#btnZoomReset').addEventListener('click', zoomReset);

    // Canvas pointer events (mouse + pen/stylus hover & contact; touch is
    // handled by the touch listeners below so it is not processed twice).
    canvasViewport.addEventListener('pointerdown', onCanvasPointerDown);
    window.addEventListener('pointermove', onCanvasPointerMove);
    window.addEventListener('pointerup', onCanvasPointerUp);
    canvasViewport.addEventListener('pointercancel', onCanvasPointerUp);
    canvasViewport.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'touch') return;
      if (state.tool === 'brush' || state.tool === 'eraser') brushCursorEl.style.display = 'block';
      moveBrushCursor(e.clientX, e.clientY);
    });
    canvasViewport.addEventListener('pointerleave', () => {
      if (brushCursorEl) brushCursorEl.style.display = 'none';
      if (cursorPosEl) cursorPosEl.textContent = '';
    });
    canvasViewport.addEventListener('wheel', onCanvasWheel, { passive: false });

    // Touch
    canvasViewport.addEventListener('touchstart', onTouchStart, { passive: false });
    canvasViewport.addEventListener('touchmove', onTouchMove, { passive: false });
    canvasViewport.addEventListener('touchend', onTouchEnd);
    // iOS fires touchcancel (not touchend) when a system gesture or palm
    // interrupts the touch; without this the gesture flags stay stuck and the
    // canvas appears frozen. Finalize through the same path as touchend.
    canvasViewport.addEventListener('touchcancel', onTouchEnd);
    window.addEventListener('touchmove', (e) => {
      if (state.isDrawing) e.preventDefault();
    }, { passive: false });

    // Keyboard
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('resize', () => { renderOverlay(); updateBrushCursor(); scheduleOutputUpdate(); drawFadePreview(); drawBrushTipPreview(); });
    canvasViewport.addEventListener('contextmenu', (e) => e.preventDefault());

    // Persist before the tab is hidden/closed
    window.addEventListener('pagehide', () => saveNow(true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveNow(true);
    });

    // â”€â”€â”€ My Gallery â”€â”€â”€
    const newBtn = $('#btnGalleryNew');
    if (newBtn) newBtn.addEventListener('click', createNewProject);
    const newEmptyBtn = $('#btnGalleryNewEmpty');
    if (newEmptyBtn) newEmptyBtn.addEventListener('click', createNewProject);

    // â”€â”€â”€ Modal (confirm / rename) â”€â”€â”€
    const modalConfirm = $('#modalConfirm');
    if (modalConfirm) modalConfirm.addEventListener('click', () => {
      const input = $('#modalInput');
      if (input && !input.classList.contains('hidden')) closeModal(input.value);
      else closeModal(true);
    });
    const modalCancel = $('#modalCancel');
    if (modalCancel) modalCancel.addEventListener('click', () => closeModal(null));
    const modalOverlay = $('#modalOverlay');
    if (modalOverlay) modalOverlay.addEventListener('mousedown', (e) => {
      if (e.target === modalOverlay) closeModal(null);
    });
    const modalInput = $('#modalInput');
    if (modalInput) modalInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); closeModal(e.target.value); }
      else if (e.key === 'Escape') { e.preventDefault(); closeModal(null); }
    });
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     CANVAS POINTER & TOUCH EVENTS
     Supports Mouse, Touch, and Apple Pencil (stylus) with high-frequency
     coalesced event capture (120Hz/240Hz) and multi-touch gestures.
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  const activePointers = new Map();
  const strokeDocScratch = { x: 0, y: 0 };

  // Pointer handlers only enqueue raw screen samples. All smoothing, path
  // building and canvas compositing happens in processStrokeFrame(), once per
  // animation frame, no matter how many pointer/coalesced events arrived.
  function queueStrokePoint(clientX, clientY) {
    if (!state.isDrawing) return;
    if (strokeInputCount >= STROKE_INPUT_CAP) {
      strokeInputHead = (strokeInputHead + 1) % STROKE_INPUT_CAP;
      strokeInputCount--;
    }
    const idx = ((strokeInputHead + strokeInputCount) % STROKE_INPUT_CAP) * 2;
    strokeInput[idx] = clientX;
    strokeInput[idx + 1] = clientY;
    strokeInputCount++;
    if (!strokeFrameRAF) strokeFrameRAF = requestAnimationFrame(processStrokeFrame);
  }

  function flushStrokeFrame(layer, frameBox) {
    if (isFadeStroke()) {
      flushFadeStroke();
    } else if (stampState.active) {
      if (stampState.fade) repaintFadeStamps();
      stampRenderNow(frameBox);
    } else {
      compositeStrokeBufferToLayer(layer, frameBox);
    }
    if (renderQueued) flushRender();
  }

  function processStrokeFrame() {
    strokeFrameRAF = 0;
    if (!state.isDrawing) { clearStrokeInput(); return; }
    const layer = getActiveLayer();
    if (!layer) { clearStrokeInput(); return; }
    strokeFrameBBox = null;
    const rect = canvasViewport.getBoundingClientRect();
    while (strokeInputCount > 0) {
      const idx = strokeInputHead * 2;
      const sx = strokeInput[idx];
      const sy = strokeInput[idx + 1];
      strokeInputHead = (strokeInputHead + 1) % STROKE_INPUT_CAP;
      strokeInputCount--;
      screenToDocInto(sx, sy, strokeDocScratch, rect);
      continueStroke(strokeDocScratch.x, strokeDocScratch.y, true);
    }
    flushStrokeFrame(layer, strokeFrameBBox);
    strokeFrameBBox = null;
  }

  function onCanvasPointerDown(e) {
    pointerIsTouch = (e.pointerType === 'touch' || e.pointerType === 'pen');
    if (e.pointerType === 'touch' && brushCursorEl) brushCursorEl.style.display = 'none';

    activePointers.set(e.pointerId, {
      clientX: e.clientX,
      clientY: e.clientY,
      pointerType: e.pointerType,
    });

    // Two-finger gesture detection for touch (pinch zoom & twist)
    if (activePointers.size === 2) {
      const pts = Array.from(activePointers.values());
      if (pts[0].pointerType === 'touch' && pts[1].pointerType === 'touch') {
        if (state.isPanning) stopPan();
        if (state.isDrawing) {
          if (state.points.length <= 1) cancelStroke();
          else endStroke();
        }
        const rect = canvasViewport.getBoundingClientRect();
        pinch.active = true;
        pinch.lastDist = Math.hypot(pts[1].clientX - pts[0].clientX, pts[1].clientY - pts[0].clientY) || 1;
        pinch.lastAngle = Math.atan2(pts[1].clientY - pts[0].clientY, pts[1].clientX - pts[0].clientX);
        pinch.lastX = (pts[0].clientX + pts[1].clientX) / 2 - rect.left;
        pinch.lastY = (pts[0].clientY + pts[1].clientY) / 2 - rect.top;
        return;
      }
    }
    if (activePointers.size > 2) return;
    if (pinch.active) return;

    try { canvasViewport.setPointerCapture(e.pointerId); } catch (ex) {}

    if (e.button === 1 || (e.button === 0 && state.spaceHeld)) {
      startPan(e.clientX, e.clientY);
      e.preventDefault();
      return;
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return;

    const doc = screenToDoc(e.clientX, e.clientY);
    switch (state.tool) {
      case 'brush':
      case 'eraser':
        beginStroke(doc.x, doc.y);
        break;
      case 'fill':
        floodFill(doc.x, doc.y);
        break;
      case 'text':
        beginText(e.clientX, e.clientY);
        break;
      case 'fade-shape': {
        if (!canEditActive()) return;
        fadeShapeState.isDrawing = true;
        fadeShapeState.startX = doc.x;
        fadeShapeState.startY = doc.y;
        fadeShapeState.currentX = doc.x;
        fadeShapeState.currentY = doc.y;
        break;
      }
      case 'curve': {
        if (curveState.step === 0) {
          // Step 1: pick start point and begin dragging to end point
          curveState.step = 1;
          curveState.p0 = { x: doc.x, y: doc.y };
          curveState.p1 = { x: doc.x, y: doc.y };
          curveState.cp = { x: doc.x, y: doc.y };
          curveState.isPulling = false;
          updateCurveStatus();
          renderOverlay();
        } else if (curveState.step === 2) {
          // Step 2: pointerdown to pull control point curve
          curveState.isPulling = true;
          curveState.cp = { x: doc.x, y: doc.y };
          renderOverlay();
        }
        break;
      }
      case 'transform':
        startTransformDrag(e.clientX, e.clientY);
        break;
      case 'layer-transform':
        startLayerTransformDrag(e.clientX, e.clientY);
        break;
      case 'select':
        selectState.active = false;
        selectState.maskCanvas = null;
        selectState.maskEdgeCanvas = null;
        selectState.isSelecting = true;
        selectState.startX = doc.x;
        selectState.startY = doc.y;
        selectState.x = doc.x;
        selectState.y = doc.y;
        selectState.w = 0;
        selectState.h = 0;
        break;
      case 'rect':
      case 'ellipse':
      case 'line':
        if (!canEditActive()) return;
        shapeState.isDrawing = true;
        shapeState.startX = doc.x; shapeState.startY = doc.y;
        shapeState.curX = doc.x; shapeState.curY = doc.y;
        shapeState.shift = !!e.shiftKey;
        break;
      case 'wand':
        magicWandSelect(doc.x, doc.y);
        break;
      case 'eyedropper':
        pickColor(doc.x, doc.y);
        break;
      case 'zoom': {
        const rect = canvasViewport.getBoundingClientRect();
        const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
        if (state.altHeld) setZoom(state.zoom / 1.5, cx, cy);
        else setZoom(state.zoom * 1.5, cx, cy);
        break;
      }
      case 'move':
        startPan(e.clientX, e.clientY);
        break;
    }
  }

  function onCanvasPointerMove(e) {
    const tracked = activePointers.get(e.pointerId);
    if (tracked) {
      tracked.clientX = e.clientX;
      tracked.clientY = e.clientY;
      tracked.pointerType = e.pointerType;
    }

    // Two-finger pinch & rotate update
    if (pinch.active && activePointers.size >= 2) {
      const it = activePointers.values();
      const t0 = it.next().value, t1 = it.next().value;
      const rect = canvasViewport.getBoundingClientRect();
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY) || 1;
      const mx = (t0.clientX + t1.clientX) / 2 - rect.left;
      const my = (t0.clientY + t1.clientY) / 2 - rect.top;

      const angle = Math.atan2(t1.clientY - t0.clientY, t1.clientX - t0.clientX);
      let dRot = angle - pinch.lastAngle;
      if (dRot > Math.PI) dRot -= Math.PI * 2;
      else if (dRot < -Math.PI) dRot += Math.PI * 2;
      if (Math.abs(dRot) > 0.6) dRot = 0;
      if (dRot) {
        const c = Math.cos(dRot), s = Math.sin(dRot);
        const ox = mx - state.panX, oy = my - state.panY;
        state.panX += ox - (ox * c - oy * s);
        state.panY += oy - (ox * s + oy * c);
        state.viewRot += dRot;
      }
      pinch.lastAngle = angle;

      const next = Math.max(0.05, Math.min(32, state.zoom * (dist / pinch.lastDist)));
      const ratio = next / state.zoom;
      state.panX = mx - (mx - state.panX) * ratio + (mx - pinch.lastX);
      state.panY = my - (my - state.panY) * ratio + (my - pinch.lastY);
      state.zoom = next;
      updateCanvasTransform();

      pinch.lastDist = dist;
      pinch.lastX = mx;
      pinch.lastY = my;
      return;
    }
    if (pinch.active) return;

    if (state.isPanning) {
      state.panX = state.panStartPanX + (e.clientX - state.panStartX);
      state.panY = state.panStartPanY + (e.clientY - state.panStartY);
      updateCanvasTransform();
      return;
    }

    // High-frequency capture: enqueue raw samples only. No object allocation,
    // no getBoundingClientRect(), and no drawing in the event callback.
    if (state.isDrawing && (state.tool === 'brush' || state.tool === 'eraser')) {
      const coalesced = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : null;
      if (coalesced && coalesced.length > 0) {
        for (let i = 0; i < coalesced.length; i++) {
          const ce = coalesced[i];
          queueStrokePoint(ce.clientX, ce.clientY);
        }
      } else {
        queueStrokePoint(e.clientX, e.clientY);
      }
      return;
    }

    const doc = screenToDocInto(e.clientX, e.clientY, strokeDocScratch);
    if (cursorPosEl) {
      if (doc.x >= 0 && doc.y >= 0 && doc.x < state.docWidth && doc.y < state.docHeight) {
        cursorPosEl.textContent = Math.round(doc.x) + ', ' + Math.round(doc.y);
      } else {
        cursorPosEl.textContent = '';
      }
    }

    if (e.pointerType !== 'touch') moveBrushCursor(e.clientX, e.clientY);

    if (state.tool === 'transform' && transformState.dragging) {
      updateTransformDrag(e.clientX, e.clientY);
      return;
    }
    if (state.tool === 'layer-transform' && layerTransform.dragging) {
      updateLayerTransformDrag(e.clientX, e.clientY);
      return;
    }
    if (state.tool === 'select' && selectState.isSelecting) {
      selectState.x = doc.x;
      selectState.y = doc.y;
      normalizeSelection();
      updateSelectStatus();
      renderOverlay();
      return;
    }
    if ((state.tool === 'rect' || state.tool === 'ellipse' || state.tool === 'line') && shapeState.isDrawing) {
      shapeState.curX = doc.x;
      shapeState.curY = doc.y;
      shapeState.shift = !!e.shiftKey;
      renderOverlay();
      return;
    }
    if (state.tool === 'fade-shape' && fadeShapeState.isDrawing && overlayCtx) {
      fadeShapeState.currentX = doc.x;
      fadeShapeState.currentY = doc.y;
      overlayCtx.clearRect(0, 0, state.docWidth, state.docHeight);
      drawFadeShape(overlayCtx, fadeShapeState.startX, fadeShapeState.startY, doc.x, doc.y, true);
      if (selectState.active && selectState.kind === 'rect') drawSelectionAnts();
      else if (wandActive()) drawWandOverlay();
      return;
    }
    if (state.tool === 'curve') {
      if (curveState.step === 1) {
        // Dragging to end point
        curveState.p1 = { x: doc.x, y: doc.y };
        curveState.cp = { x: (curveState.p0.x + doc.x) / 2, y: (curveState.p0.y + doc.y) / 2 };
        renderOverlay();
      } else if (curveState.step === 2) {
        // Pulling control point
        if (curveState.isPulling || (e.pointerType !== 'touch' && !state.isDrawing)) {
          curveState.cp = { x: doc.x, y: doc.y };
          renderOverlay();
        }
      }
    }
  }

  function onCanvasPointerUp(e) {
    try { canvasViewport.releasePointerCapture(e.pointerId); } catch (ex) {}
    activePointers.delete(e.pointerId);

    if (pinch.active) {
      if (activePointers.size < 2) pinch.active = false;
      return;
    }

    if (state.isPanning) { stopPan(); return; }
    if (state.isDrawing) { endStroke(); return; }

    if (state.tool === 'transform' && transformState.dragging) {
      endTransformDrag();
      renderOverlay();
      return;
    }
    if (state.tool === 'layer-transform' && layerTransform.dragging) {
      endLayerTransformDrag();
      renderOverlay();
      return;
    }
    if (state.tool === 'select' && selectState.isSelecting) {
      selectState.isSelecting = false;
      if (selectState.w < 3 || selectState.h < 3) {
        clearSelection();
      } else {
        selectState.active = true;
        selectState.kind = 'rect';
        selectState.maskCanvas = null;
        selectState.maskEdgeCanvas = null;
        normalizeSelection();
        startSelectionAnimation();
        renderOverlay();
        showToast('Selection active');
      }
      updateSelectStatus();
      updateWandStatus();
      return;
    }
    if ((state.tool === 'rect' || state.tool === 'ellipse' || state.tool === 'line') && shapeState.isDrawing) {
      shapeState.isDrawing = false;
      commitShape();
      renderOverlay();
      return;
    }
    if (state.tool === 'fade-shape' && fadeShapeState.isDrawing) {
      fadeShapeState.isDrawing = false;
      overlayCtx.clearRect(0, 0, state.docWidth, state.docHeight);
      const doc = screenToDoc(e.clientX, e.clientY);
      const w = Math.abs(doc.x - fadeShapeState.startX);
      const h = Math.abs(doc.y - fadeShapeState.startY);
      if (w > 3 || h > 3) {
        const layer = getActiveLayer();
        if (layer) {
          pushUndo(layer);
          paintDelta(layer, (c) => drawFadeShape(c, fadeShapeState.startX, fadeShapeState.startY, doc.x, doc.y, false));
          sendRestore(layer, fadeShapeSyncBBox(fadeShapeState.startX, fadeShapeState.startY, doc.x, doc.y), layer.canvas);
          updateLayerThumbnail(layer.id);
          scheduleRender();
          showToast('Fade shape drawn');
        }
      }
      renderOverlay();
      return;
    }
    if (state.tool === 'curve') {
      const doc = screenToDoc(e.clientX, e.clientY);
      if (curveState.step === 1) {
        const dist = Math.hypot(doc.x - curveState.p0.x, doc.y - curveState.p0.y);
        if (dist < 4) {
          // Tap without drag: cancel
          curveState.step = 0;
          updateCurveStatus();
          renderOverlay();
        } else {
          // Transition to Step 2: pull to set control point
          curveState.p1 = { x: doc.x, y: doc.y };
          curveState.cp = { x: (curveState.p0.x + doc.x) / 2, y: (curveState.p0.y + doc.y) / 2 };
          curveState.step = 2;
          curveState.isPulling = false;
          updateCurveStatus();
          renderOverlay();
        }
        return;
      } else if (curveState.step === 2) {
        // Step 3: tap/release to commit to main canvas
        if (curveState.isPulling) {
          curveState.cp = { x: doc.x, y: doc.y };
          commitCurveToLayer();
        }
        return;
      }
    }
  }

  function startPan(x, y) {
    state.isPanning = true;
    state.panStartX = x;
    state.panStartY = y;
    state.panStartPanX = state.panX;
    state.panStartPanY = state.panY;
    canvasArea.classList.add('panning');
    updateBrushCursor();
  }

  function stopPan() {
    state.isPanning = false;
    canvasArea.classList.remove('panning');
  }

  function onCanvasWheel(e) {
    e.preventDefault();
    if (state.tool === 'layer-transform' && layerTransform.active && !e.ctrlKey) {
      const factor = e.deltaY < 0 ? 1.06 : 1 / 1.06;
      layerTransform.scale = Math.max(0.05, Math.min(20, layerTransform.scale * factor));
      scheduleLayerTransformRender();
      syncLayerTransformUI();
      renderOverlay();
      return;
    }
    const rect = canvasViewport.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setZoom(state.zoom * factor, cx, cy);
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     TOUCH EVENTS
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  // Two-finger gestures: pinch scales, drift pans. Single-finger drawing is
  // untouched, and one-finger touches never trigger this.
  const pinch = { active: false, lastDist: 0, lastX: 0, lastY: 0, lastAngle: 0 };

  function onTouchStart(e) {
    e.preventDefault();
    // Handled by onCanvasPointerDown via Pointer Events with coalesced events
  }

  function onTouchMove(e) {
    e.preventDefault();
    // Handled by onCanvasPointerMove via Pointer Events
  }

  function onTouchEnd(e) {
    e.preventDefault();
    // Handled by onCanvasPointerUp via Pointer Events
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     KEYBOARD
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function onKeyDown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    // The gallery (and its modal) owns the keyboard while it is on screen.
    if (galleryOpen) return;
    const modal = $('#modalOverlay');
    if (modal && !modal.classList.contains('hidden')) return;

    const shortcutsPanel = $('#shortcutsPanel');
    if (shortcutsPanel && !shortcutsPanel.classList.contains('hidden')) {
      if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); toggleShortcuts(false); }
      return;
    }
    if (e.key === '?') { e.preventDefault(); toggleShortcuts(); return; }

    if (e.key === ' ' && !state.spaceHeld) {
      e.preventDefault();
      state.spaceHeld = true;
      state.prevTool = state.tool;
      canvasArea.setAttribute('data-tool', 'move');
    }
    if (e.key === 'Alt') {
      state.altHeld = true;
      canvasArea.classList.add('alt-held');
    }

    if (e.key === 'Enter' && state.tool === 'layer-transform' && layerTransform.active) {
      e.preventDefault(); applyLayerTransformEdit(); return;
    }
    if (e.key === 'Enter' && state.tool === 'curve' && curveState.step === 2) {
      e.preventDefault(); commitCurveToLayer(); return;
    }
    // "A" immediately applies the BÃ©zier curve to the canvas.
    if ((e.key === 'a' || e.key === 'A') && state.tool === 'curve' && curveState.step === 2) {
      e.preventDefault(); commitCurveToLayer(); return;
    }
    if (e.key === 'Escape') {
      if (state.tool === 'layer-transform' && layerTransform.active) { e.preventDefault(); cancelLayerTransformEdit(); return; }
      if (state.tool === 'curve' && curveState.step > 0) { e.preventDefault(); clearCurve(); return; }
      if (selectState.active) { e.preventDefault(); clearSelection(); return; }
      if (textState.editing) { e.preventDefault(); cancelText(); return; }
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && state.tool === 'curve' && curveState.step > 0) {
      e.preventDefault(); clearCurve(); return;
    }

    if (e.ctrlKey || e.metaKey) {
      if (e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(false); return; }
      if (e.key.toLowerCase() === 'h' && e.shiftKey) { e.preventDefault(); togglePrivacy(); return; }
      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (state.tool === 'curve' && curveState.step > 0) { clearCurve(); return; }
        undo();
      }
      else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); redo(); }
      return;
    }

    if (e.key === '`' || e.key === 'Backquote') {
      if (state.refImage) { e.preventDefault(); toggleReference(); }
      return;
    }

    switch (e.key.toLowerCase()) {
      case 'b': selectTool('brush'); break;
      case 'c': selectTool('curve'); break;
      case 'f': selectTool('fill'); break;
      case 'e': selectTool('eraser'); break;
      case 'g': selectTool('move'); break;
      case 't': selectTool('text'); break;
      case 's': selectTool('select'); break;
      case 'm': selectTool('layer-transform'); break;
      case 'r': selectTool('transform'); break;
      case 'i': selectTool('eyedropper'); break;
      case 'z': selectTool('zoom'); break;
      case 'h': selectTool('fade-shape'); break;
      case 'o': selectTool('rect'); break;
      case 'u': selectTool('ellipse'); break;
      case 'l': selectTool('line'); break;
      case 'w': selectTool('wand'); break;
      case '=': case '+': {
        const rect = canvasViewport.getBoundingClientRect();
        setZoom(state.zoom * 1.25, rect.width / 2, rect.height / 2);
        break;
      }
      case '-': {
        const rect = canvasViewport.getBoundingClientRect();
        setZoom(state.zoom / 1.25, rect.width / 2, rect.height / 2);
        break;
      }
      case '[':
        state.brushSize = Math.max(1, state.brushSize - (state.brushSize > 20 ? 5 : 1));
        $('#brushSize').value = state.brushSize;
        setNumVal($('#brushSizeVal'), state.brushSize);
        updateBrushCursor();
        if (state.tool === 'curve') renderOverlay();
        break;
      case ']':
        state.brushSize = Math.min(400, state.brushSize + (state.brushSize >= 20 ? 5 : 1));
        $('#brushSize').value = state.brushSize;
        setNumVal($('#brushSizeVal'), state.brushSize);
        updateBrushCursor();
        if (state.tool === 'curve') renderOverlay();
        break;
    }
  }

  function onKeyUp(e) {
    if (e.key === ' ') {
      state.spaceHeld = false;
      if (state.isPanning) stopPan();
      if (state.prevTool) { selectTool(state.prevTool); state.prevTool = null; }
    }
    if (e.key === 'Alt') {
      state.altHeld = false;
      canvasArea.classList.remove('alt-held');
    }
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     CLEAR ACTIVE LAYER
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function clearActiveLayer() {
    const layer = getActiveLayer();
    if (!layer) return;
    if (nodeLocked(layer.id)) { showToast('Layer is locked', 'error'); return; }
    pushUndo(layer);
    layer.ctx.clearRect(0, 0, state.docWidth, state.docHeight);
    updateLayerThumbnail(layer.id);
    scheduleRender();
    wsSend({ type: 'clearlayer', cid: wsClientId, layerId: layer.id });
    showToast('Layer cleared');
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     TOAST NOTIFICATIONS
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  let toastTimeout = null;
  function showToast(msg, type) {
    let toast = document.querySelector('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.className = 'toast' + (type ? ' ' + type : '');
    void toast.offsetWidth;
    toast.classList.add('show');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { toast.classList.remove('show'); }, 2200);
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     KEYBOARD SHORTCUTS PANEL
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  let shortcutsOpen = false;

  function toggleShortcuts(force) {
    const panel = $('#shortcutsPanel');
    if (!panel) return;
    shortcutsOpen = (force === undefined) ? !shortcutsOpen : force;
    panel.classList.toggle('hidden', !shortcutsOpen);
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     UTILITY
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     PERSISTENCE  (IndexedDB â€” auto-save & restore)
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  const DB_NAME = 'artee-db';
  const DB_STORE = 'projects';
  const LEGACY_KEY = 'current';      // old single-slot save (migrated on first run)
  const META_PREFIX = 'meta:';       // gallery listing records (small: title, dates, thumb)
  const DATA_PREFIX = 'data:';       // full project payloads (layers, brush, reference)
  const THUMB_MAX = 480;             // longest edge of a generated gallery thumbnail
  const KV_CHUNK = 2 * 1024 * 1024;  // payloads above this upload in slices (server)
  let saveTimer = null;
  let saveBusy = false;
  let savePending = false;
  let saveFailCount = 0;
  let lastBasePayload = null;        // last saved data JSON â€” skips no-op writes
  let chunkApiOk = true;             // flipped off if the server predates /api/kv/chunk

  // Per-layer PNG cache. Encoding every layer on every save froze iOS for
  // seconds; layers now encode only when actually mutated (markLayerDirty),
  // and toBlob does the work off the main thread.
  const layerPngCache = new Map(); // layerId -> { data, dirty, gen }

  function markLayerDirty(id) {
    if (id == null) return;
    let e = layerPngCache.get(id);
    if (!e) {
      e = { data: null, dirty: true, gen: 0 };
      layerPngCache.set(id, e);
      return;
    }
    e.dirty = true;
    // gen captures mutations that land while an encode is in flight.
    e.gen++;
  }

  // Writes are queued (never dropped): each save serialises fresh state
  // immediately, then the IDB puts run in order. This means a "Back to
  // Gallery" save can never be skipped just because an autosave was in flight.
  let writeChain = Promise.resolve();
  function enqueueWrite(fn) {
    const p = writeChain.then(fn, fn);
    writeChain = p.catch(() => { });
    return p;
  }

  function makeId() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function metaKey(id) { return META_PREFIX + id; }
  function dataKey(id) { return DATA_PREFIX + id; }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     SHARED STORE  (phone server) with IndexedDB fallback
     When the app is served by phone-server.js, projects live in the server's
     data/ folder so every device sees the same gallery. Opened any other way
     (file://, plain static host) it keeps using this browser's IndexedDB.
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  let storageMode = 'idb'; // 'server' once /api/health answers

  async function detectServerStorage() {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        if (j && j.ok) { storageMode = 'server'; return true; }
      }
    } catch (e) { /* no Artee server â€” stay on IndexedDB */ }
    return false;
  }

  function srvKv(method, key, value) {
    const url = '/api/kv?key=' + encodeURIComponent(key);
    const opts = { method, headers: {} };
    if (method === 'POST') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify({ key, value });
    }
    return fetch(url, opts).then((r) => {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('store ' + method + ' ' + r.status);
      return r.json();
    });
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(DB_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbPut(key, value) {
    if (storageMode === 'server') return srvKv('POST', key, value).then(() => undefined);
    return openDB().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  function idbGet(key) {
    if (storageMode === 'server') return srvKv('GET', key).then((r) => (r ? r.value : undefined));
    return openDB().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const r = tx.objectStore(DB_STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  }

  function idbDelete(key) {
    if (storageMode === 'server') return srvKv('DELETE', key).then(() => undefined);
    return openDB().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  function idbGetAllKeys() {
    if (storageMode === 'server') {
      return fetch('/api/kv/keys', { cache: 'no-store' }).then((r) => {
        if (!r.ok) throw new Error('store keys ' + r.status);
        return r.json();
      }).then((j) => (j && j.keys) || []);
    }
    return openDB().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const r = tx.objectStore(DB_STORE).getAllKeys();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    }));
  }

  function fetchWithTimeout(url, opts, ms) {
    let ctrl = null;
    const o = Object.assign({}, opts || {});
    if (typeof AbortController !== 'undefined') {
      ctrl = new AbortController();
      o.signal = ctrl.signal;
    }
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { /* ignore */ } }, ms);
    return fetch(url, o).then(
      (r) => { clearTimeout(timer); return r; },
      (e) => { clearTimeout(timer); throw e; }
    );
  }

  // Large payloads upload in KV_CHUNK slices; the server appends them to a
  // temp file and atomically renames on the last chunk, so a multi-MB JSON
  // never blocks the main thread in one giant stringify/POST pair and a torn
  // write can never be observed by readers.
  async function srvKvPutChunked(key, json) {
    const total = Math.max(1, Math.ceil(json.length / KV_CHUNK));
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        for (let i = 0; i < total; i++) {
          const slice = json.slice(i * KV_CHUNK, (i + 1) * KV_CHUNK);
          const url = '/api/kv/chunk?key=' + encodeURIComponent(key) +
            '&i=' + i + '&total=' + total + '&off=' + (i * KV_CHUNK);
          const r = await fetchWithTimeout(url, {
            method: 'POST',
            body: new Blob([slice], { type: 'text/plain' }),
          }, 15000);
          if (r.status === 404) {
            // Older server without the chunk endpoint â€” fall back to classic.
            chunkApiOk = false;
            return idbPut(key, JSON.parse(json));
          }
          if (r.status === 409) throw new Error('chunk offset mismatch');
          if (!r.ok) throw new Error('chunk ' + r.status);
        }
        return;
      } catch (e) {
        if (attempt === 2) throw e;
        await nap(500 * (attempt + 1));
        // Retries restart from i=0; the server replaces its partial file.
      }
    }
  }

  function putProjectPayload(id, data, json) {
    if (storageMode === 'server' && chunkApiOk && json.length > KV_CHUNK) {
      return srvKvPutChunked(dataKey(id), json);
    }
    return idbPut(dataKey(id), data);
  }

  async function encodeLayerPng(node) {
    let entry = layerPngCache.get(node.id);
    if (!entry) {
      entry = { data: null, dirty: true, gen: 0 };
      layerPngCache.set(node.id, entry);
    }
    if (!entry.dirty && entry.data) return entry.data;
    entry.dirty = false;
    const gen = entry.gen;
    const data = await canvasToDataUrl(node.canvas, 'image/png');
    if (layerPngCache.get(node.id) !== entry) return data;
    if (entry.gen !== gen) entry.dirty = true; // mutated while encoding
    entry.data = data;
    return data;
  }

  async function serializeNode(node) {
    const out = {
      id: node.id,
      type: isGroupNode(node) ? 'group' : 'layer',
      name: node.name,
      visible: node.visible,
      locked: node.locked,
      opacity: node.opacity,
    };
    if (isGroupNode(node)) {
      out.expanded = !!node.expanded;
      out.children = [];
      for (const child of node.children) out.children.push(await serializeNode(child));
    } else {
      out.data = await encodeLayerPng(node);
    }
    return out;
  }

  function flattenNodeIds(nodes, acc) {
    acc = acc || [];
    for (const n of nodes) {
      acc.push(n.id);
      if (isGroupNode(n)) flattenNodeIds(n.children, acc);
    }
    return acc;
  }

  async function serializeProject() {
    const layers = [];
    for (const n of state.layers) layers.push(await serializeNode(n));
    return {
      version: 2,
      id: state.currentProjectId,
      title: state.currentProjectTitle,
      createdAt: state.projectCreatedAt,
      docWidth: state.docWidth,
      docHeight: state.docHeight,
      activeLayerId: state.activeLayerId,
      nextLayerId: state.nextLayerId,
      brush: {
        color: state.brushColor,
        size: state.brushSize,
        opacity: state.brushOpacity,
        stabilization: state.stabilization,
        fade: state.fade,
        type: state.brushType,
        settings: state.brushSettings,
      },
      outputFollowView: state.outputFollowView,
      view: { zoom: state.zoom, panX: state.panX, panY: state.panY, rot: state.viewRot },
      ref: state.refImage ? {
        data: state.refImage.src,
        x: state.refX, y: state.refY,
        scale: state.refScale,
        rotation: state.refRotation,
        opacity: state.refOpacity,
        visible: state.refVisible,
        locked: state.refLocked,
      } : null,
      layers,
    };
  }

  function setSaveStatus(text, kind) {
    const el = $('#saveStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'save-status show' + (kind ? ' ' + kind : '');
    clearTimeout(el._statusTimer);
    el._statusTimer = setTimeout(() => { el.className = 'save-status'; }, 2200);
  }

  // â”€â”€â”€ Thumbnail â”€â”€â”€
  // Composites the drawing (no reference) into a small canvas for the gallery.
  async function buildThumbnail() {
    try {
      const w = state.docWidth, h = state.docHeight;
      const scale = Math.min(1, THUMB_MAX / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * scale));
      c.height = Math.max(1, Math.round(h * scale));
      const ctx = c.getContext('2d');
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      drawNodes(ctx, state.layers, 0);
      return await canvasToDataUrl(c, 'image/jpeg', 0.72);
    } catch (e) {
      return null;
    }
  }

  // â”€â”€â”€ Save â”€â”€â”€
  // Persists the current project (payload + listing metadata) to IndexedDB.
  // Returns a promise that resolves true on success. Single-flight: a second
  // call while one is running coalesces into one follow-up save instead of
  // interleaving two serializes.
  async function saveNow(silent) {
    if (!state.currentProjectId || !state.layers.length) return false;
    if (saveBusy) { savePending = true; return true; }
    saveBusy = true;
    let ok = false;
    try {
      if (!state.projectCreatedAt) state.projectCreatedAt = Date.now();
      const savedAt = Date.now();
      const data = await serializeProject();
      data.savedAt = savedAt;
      const json = JSON.stringify(data);
      const meta = {
        id: state.currentProjectId,
        title: state.currentProjectTitle || 'Untitled',
        createdAt: state.projectCreatedAt,
        updatedAt: savedAt,
        docWidth: state.docWidth,
        docHeight: state.docHeight,
        layerCount: countLayerNodes(),
        thumb: await buildThumbnail(),
      };
      const id = state.currentProjectId;
      if (json !== lastBasePayload) {
        setSaveStatus('Savingâ€¦');
        await enqueueWrite(async () => {
          await putProjectPayload(id, data, json);
          await idbPut(metaKey(id), meta);
        });
        lastBasePayload = json;
        saveFailCount = 0;
        setSaveStatus('Saved', 'saved');
        if (!silent) showToast(storageMode === 'server' ? 'Artwork saved' : 'Artwork saved to this browser', 'success');
      } else {
        setSaveStatus('Saved', 'saved');
      }
      ok = true;
    } catch (err) {
      saveFailCount++;
      setSaveStatus('Save failed', 'error');
      if (!silent) showToast('Could not save (storage error)', 'error');
      ok = false;
    } finally {
      saveBusy = false;
      if (savePending) {
        savePending = false;
        saveNow(true);
      }
    }
    return ok;
  }

  function queueSave() {
    if (!state.currentProjectId || !state.layers.length || galleryOpen) return;
    if (saveTimer) clearTimeout(saveTimer);
    // Back off after failures instead of hammering a sick server.
    const delay = saveFailCount > 0 ? Math.min(30000, 2500 * Math.pow(2, saveFailCount)) : 2500;
    saveTimer = setTimeout(runQueuedSave, delay);
  }

  // True while any canvas gesture/edit is in progress. Serializing a project is
  // expensive (PNG-encodes layers), so it must never run mid-gesture or the
  // main thread stalls and drawing/panning/zooming appears to freeze.
  function isInteractionBusy() {
    return state.isDrawing || state.isPanning || pinch.active ||
      shapeState.isDrawing || fadeShapeState.isDrawing || selectState.isSelecting ||
      curveState.isDragging || transformState.dragging || layerTransform.dragging ||
      !!filterState.id;
  }

  function runQueuedSave() {
    if (isInteractionBusy()) { saveTimer = setTimeout(runQueuedSave, 1000); return; }
    const run = () => {
      if (isInteractionBusy()) { saveTimer = setTimeout(runQueuedSave, 1000); return; }
      saveNow(true);
    };
    // Encoding runs async (toBlob); start it only when the browser is idle.
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 2500 });
    else setTimeout(run, 0);
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     MY GALLERY  (multi-project manager)
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  function setLoading(on, text) {
    const el = $('#loadingOverlay');
    if (!el) return;
    if (text) { const t = $('#loadingText'); if (t) t.textContent = text; }
    el.classList.toggle('hidden', !on);
  }

  function updateProjectTitleUI() {
    const el = $('#currentProjectTitle');
    if (el) el.textContent = state.currentProjectTitle || '';
    document.title = (state.currentProjectTitle ? state.currentProjectTitle + ' â€” ' : '') +
      'Artee â€” Drawing & Tracing Studio';
  }

  function formatDate(ts) {
    if (!ts) return 'Never';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return 'Today, ' + time;
    const yest = new Date(now);
    yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return 'Yesterday, ' + time;
    return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) + ', ' + time;
  }

  async function loadProjectList() {
    let keys = [];
    try { keys = await idbGetAllKeys(); } catch (e) { return []; }
    const metas = [];
    for (const k of keys) {
      if (typeof k !== 'string' || k.indexOf(META_PREFIX) !== 0) continue;
      try {
        const m = await idbGet(k);
        if (m && m.id) metas.push(m);
      } catch (e) { /* skip unreadable record */ }
    }
    metas.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return metas;
  }

  function renderGallery(metas) {
    const grid = $('#galleryGrid');
    const empty = $('#galleryEmpty');
    const count = $('#galleryCount');
    if (!grid) return;

    grid.innerHTML = '';
    if (count) count.textContent = metas.length
      ? metas.length + (metas.length === 1 ? ' artwork' : ' artworks')
      : '';

    if (!metas.length) {
      grid.classList.add('hidden');
      if (empty) empty.classList.remove('hidden');
      return;
    }
    if (empty) empty.classList.add('hidden');
    grid.classList.remove('hidden');
    for (const m of metas) grid.appendChild(createGalleryCard(m));
  }

  const PENCIL_SVG = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" fill="currentColor"/></svg>';
  const TRASH_SVG = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" fill="currentColor"/></svg>';

  function createGalleryCard(meta) {
    const card = document.createElement('div');
    card.className = 'gallery-card';
    card.tabIndex = 0;
    card.dataset.projectId = meta.id;

    const thumb = document.createElement('div');
    thumb.className = 'gallery-thumb';
    if (meta.thumb) {
      const img = document.createElement('img');
      img.src = meta.thumb;
      img.alt = meta.title || 'Artwork';
      img.loading = 'lazy';
      thumb.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'gallery-thumb-empty';
      ph.innerHTML = '<svg viewBox="0 0 24 24" width="34" height="34"><path d="M7 14c-1.66 0-3 1.34-3 3 0 1.31-1.16 2-2 2 .92 1.22 2.49 2 4 2 2.21 0 4-1.79 4-4 0-1.66-1.34-3-3-3zm13.71-9.37l-1.34-1.34a.996.996 0 00-1.41 0L9 12.25 11.75 15l8.96-8.96a.996.996 0 000-1.41z" fill="currentColor"/></svg>';
      thumb.appendChild(ph);
    }
    card.appendChild(thumb);

    const info = document.createElement('div');
    info.className = 'gallery-card-info';
    const title = document.createElement('div');
    title.className = 'gallery-card-title';
    title.textContent = meta.title || 'Untitled';
    const date = document.createElement('div');
    date.className = 'gallery-card-date';
    date.textContent = formatDate(meta.updatedAt);
    info.appendChild(title);
    info.appendChild(date);
    card.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'gallery-card-actions';
    const renameBtn = document.createElement('button');
    renameBtn.className = 'gallery-icon-btn';
    renameBtn.title = 'Rename artwork';
    renameBtn.innerHTML = PENCIL_SVG;
    const delBtn = document.createElement('button');
    delBtn.className = 'gallery-icon-btn danger';
    delBtn.title = 'Delete artwork';
    delBtn.innerHTML = TRASH_SVG;
    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);
    card.appendChild(actions);

    const openIt = () => openProject(meta.id);
    card.addEventListener('click', openIt);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openIt(); }
    });
    renameBtn.addEventListener('click', (e) => { e.stopPropagation(); renameProject(meta); });
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); askDeleteProject(meta); });

    return card;
  }

  async function refreshGallery() {
    const metas = await loadProjectList();
    renderGallery(metas);
    return metas;
  }

  async function openGallery() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    toggleShortcuts(false);
    await refreshGallery();
    galleryOpen = true;
    const screen = $('#galleryScreen');
    if (screen) {
      screen.classList.remove('hidden');
      screen.setAttribute('aria-hidden', 'false');
    }
    document.body.classList.add('gallery-open');
  }

  function closeGallery() {
    galleryOpen = false;
    const screen = $('#galleryScreen');
    if (screen) {
      screen.classList.add('hidden');
      screen.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('gallery-open');
  }

  // Save everything and go back to the gallery grid.
  async function backToGallery() {
    if (state.currentProjectId) await saveNow(true);
    await openGallery();
  }

  // â”€â”€â”€ Project lifecycle â”€â”€â”€

  // Wipes the workspace so a project can be loaded (or created) cleanly.
  function resetWorkspace() {
    state.isDrawing = false;
    clearStrokeInput();
    releasePoints(state.points);
    state.points = [];
    state.undoStack = [];
    state.redoStack = [];
    strokeBBox = null;
    oneEuro.ready = false;
    updateHistoryButtons();

    // Layer ids restart per project; drop the encode cache and the no-op-save
    // comparison so a new project can never hit a stale entry.
    layerPngCache.clear();
    lastBasePayload = null;
    saveFailCount = 0;

    // Reference image
    state.refImage = null;
    state.refVisible = true;
    state.refLocked = false;
    state.refOpacity = 0.6;
    state.refX = 0; state.refY = 0;
    state.refScale = 1; state.refRotation = 0;
    const refInfo = $('#refInfo'); if (refInfo) refInfo.textContent = 'No reference loaded';
    const refOp = $('#refOpacity'); if (refOp) refOp.value = 60;
    const refOpVal = $('#refOpacityVal'); if (refOpVal) refOpVal.textContent = '60%';
    const refLock = $('#checkRefLocked'); if (refLock) refLock.checked = false;
    try { if (referenceIsPoppedOut()) closeReferenceWindow(true); } catch (e) { }

    // Transient tool states
    clearSelection();
    shapeState.isDrawing = false;
    curveState.points = [];
    curveState.selectedIdx = -1;
    curveState.dragTarget = null;
    layerTransform.active = false;
    layerTransform.layerId = null;
    layerTransform.snapshot = null;
    clearFilterSession();

    state.selectedNodeIds = new Set();
    state.activeLayerId = null;
    state.layers = [];
  }

  async function openProject(id) {
    setLoading(true, 'Opening artworkâ€¦');
    try {
      const data = await idbGet(dataKey(id));
      if (!data || !data.layers || !data.layers.length) {
        showToast('That artwork could not be found', 'error');
        await idbDelete(metaKey(id));
        await refreshGallery();
        return;
      }

      resetWorkspace();
      state.currentProjectId = id;
      state.currentProjectTitle = data.title || 'Untitled';
      state.projectCreatedAt = data.createdAt || data.savedAt || Date.now();

      await restoreProject(data);
      updateProjectTitleUI();
      // Ask the room for any newer live pixels â€” the save we just loaded can
      // trail another device's unsaved edits.
      wsSend({ type: 'sync-request', cid: wsClientId, pid: id });

      closeGallery();
      requestAnimationFrame(() => { fitCanvasToView(); renderOverlay(); compositeDisplay(); });
      showToast('Opened â€œ' + state.currentProjectTitle + 'â€', 'success');
    } catch (e) {
      showToast('Could not open that artwork', 'error');
    } finally {
      setLoading(false);
    }
  }

  async function nextUntitledTitle() {
    let metas = [];
    try { metas = await loadProjectList(); } catch (e) { metas = []; }
    const used = new Set(metas.map((m) => m.title));
    const base = metas.length + 1;
    let i = base;
    while (used.has('Untitled ' + i)) i++;
    return 'Untitled ' + i;
  }

  async function createNewProject() {
    if (state.currentProjectId) await saveNow(true);
    setLoading(true, 'Creating canvasâ€¦');
    try {
      resetWorkspace();
      const id = makeId();
      state.currentProjectId = id;
      state.currentProjectTitle = await nextUntitledTitle();
      state.projectCreatedAt = Date.now();

      createLayer('Layer 1');
      setColor(state.brushColor);
      updateProjectTitleUI();

      closeGallery();
      requestAnimationFrame(() => { fitCanvasToView(); renderOverlay(); });
      await saveNow(true); // persist the blank project so it shows in the gallery
      showToast('New canvas created', 'success');
    } catch (e) {
      showToast('Could not create a canvas', 'error');
    } finally {
      setLoading(false);
    }
  }

  async function askDeleteProject(meta) {
    const ok = await showModal({
      title: 'Delete artwork?',
      message: 'â€œ' + (meta.title || 'Untitled') + 'â€ will be permanently removed from this browser. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok !== true) return;

    try {
      await idbDelete(dataKey(meta.id));
      await idbDelete(metaKey(meta.id));
    } catch (e) { /* ignore */ }

    if (state.currentProjectId === meta.id) {
      state.currentProjectId = null;
      state.currentProjectTitle = '';
      updateProjectTitleUI();
    }
    showToast('Artwork deleted');
    await refreshGallery();
  }

  async function renameProject(meta) {
    const name = await showModal({
      title: 'Rename artwork',
      message: 'Give this artwork a new title.',
      value: meta.title || 'Untitled',
      input: true,
      confirmLabel: 'Rename',
    });
    if (name == null) return;

    const clean = String(name).trim().slice(0, 60) || 'Untitled';
    meta.title = clean;
    try { await idbPut(metaKey(meta.id), meta); } catch (e) { /* ignore */ }
    if (state.currentProjectId === meta.id) {
      state.currentProjectTitle = clean;
      updateProjectTitleUI();
    }
    await refreshGallery();
  }

  /* â”€â”€â”€ Legacy single-slot migration â”€â”€â”€ */
  async function thumbnailFromSerialized(data) {
    try {
      const w = data.docWidth || 1920, h = data.docHeight || 1080;
      const scale = Math.min(1, THUMB_MAX / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * scale));
      c.height = Math.max(1, Math.round(h * scale));
      const ctx = c.getContext('2d');
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      await drawSerializedNodes(ctx, data.layers || []);
      return c.toDataURL('image/jpeg', 0.72);
    } catch (e) {
      return null;
    }
  }

  async function drawSerializedNodes(ctx, nodes) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (!n || n.visible === false) continue;
      const alpha = n.opacity != null ? n.opacity : 1;
      if (alpha <= 0) continue;
      if (n.type === 'group') {
        ctx.globalAlpha = 1;
        await drawSerializedNodes(ctx, n.children || []);
      } else if (n.data) {
        try {
          const img = await imageFromSrc(n.data);
          ctx.globalAlpha = alpha;
          ctx.drawImage(img, 0, 0);
        } catch (e) { /* skip broken layer */ }
      }
    }
    ctx.globalAlpha = 1;
  }

  function countSerializedLayers(nodes) {
    let c = 0;
    for (const n of nodes || []) {
      if (n && n.type === 'group') c += countSerializedLayers(n.children);
      else c += 1;
    }
    return c;
  }

  async function migrateLegacyProject() {
    const legacy = await idbGet(LEGACY_KEY);
    if (!legacy || !legacy.layers || !legacy.layers.length) return;

    // If any project already exists, the old slot is either stale or already
    // migrated â€” just drop it.
    const keys = await idbGetAllKeys();
    const hasProjects = keys.some(k => typeof k === 'string' && k.indexOf(META_PREFIX) === 0);
    if (hasProjects) {
      await idbDelete(LEGACY_KEY);
      return;
    }

    const id = makeId();
    const createdAt = legacy.savedAt || Date.now();
    const meta = {
      id,
      title: 'My First Artwork',
      createdAt,
      updatedAt: createdAt,
      docWidth: legacy.docWidth || 1920,
      docHeight: legacy.docHeight || 1080,
      layerCount: countSerializedLayers(legacy.layers),
      thumb: await thumbnailFromSerialized(legacy),
    };
    // Keep the payload's own identity in sync so opening it restores the title.
    legacy.id = id;
    legacy.title = meta.title;
    legacy.createdAt = createdAt;
    await idbPut(dataKey(id), legacy);
    await idbPut(metaKey(id), meta);
    await idbDelete(LEGACY_KEY);
  }

  /* â”€â”€â”€ Modal (confirm / rename) â”€â”€â”€ */
  let modalResolve = null;

  function showModal(opts) {
    const overlay = $('#modalOverlay');
    if (!overlay) return Promise.resolve(true);
    const title = $('#modalTitle');
    const message = $('#modalMessage');
    const input = $('#modalInput');
    const confirm = $('#modalConfirm');

    if (title) title.textContent = opts.title || '';
    if (message) message.textContent = opts.message || '';
    if (confirm) {
      confirm.textContent = opts.confirmLabel || 'Confirm';
      confirm.classList.toggle('danger-btn', !!opts.danger);
      confirm.classList.toggle('success-btn', !opts.danger);
    }
    if (input) {
      if (opts.input) {
        input.classList.remove('hidden');
        input.value = opts.value || '';
        setTimeout(() => { try { input.focus(); input.select(); } catch (e) { } }, 40);
      } else {
        input.classList.add('hidden');
      }
    }
    overlay.classList.remove('hidden');

    return new Promise((resolve) => { modalResolve = resolve; });
  }

  function closeModal(result) {
    const overlay = $('#modalOverlay');
    if (overlay) overlay.classList.add('hidden');
    if (modalResolve) {
      const r = modalResolve;
      modalResolve = null;
      r(result);
    }
  }

  function imageFromSrc(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image load failed'));
      img.src = src;
    });
  }

  function syncBrushUI() {
    const bs = $('#brushSize');
    if (bs) { bs.value = state.brushSize; setNumVal($('#brushSizeVal'), state.brushSize); }
    const bo = $('#brushOpacity');
    if (bo) { bo.value = Math.round(state.brushOpacity * 100); setNumVal($('#brushOpacityVal'), Math.round(state.brushOpacity * 100)); }
    const st = $('#brushStabilizer');
    if (st) { st.value = Math.round(state.stabilization * 100); $('#brushStabilizerVal').textContent = Math.round(state.stabilization * 100) + '%'; }
    updateBrushCursor();
  }

  async function deserializeNode(ld) {
    const isGroup = ld.type === 'group';
    if (isGroup) {
      const children = await Promise.all((ld.children || []).map(deserializeNode));
      return {
        id: ld.id,
        type: 'group',
        name: ld.name || 'Folder',
        visible: ld.visible !== false,
        locked: !!ld.locked,
        opacity: ld.opacity != null ? ld.opacity : 1,
        expanded: ld.expanded !== false,
        children,
      };
    }
    const img = await imageFromSrc(ld.data);
    const canvas = createOffscreenCanvas();
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return {
      id: ld.id,
      type: 'layer',
      name: ld.name || 'Layer',
      canvas, ctx,
      visible: ld.visible !== false,
      locked: !!ld.locked,
      opacity: ld.opacity != null ? ld.opacity : 1,
    };
  }

  async function restoreProject(data) {
    if (!data || !data.layers || !data.layers.length) return false;

    const loaded = await Promise.all(data.layers.map(deserializeNode));

    state.layers = loaded;
    const allIds = flattenNodeIds(loaded);
    state.nextLayerId = data.nextLayerId || (Math.max.apply(null, allIds) + 1);
    state.activeLayerId = allIds.indexOf(data.activeLayerId) !== -1 ? data.activeLayerId : allIds[0];
    state.selectedNodeIds = new Set(state.activeLayerId != null ? [state.activeLayerId] : []);

    if (data.brush) {
      if (data.brush.color) setColor(data.brush.color);
      if (data.brush.size) { const n = Number(data.brush.size); if (isFinite(n) && n > 0) state.brushSize = Math.min(4000, n); }
      if (data.brush.opacity != null) { const n = Number(data.brush.opacity); state.brushOpacity = isFinite(n) ? Math.max(0, Math.min(1, n)) : 1; }
      if (data.brush.stabilization != null) state.stabilization = data.brush.stabilization;
      if (data.brush.type && BRUSH_TYPES[data.brush.type]) state.brushType = data.brush.type;
      if (data.brush.settings && typeof data.brush.settings === 'object') {
        Object.keys(data.brush.settings).forEach((t) => {
          if (!BRUSH_TYPES[t]) return;
          const s = data.brush.settings[t] || {};
          const def = BRUSH_TYPES[t];
          state.brushSettings[t] = {
            hardness: typeof s.hardness === 'number' ? s.hardness : def.hardness,
            spacing: typeof s.spacing === 'number' ? s.spacing : def.spacing,
            flow: typeof s.flow === 'number' ? s.flow : def.flow,
            scatter: typeof s.scatter === 'number' ? s.scatter : def.scatter,
            texture: typeof s.texture === 'string' ? s.texture : def.texture,
          };
        });
      }
      restoreFade(data.brush.fade, data.brush);
      syncBrushUI();
      syncFadeUI();
      if (typeof syncBrushTypeUI === 'function') { syncBrushTypeUI(); drawBrushTipPreview(); }
    }

    if (data.outputFollowView != null) {
      state.outputFollowView = !!data.outputFollowView;
      const b = $('#btnOutputFollow');
      if (b) b.classList.toggle('active', state.outputFollowView);
    }

    if (data.view) {
      state.zoom = data.view.zoom || 1;
      state.panX = data.view.panX || 0;
      state.panY = data.view.panY || 0;
      state.viewRot = data.view.rot || 0;
      updateCanvasTransform();
    }

    if (data.ref && data.ref.data) {
      try {
        const img = await imageFromSrc(data.ref.data);
        state.refImage = img;
        state.refX = data.ref.x;
        state.refY = data.ref.y;
        state.refScale = data.ref.scale || 1;
        state.refRotation = data.ref.rotation || 0;
        state.refOpacity = data.ref.opacity != null ? data.ref.opacity : 0.6;
        state.refVisible = data.ref.visible !== false;
        state.refLocked = !!data.ref.locked;
        const info = $('#refInfo');
        if (info) info.textContent = img.naturalWidth + 'Ã—' + img.naturalHeight + ' (restored)';
        const op = $('#refOpacity');
        if (op) { op.value = Math.round(state.refOpacity * 100); $('#refOpacityVal').textContent = Math.round(state.refOpacity * 100) + '%'; }
        const chk = $('#checkRefLocked'); if (chk) chk.checked = state.refLocked;
        updateRefToggleIcon();
      } catch (e) { /* ignore unreadable reference */ }
    }

    updateLayerList();
    compositeDisplay();
    scheduleRender();
    renderOverlay();
    return true;
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     PRIVACY / FOCUS MODE  (show only the canvas)
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  let privacyMode = false;
  let privacyRefAutohidden = false;

  function togglePrivacy(force) {
    privacyMode = (force === undefined) ? !privacyMode : force;
    document.body.classList.toggle('privacy-mode', privacyMode);
    const controls = $('#privacyControls');
    if (controls) controls.classList.toggle('hidden', !privacyMode);
    const pBtn = $('#btnPrivacy');
    if (pBtn) pBtn.classList.toggle('active', privacyMode);

    if (privacyMode) {
      // Auto-hide the reference so screen-share viewers only see your drawing
      if (state.refImage && state.refVisible) {
        state.refVisible = false;
        privacyRefAutohidden = true;
        updateRefToggleIcon();
        updateLayerList();
        scheduleRender();
      }
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => { });
      }
      showToast('Privacy mode ON â€” reference hidden, only the canvas is shared', 'success');
    } else {
      if (privacyRefAutohidden) {
        state.refVisible = true;
        privacyRefAutohidden = false;
        updateRefToggleIcon();
        updateLayerList();
        scheduleRender();
      }
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => { });
      }
      showToast('Privacy mode OFF');
    }
    const refBtn = $('#btnPrivacyRef');
    if (refBtn) refBtn.classList.toggle('active', state.refVisible && !!state.refImage);
    setTimeout(() => { updateCanvasTransform(); renderOverlay(); }, 120);
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     LIVE SYNC  (shared strokes between PC and phone)
     Uses a plain WebSocket to phone-server.js. Each device draws its own
     strokes locally and relays them; incoming strokes are rendered through a
     separate buffer pipeline so they never touch the local stroke state.
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  const wsClientId = 'd' + Math.random().toString(36).slice(2, 10);
  let liveSocket = null;
  let liveRetryTimer = null;
  let liveStrokeSeq = 0;
  let currentStrokeSid = null;
  const SYNC_CHUNK = 180 * 1024;
  // Chunked payload reassembly (reference images and restored pixel regions).
  const syncRecv = new Map();

  // â”€â”€ Outbound queue â”€â”€
  // All outgoing frames flow through a single FIFO so async producers (PNG
  // encoding in sendRestore) can't interleave with stroke traffic: the pump
  // holds position while a job encodes, then resumes. Batching caps how many
  // frames go out per tick so a full-layer restore can't starve input.
  let wsOutQueue = [];
  let wsOutBusy = false;
  const WS_BATCH = 24;
  const WS_TICK_MS = 15;

  function wsSendRaw(obj) {
    if (liveSocket && liveSocket.readyState === WebSocket.OPEN) {
      try { liveSocket.send(JSON.stringify(obj)); } catch (e) { /* dropped */ }
    }
  }

  function wsSend(obj) { wsSendMany([obj]); }

  function wsSendMany(frames) {
    if (!frames || !frames.length) return;
    for (let i = 0; i < frames.length; i++) wsOutQueue.push(frames[i]);
    pumpWsOut();
  }

  // Enqueues an async producer (called in queue order; it sends its own frames
  // when done). The pump pauses on the job so later frames wait their turn.
  function wsSendLazy(job) {
    wsOutQueue.push(job);
    pumpWsOut();
  }

  function pumpWsOut() {
    if (wsOutBusy) return;
    if (!wsOutQueue.length) return;
    wsOutBusy = true;
    const step = () => {
      if (!liveSocket || liveSocket.readyState !== WebSocket.OPEN) {
        // Same as the old direct send: frames go nowhere while disconnected.
        wsOutQueue.length = 0;
        wsOutBusy = false;
        return;
      }
      let n = 0;
      while (wsOutQueue.length && n < WS_BATCH) {
        const item = wsOutQueue.shift();
        n++;
        if (typeof item === 'function') {
          Promise.resolve()
            .then(item)
            .catch(() => { /* encode/send failed â€” drop this restore */ })
            .then(() => { setTimeout(step, WS_TICK_MS); });
          return;
        }
        wsSendRaw(item);
      }
      if (wsOutQueue.length) setTimeout(step, WS_TICK_MS);
      else wsOutBusy = false;
    };
    step();
  }

  // Attaches the sender id to every outgoing stroke message.
  // Sends stroke events immediately without queueing, buffering, or throttling.
  function emitStroke(ev, extra) {
    if (currentStrokeSid == null) return;
    if (!liveSocket || liveSocket.readyState !== WebSocket.OPEN) return;
    const msg = Object.assign({ type: 'stroke', cid: wsClientId, sid: currentStrokeSid, ev }, extra || {});
    wsSendRaw(msg);
  }

  // Splits a large string payload into `type` frames the server will relay.
  // Extra fields (`extra`) ride along on every frame.
  function sendChunked(type, data, extra) {
    const token = wsClientId + '-' + type + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const total = Math.max(1, Math.ceil(data.length / SYNC_CHUNK));
    const frames = [];
    for (let i = 0; i < total; i++) {
      frames.push(Object.assign({
        type, cid: wsClientId, token, i, total,
        data: data.slice(i * SYNC_CHUNK, (i + 1) * SYNC_CHUNK),
      }, extra || {}));
    }
    wsSendMany(frames);
  }

  function recvChunked(msg, done) {
    if (typeof msg.token !== 'string' || typeof msg.data !== 'string') return;
    if (!Number.isInteger(msg.i) || !Number.isInteger(msg.total) || msg.total < 1) return;
    if (msg.i === 0) {
      const now = Date.now();
      for (const [key, rec] of syncRecv) if (now - rec.at > 30000) syncRecv.delete(key);
    }
    let rec = syncRecv.get(msg.token);
    if (!rec) {
      rec = { parts: new Array(msg.total).fill(null), got: 0, total: msg.total, at: Date.now(), extra: msg };
      syncRecv.set(msg.token, rec);
    }
    if (msg.i < 0 || msg.i >= rec.total) return;
    if (rec.parts[msg.i] == null) { rec.parts[msg.i] = msg.data; rec.got++; }
    if (rec.got === rec.total) {
      syncRecv.delete(msg.token);
      done(rec);
    }
  }

  function connectLiveSync() {
    if (!/^https?:$/.test(location.protocol)) return; // file:// has no server
    let ws;
    try {
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    } catch (e) {
      scheduleLiveRetry();
      return;
    }
    liveSocket = ws;
    ws.onopen = () => {
      if (liveRetryTimer) { clearTimeout(liveRetryTimer); liveRetryTimer = null; }
      if (!state.refImage) wsSend({ type: 'ref-request', cid: wsClientId });
      // A (re)connected device with a project open asks the room for the
      // current pixels, so it never has to rely on the possibly-stale save.
      if (state.currentProjectId) {
        wsSend({ type: 'sync-request', cid: wsClientId, pid: state.currentProjectId });
      }
    };
    ws.onmessage = (e) => {
      let msg = null;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.cid === wsClientId) return;
      const t = msg.type;
      if (t === 'sync-request') { handleSyncRequest(msg); return; }
      if (t === 'sync') { handleSyncControl(msg); return; }
      if (t === 'refimg') { applyRemoteRefChunk(msg); return; }
      if (t === 'refstate') { applyRemoteRefState(msg); return; }
      if (t === 'ref-request') { answerRefRequest(); return; }
      if (t === 'saved') { if (galleryOpen) refreshGallery(); return; }

      // While a peer is streaming us its full state, hold its live edits in
      // order and apply them only after the sync stream ends, so a restore
      // can't land on top of newer pixels from the same device.
      const src = syncSources.get(msg.cid);
      if (t === 'restore') {
        recvChunked(msg, (rec) => {
          const s = syncSources.get(msg.cid);
          if (s) { s.at = Date.now(); s.jobs.push({ op: 'restore', rec }); }
          else enqueueSyncJob(msg.cid, () => applyRemoteRestore(rec));
        });
        return;
      }
      if (src) {
        src.at = Date.now();
        if (t === 'stroke') src.jobs.push({ op: 'stroke', msg });
        else if (t === 'clearlayer') src.jobs.push({ op: 'clear', msg });
        return;
      }
      if (t === 'stroke') {
        const chain = syncJobChains.get(msg.cid);
        if (chain) enqueueSyncJob(msg.cid, () => applyRemoteStroke(msg));
        else applyRemoteStroke(msg);
        return;
      }
      else if (t === 'clearlayer') enqueueSyncJob(msg.cid, () => applyRemoteClear(msg));
    };
    ws.onclose = () => {
      if (liveSocket === ws) liveSocket = null;
      for (const s of syncSources.values()) if (s.timer) clearTimeout(s.timer);
      syncSources.clear();
      scheduleLiveRetry();
    };
    ws.onerror = () => { try { ws.close(); } catch (e) { /* ignore */ } };
  }

  function scheduleLiveRetry() {
    if (liveRetryTimer) return;
    liveRetryTimer = setTimeout(() => { liveRetryTimer = null; connectLiveSync(); }, 4000);
  }

  // â”€â”€ Per-sender ordering & sync-on-join â”€â”€
  // Every remote pixel op from one device is applied through a per-cid promise
  // chain, so restores/strokes/clears always land in the order they were sent
  // (chunked restores encode asynchronously and would otherwise race).
  const syncJobChains = new Map();
  function enqueueSyncJob(cid, fn) {
    const prev = syncJobChains.get(cid) || Promise.resolve();
    const next = prev.then(fn, fn);
    syncJobChains.set(cid, next.catch(() => { }));
    if (syncJobChains.size > 48) {
      for (const key of syncJobChains.keys()) { syncJobChains.delete(key); break; }
    }
    return next;
  }

  // Ops from a device that is currently streaming us its full state.
  const syncSources = new Map();

  function handleSyncControl(msg) {
    if (msg.phase === 'begin') {
      syncSources.set(msg.cid, { jobs: [], at: Date.now(), timer: null });
      // Safety net: if 'end' never arrives (sender dropped mid-stream), apply
      // what we buffered rather than holding it forever.
      scheduleSyncFlush(msg.cid, 30000);
      return;
    }
    if (msg.phase === 'end') flushSyncSource(msg.cid);
  }

  function scheduleSyncFlush(cid, delay) {
    const src = syncSources.get(cid);
    if (!src) return;
    if (src.timer) clearTimeout(src.timer);
    src.timer = setTimeout(() => flushSyncSource(cid), delay);
  }

  function flushSyncSource(cid) {
    const src = syncSources.get(cid);
    if (!src) return;
    syncSources.delete(cid);
    if (src.timer) clearTimeout(src.timer);
    for (let i = 0; i < src.jobs.length; i++) {
      const job = src.jobs[i];
      if (job.op === 'stroke') enqueueSyncJob(cid, () => applyRemoteStroke(job.msg));
      else if (job.op === 'restore') enqueueSyncJob(cid, () => applyRemoteRestore(job.rec));
      else if (job.op === 'clear') enqueueSyncJob(cid, () => applyRemoteClear(job.msg));
    }
  }

  let lastSyncAnswerAt = 0;
  function handleSyncRequest(msg) {
    if (!state.currentProjectId) return;
    if (msg.pid !== state.currentProjectId) return;
    const now = Date.now();
    // A flaky tunnel can reconnect in a loop; keep full answers to one per window.
    if (now - lastSyncAnswerAt < 5000) return;
    lastSyncAnswerAt = now;
    wsSend({ type: 'sync', cid: wsClientId, pid: state.currentProjectId, phase: 'begin' });
    const layers = collectPaintLayers(state.layers);
    for (let i = 0; i < layers.length; i++) {
      sendRestore(layers[i], null, layers[i].canvas);
    }
    wsSend({ type: 'sync', cid: wsClientId, pid: state.currentProjectId, phase: 'end' });
  }

  function collectPaintLayers(nodes, acc) {
    acc = acc || [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (isGroupNode(n)) collectPaintLayers(n.children, acc);
      else acc.push(n);
    }
    return acc;
  }

  // â”€â”€ Remote stroke canvas pool â”€â”€
  // Full 1920Ã—1080 canvases are expensive to allocate; remote strokes borrow
  // from a small pool instead of creating (and GC-ing) two per stroke.
  const remoteCanvasPool = [];
  const REMOTE_POOL_MAX = 4;

  function acquireRemoteCanvas() {
    const c = remoteCanvasPool.pop();
    if (c) return c;
    const n = document.createElement('canvas');
    n.width = state.docWidth;
    n.height = state.docHeight;
    return n;
  }

  function releaseRemoteCanvas(c) {
    if (!c) return;
    if (remoteCanvasPool.length < REMOTE_POOL_MAX) remoteCanvasPool.push(c);
  }

  // Extends the stroke's pristine snapshot to cover `nb`, copying only the new
  // strips (â‰¤4) from the live layer. Called BEFORE compositing a segment, while
  // the layer outside the old region is still untouched by this stroke.
  function growRemoteSnap(st, nb) {
    const W = state.docWidth, H = state.docHeight;
    const b = {
      x0: Math.max(0, Math.floor(nb.x0)), y0: Math.max(0, Math.floor(nb.y0)),
      x1: Math.min(W, Math.ceil(nb.x1)), y1: Math.min(H, Math.ceil(nb.y1)),
    };
    if (!(b.x1 > b.x0 && b.y1 > b.y0)) return;
    const r = st.snapRegion;
    if (r && b.x0 >= r.x0 && b.y0 >= r.y0 && b.x1 <= r.x1 && b.y1 <= r.y1) return;
    const ctx = st.snap.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (!r) {
      ctx.clearRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
      ctx.drawImage(st.layer.canvas, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0,
        b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
      st.snapRegion = b;
      return;
    }
    const nx0 = Math.min(r.x0, b.x0), ny0 = Math.min(r.y0, b.y0);
    const nx1 = Math.max(r.x1, b.x1), ny1 = Math.max(r.y1, b.y1);
    const strips = [];
    if (ny0 < r.y0) strips.push([nx0, ny0, nx1, r.y0 - ny0]);
    if (ny1 > r.y1) strips.push([nx0, r.y1, nx1, ny1 - r.y1]);
    if (nx0 < r.x0) strips.push([nx0, r.y0, r.x0 - nx0, r.y1 - r.y0]);
    if (nx1 > r.x1) strips.push([r.x1, r.y0, nx1 - r.x1, r.y1 - r.y0]);
    for (let i = 0; i < strips.length; i++) {
      const s = strips[i];
      ctx.clearRect(s[0], s[1], s[2], s[3]);
      ctx.drawImage(st.layer.canvas, s[0], s[1], s[2], s[3], s[0], s[1], s[2], s[3]);
    }
    st.snapRegion = { x0: nx0, y0: ny0, x1: nx1, y1: ny1 };
  }

  // Encodes a canvas off the critical path: toBlob runs asynchronously (unlike
  // toDataURL, which stalls the main thread â€” the iOS freeze this replaced).
  function canvasToDataUrl(canvas, type, quality) {
    return new Promise((resolve) => {
      try {
        if (canvas.toBlob) {
          canvas.toBlob((blob) => {
            if (!blob) { resolve(null); return; }
            const fr = new FileReader();
            fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
            fr.onerror = () => resolve(null);
            fr.readAsDataURL(blob);
          }, type, quality);
        } else {
          resolve(canvas.toDataURL(type, quality));
        }
      } catch (e) { resolve(null); }
    });
  }

  // Ships the just-restored pixels of `bbox` (or the whole layer) to the other
  // device, so it lands on the identical state without replaying our history.
  // The crop happens now (capturing today's pixels); the PNG encode + chunked
  // send run through the outbound queue without blocking the UI.
  function sendRestore(layer, bbox, snap) {
    const padBox = bbox ? { x0: bbox.x0 - 8, y0: bbox.y0 - 8, x1: bbox.x1 + 8, y1: bbox.y1 + 8 } : null;
    const r = clampBBox(padBox);
    const rw = r.x1 - r.x0, rh = r.y1 - r.y0;
    if (!(rw > 0 && rh > 0)) return;
    const tile = document.createElement('canvas');
    tile.width = rw;
    tile.height = rh;
    const tctx = tile.getContext('2d');
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.globalAlpha = 1;
    tctx.globalCompositeOperation = 'source-over';
    try { tctx.drawImage(snap, r.x0, r.y0, rw, rh, 0, 0, rw, rh); } catch (e) { return; }
    const layerId = layer.id;
    wsSendLazy(() => canvasToDataUrl(tile, 'image/png').then((png) => {
      if (typeof png !== 'string' || png.length < 8) return;
      const token = wsClientId + '-restore-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      const total = Math.max(1, Math.ceil(png.length / SYNC_CHUNK));
      const extra = { layerId, x: r.x0, y: r.y0, w: rw, h: rh };
      for (let i = 0; i < total; i++) {
        wsSendRaw(Object.assign({
          type: 'restore', cid: wsClientId, token, i, total,
          data: png.slice(i * SYNC_CHUNK, (i + 1) * SYNC_CHUNK),
        }, extra));
      }
    }));
  }

  // Applies a pixel region sent by another device after its undo/redo/clear.
  // Returns a promise so the per-sender job chain can keep ordering.
  function applyRemoteRestore(rec) {
    return new Promise((resolve) => {
      const msg = rec.extra || {};
      const layer = findNode(msg.layerId) || getActiveLayer();
      if (!layer || isGroupNode(layer)) { resolve(); return; }
      const src = rec.parts.join('');
      const x = msg.x | 0, y = msg.y | 0, w = msg.w | 0, h = msg.h | 0;
      if (!(w > 0 && h > 0)) { resolve(); return; }
      const img = new Image();
      img.onload = () => {
        try {
          const ctx = layer.ctx;
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = 'source-over';
          ctx.clearRect(x, y, w, h);
          ctx.drawImage(img, x, y, w, h);
          ctx.restore();
          markLayerDirty(layer.id);
          updateLayerThumbnail(layer.id);
          compositeDisplay();
          try { updateOutputWindow(); } catch (e) {}
          scheduleRender(null, true);
        } catch (e) { /* unreadable region */ }
        queueSave();
        resolve();
      };
      img.onerror = () => { resolve(); };
      img.src = src;
    });
  }

  // Another device cleared its layer â€” clear ours too so we stay identical.
  function applyRemoteClear(msg) {
    const layer = findNode(msg.layerId) || getActiveLayer();
    if (!layer || isGroupNode(layer)) return;
    if (nodeLocked(layer.id)) return;
    layer.ctx.clearRect(0, 0, state.docWidth, state.docHeight);
    markLayerDirty(layer.id);
    updateLayerThumbnail(layer.id);
    compositeDisplay();
    try { updateOutputWindow(); } catch (e) {}
    queueSave();
    scheduleRender(null, true);
  }

  // Answering a ref-request re-sends the whole picture. Over a flaky tunnel the
  // socket can reconnect in a loop, and each pass would otherwise re-ship
  // several MB â€” saturating the link and starving stroke messages. A cooldown
  // keeps that to at most one full send per window.
  let lastRefAnswerAt = 0;
  function answerRefRequest() {
    if (!state.refImage) return;
    const now = Date.now();
    if (now - lastRefAnswerAt < 5000) return;
    lastRefAnswerAt = now;
    publishReference(true);
  }

  // Paints one incoming stroke onto its target layer. Mirrors the local
  // off-screen-buffer technique (100% stamps on a buffer, then one composite
  // at the brush opacity) so overlapping segments don't darken at the joints.
  function applyRemoteStroke(msg) {
    if (!msg || typeof msg.sid !== 'string' || msg.sid.length > 80) return;

    if (msg.ev === 'end') { finishRemoteStroke(msg.sid); return; }

    if (typeof msg.x !== 'number' || typeof msg.y !== 'number' ||
        !isFinite(msg.x) || !isFinite(msg.y)) return;

    if (msg.ev === 'begin') {
      const layer = findNode(msg.layerId) || getActiveLayer();
      if (!layer || isGroupNode(layer)) return;

      const snap = acquireRemoteCanvas();
      const sctx = snap.getContext('2d');
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.globalAlpha = 1;
      sctx.globalCompositeOperation = 'source-over';
      sctx.clearRect(0, 0, state.docWidth, state.docHeight);
      sctx.drawImage(layer.canvas, 0, 0);

      const buf = acquireRemoteCanvas();
      const bctx = buf.getContext('2d');
      bctx.setTransform(1, 0, 0, 1, 0, 0);
      bctx.globalAlpha = 1;
      bctx.globalCompositeOperation = 'source-over';
      bctx.clearRect(0, 0, state.docWidth, state.docHeight);

      const radius = Math.max(0.5, (Number(msg.size) || 5) / 2);
      let alpha = Number(msg.opacity);
      if (!isFinite(alpha)) alpha = 1;
      alpha = Math.max(0, Math.min(1, alpha));

      // Remote strokes are NOT pushed onto this device's undo stack: history is
      // per-device (own edits only). The origin device owns undoing it and will
      // ship the restored pixels back via a `restore` message.
      const baseSize = Number(msg.size) || 5;
      const st = {
        layer, snap, buf, bctx,
        snapRegion: { x0: 0, y0: 0, x1: state.docWidth, y1: state.docHeight },
        erase: msg.tool === 'eraser',
        color: typeof msg.color === 'string' ? msg.color : '#000000',
        radius, alpha,
        baseSize,
        fade: (msg.fade && msg.fade.enabled) ? msg.fade : null,
        points: [{ x: msg.x, y: msg.y }],
        lastX: msg.x, lastY: msg.y,
        bbox: {
          x0: msg.x - radius, y0: msg.y - radius,
          x1: msg.x + radius, y1: msg.y + radius,
        },
      };
      remoteStrokes.set(msg.sid, st);
      if (st.fade) {
        renderRemoteFadeStroke(st);
      } else {
        stampRemoteSegment(st, msg.x, msg.y, msg.x, msg.y);
      }
      compositeRemoteStroke(st);
      return;
    }

    const st = remoteStrokes.get(msg.sid);
    if (!st) return;

    if (msg.ev === 'move') {
      if (st.fade) {
        st.points.push({ x: msg.x, y: msg.y });
        renderRemoteFadeStroke(st);
      } else {
        stampRemoteSegment(st, st.lastX, st.lastY, msg.x, msg.y);
      }
      st.lastX = msg.x;
      st.lastY = msg.y;
      compositeRemoteStroke(st);
    }
  }

  function renderRemoteFadeStroke(st) {
    st.bctx.setTransform(1, 0, 0, 1, 0, 0);
    st.bctx.clearRect(0, 0, state.docWidth, state.docHeight);
    const box = paintFadeStroke(st.bctx, st.points, st.fade, st.baseSize, 1.0, st.color, st.erase);
    if (box) {
      st.bbox.x0 = Math.min(st.bbox.x0, box.minX - 8);
      st.bbox.y0 = Math.min(st.bbox.y0, box.minY - 8);
      st.bbox.x1 = Math.max(st.bbox.x1, box.maxX + 8);
      st.bbox.y1 = Math.max(st.bbox.y1, box.maxY + 8);
    }
  }

  function stampRemoteSegment(st, x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const step = Math.max(0.5, st.radius * 0.1);
    const steps = Math.max(1, Math.ceil(dist / step));
    const sx = dx / steps, sy = dy / steps;

    const r = st.radius;
    st.bbox.x0 = Math.min(st.bbox.x0, x0 - r, x1 - r);
    st.bbox.y0 = Math.min(st.bbox.y0, y0 - r, y1 - r);
    st.bbox.x1 = Math.max(st.bbox.x1, x0 + r, x1 + r);
    st.bbox.y1 = Math.max(st.bbox.y1, y0 + r, y1 + r);

    st.bctx.save();
    st.bctx.globalAlpha = 1;
    st.bctx.globalCompositeOperation = 'source-over';
    st.bctx.fillStyle = st.erase ? '#000000' : st.color;
    for (let k = 0; k <= steps; k++) {
      const cx = x0 + sx * k, cy = y0 + sy * k;
      st.bctx.beginPath();
      st.bctx.arc(cx, cy, r, 0, Math.PI * 2);
      st.bctx.fill('nonzero');
    }
    st.bctx.restore();
  }

  function compositeRemoteStroke(st) {
    // The snapshot only covers the region seen so far; extend it (strips from
    // the still-pristine layer) before compositing over the grown bbox.
    growRemoteSnap(st, st.bbox);
    const ctx = st.layer.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    compositeStrokeRegion(ctx, st.snap, st.bbox, st.erase ? 1 : st.alpha,
      st.erase ? 'destination-out' : 'source-over', st.buf);
    ctx.restore();
    markLayerDirty(st.layer.id);
    compositeDisplay();
    try { updateOutputWindow(); } catch (e) {}
    // No save per segment â€” finishRemoteStroke queues one save for the whole stroke.
    scheduleRender(null, true);
  }

  function finishRemoteStroke(sid) {
    const st = remoteStrokes.get(sid);
    if (!st) return;
    if (st.fade && st.points && st.points.length > 0) {
      renderRemoteFadeStroke(st);
      compositeRemoteStroke(st);
    }
    remoteStrokes.delete(sid);
    releaseRemoteCanvas(st.snap);
    releaseRemoteCanvas(st.buf);
    st.snap = null;
    st.buf = null;
    st.bctx = null;
    markLayerDirty(st.layer.id);
    updateLayerThumbnail(st.layer.id);
    compositeDisplay();
    try { updateOutputWindow(); } catch (e) {}
    queueSave();
    scheduleRender(null, true);
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     LIVE REFERENCE SYNC  (trace background shared to all devices)
     The image is sent in small chunks (each under the server's frame
     limit); transform/opacity/visibility travel as tiny state messages.
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  const REF_CHUNK = 180 * 1024;
  const refRecv = new Map();
  let remoteRefState = null;
  let refStateTimer = null;

  function refStatePayload() {
    return {
      x: state.refX, y: state.refY,
      scale: state.refScale, rotation: state.refRotation,
      opacity: state.refOpacity, visible: state.refVisible, locked: state.refLocked,
    };
  }

  // `includeImage` re-sends the picture itself (on import or when a freshly
  // opened device asks for it); otherwise only the light state is sent.
  function publishReference(includeImage) {
    if (!state.refImage) {
      wsSend({ type: 'refstate', cid: wsClientId, has: false });
      return;
    }
    if (includeImage) sendReferenceImage(state.refImage.src);
    wsSend(Object.assign({ type: 'refstate', cid: wsClientId, has: true }, refStatePayload()));
  }

  function scheduleRefStatePublish() {
    if (refStateTimer) return;
    refStateTimer = setTimeout(() => { refStateTimer = null; publishReference(false); }, 120);
  }

  function sendReferenceImage(src) {
    if (typeof src !== 'string' || !src) return;
    const token = wsClientId + '-r' + Date.now();
    const total = Math.max(1, Math.ceil(src.length / REF_CHUNK));
    for (let i = 0; i < total; i++) {
      wsSend({
        type: 'refimg', cid: wsClientId, token, i, total,
        data: src.slice(i * REF_CHUNK, (i + 1) * REF_CHUNK),
      });
    }
  }

  function applyRemoteRefChunk(msg) {
    if (typeof msg.token !== 'string' || typeof msg.data !== 'string') return;
    if (!Number.isInteger(msg.i) || !Number.isInteger(msg.total) || msg.total < 1) return;

    if (msg.i === 0) {
      const now = Date.now();
      for (const [key, rec] of refRecv) if (now - rec.at > 60000) refRecv.delete(key);
    }

    let rec = refRecv.get(msg.token);
    if (!rec) {
      rec = { parts: new Array(msg.total).fill(null), got: 0, total: msg.total, at: Date.now() };
      refRecv.set(msg.token, rec);
    }
    if (msg.i < 0 || msg.i >= rec.total) return;
    if (rec.parts[msg.i] == null) { rec.parts[msg.i] = msg.data; rec.got++; }
    if (rec.got === rec.total) {
      refRecv.delete(msg.token);
      setRemoteReference(rec.parts.join(''));
    }
  }

  async function setRemoteReference(src) {
    try {
      const img = await imageFromSrc(src);
      state.refImage = img;
      state.refLocked = false;
      if (remoteRefState && remoteRefState.has !== false) {
        applyRefState(remoteRefState);
      } else {
        fitRefToCanvas(true);
        updateRefToggleIcon();
        updateLayerList();
        scheduleRender();
        renderOverlay();
      }
      const info = $('#refInfo');
      if (info) info.textContent = img.naturalWidth + 'Ã—' + img.naturalHeight + ' (synced)';
      showToast('Reference synced from another device', 'success');
      // Ensure immediate draw even if tab throttled
      try {
        if (typeof document !== 'undefined') {
          renderQueued = false;
          pendingDirty = null;
          compositeDisplay();
          renderOverlay();
        }
      } catch (e) {}
    } catch (e) { /* ignore unreadable image */ }
  }

  function applyRefState(msg) {
    if (typeof msg.x === 'number') state.refX = msg.x;
    if (typeof msg.y === 'number') state.refY = msg.y;
    if (typeof msg.scale === 'number') state.refScale = msg.scale;
    if (typeof msg.rotation === 'number') state.refRotation = msg.rotation;
    if (typeof msg.opacity === 'number') state.refOpacity = msg.opacity;
    state.refVisible = msg.visible !== false;
    state.refLocked = !!msg.locked;

    const op = $('#refOpacity');
    if (op) { op.value = Math.round(state.refOpacity * 100); const ov = $('#refOpacityVal'); if (ov) ov.textContent = Math.round(state.refOpacity * 100) + '%'; }
    const chk = $('#checkRefLocked'); if (chk) chk.checked = state.refLocked;
    updateRefToggleIcon();
    updateLayerList();
    scheduleRender();
    // Force immediate composite in case tab is hidden/throttled
    try { if (typeof document !== 'undefined' && document.hidden) { renderQueued = false; pendingDirty = null; compositeDisplay(); } } catch (e) {}
    renderOverlay();
  }

  function applyRemoteRefState(msg) {
    if (msg.has === false) {
      if (!state.refImage) return;
      state.refImage = null;
      const info = $('#refInfo'); if (info) info.textContent = 'No reference loaded.';
      updateRefToggleIcon();
      updateLayerList();
      scheduleRender();
      try { renderQueued = false; pendingDirty = null; compositeDisplay(); renderOverlay(); } catch (e) {}
      return;
    }
    remoteRefState = msg;
    if (state.refImage) {
      applyRefState(msg);
      try { renderQueued = false; pendingDirty = null; compositeDisplay(); renderOverlay(); } catch (e) {}
    }
  }

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     BOOT
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
