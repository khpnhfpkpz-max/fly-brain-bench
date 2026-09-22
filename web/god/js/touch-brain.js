/* NEURAL GOD -- Phase 5 (mobile): two-finger pinch-zoom for the Neural
   Activity brain view (web/js/gl.js's BrainView), added without touching
   gl.js at all.

   gl.js's own _bindControls() already gives single-finger drag-to-rotate
   for free -- it uses Pointer Events, which are pointer-type-agnostic, and
   that path is untouched by this file. What it does not do is track which
   pointer is which: a second finger just re-anchors its shared drag
   reference (lx, ly), so two fingers moving apart get read as whichever
   finger's own movement happened to arrive last -- spurious rotation, no
   zoom. Confirmed against the running app before writing this file (see
   the delivery notes' touch audit).

   Fix, without editing gl.js: intercept multi-touch at the capture phase
   on an ANCESTOR of the canvas. Capture-phase listeners on an ancestor
   fire strictly before the event ever reaches the canvas -- registration
   order on the canvas itself (which is what would decide things if we
   attached to the canvas, and gl.js's own constructor already ran first)
   does not matter here. stopPropagation() during a genuine 2-finger
   gesture keeps gl.js's own canvas-level listener from ever seeing those
   events; anything with fewer than 2 active touches (including every
   mouse event, and the first finger of any touch gesture) is left
   completely alone, so single-finger drag and all mouse interaction stay
   exactly what gl.js already made them. */
export function bindBrainPinchZoom(view, canvas) {
  const active = new Map();   // pointerId -> {x,y}, touch pointers only
  let startDist = null, startViewDist = null;
  const root = canvas.parentElement || canvas;

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  root.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (active.size === 2) {
      const [a, b] = [...active.values()];
      startDist = dist(a, b);
      startViewDist = view.dist;
      view.userFramed = true;
    }
    if (active.size >= 2) e.stopPropagation();
  }, true);

  root.addEventListener('pointermove', e => {
    if (!active.has(e.pointerId)) return;
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (active.size === 2 && startDist) {
      const [a, b] = [...active.values()];
      const d = dist(a, b);
      view.dist = Math.max(view.radius * 0.2, Math.min(view.radius * 9, startViewDist * (startDist / d)));
      e.stopPropagation();
    }
  }, true);

  /* Deliberately does not stopPropagation(): letting a finger's own
     pointerup/pointercancel reach gl.js keeps its internal `drag` flag in
     sync (cleared when that finger was the one gl.js was tracking). The
     one known rough edge this leaves: if a pinch ends by lifting one
     finger while the other stays down, gl.js's drag flag was already
     cleared by the lifted finger's pointerup, so the remaining finger
     does not resume rotating until it is lifted and touched again. That
     is a one-line UX quirk, not a broken gesture -- and the alternative
     (reimplementing gl.js's own drag state machine here to paper over it)
     would mean duplicating logic this file is explicitly trying not to
     own a second copy of. */
  const release = e => {
    if (!active.has(e.pointerId)) return;
    active.delete(e.pointerId);
    if (active.size < 2) startDist = null;
  };
  root.addEventListener('pointerup', release, true);
  root.addEventListener('pointercancel', release, true);
}
