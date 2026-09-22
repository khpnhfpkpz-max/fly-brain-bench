/* NEURAL GOD -- duty-cycles the Brain Engine worker instead of letting it run
   flat out.

   web/js/sim.worker.js's tick() is a self-perpetuating `setTimeout(tick, 0)`
   loop with no ceiling: once started with `cmd:'run', on:true` it consumes
   whatever CPU the machine has to give, forever, tab visible or not. That is
   the single largest contributor to the fan noise this is meant to fix.

   This is a god/-side-only fix built entirely from the worker's *existing*,
   unmodified protocol (`cmd:'run', on:true|false` -- already used by the
   main bench itself): alternate short bursts of "on" with equal bursts of
   "off". The worker's own message handler (sim.worker.js's onmessage) always
   processes `stim`/`reset` immediately regardless of this on/off phase, so
   nothing about causality (Food -> proboscis, Looming -> escape) or the
   engine's own numerics changes -- only how much of the wall clock the
   simulation is allowed to run in. Biological time then advances at roughly
   `runMs / (runMs + pauseMs)` of its un-paced rate; a 50/50 split roughly
   halves sustained CPU from this source.

   This intentionally stops short of the deeper fix (a `cmd:'pace'` added to
   sim.worker.js itself, so the worker paces its own loop instead of being
   externally toggled at a fixed cadence) -- that would touch a shared file,
   which this pass does not do. */
export function createSimPacer(worker, { runMs = 250, pauseMs = 250 } = {}) {
  let enabled = false;
  let visible = typeof document === 'undefined' || !document.hidden;
  let phaseOn = false;
  let timer = null;

  function send(on) { worker.postMessage({ cmd: 'run', on }); }

  function tick() {
    clearTimeout(timer);
    if (!enabled || !visible) { send(false); phaseOn = false; return; }
    phaseOn = !phaseOn;
    send(phaseOn);
    timer = setTimeout(tick, phaseOn ? runMs : pauseMs);
  }

  function onVisibility() {
    visible = !document.hidden;
    tick();
  }
  document.addEventListener('visibilitychange', onVisibility);

  return {
    /* `on` is the app's own logical "should the world be live" switch (the
       Simulation/LIVE indicator); it is independent of the pacer's internal
       on/off micro-toggling, and independent of tab visibility. */
    setEnabled(on) {
      enabled = on;
      tick();
    },
    dispose() {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      send(false);
    },
  };
}
