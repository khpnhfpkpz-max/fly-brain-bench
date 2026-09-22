/* NEURAL GOD -- Neural Inspector.

   Search (by numeric index, FlyWire root ID, cell type or region name),
   3D-click selection, a detail panel, a real 10s spike history and exactly
   two "how involved is this neuron in the current behaviour" facts -- both
   arithmetic already sitting in data this page has, never an invented score:

   1. Channel membership: web/data/channels.json's own eight named channels
      (escape/turn/stop/backward/landing/wing/walk/proboscis) list their
      member neurons; if the selection is one, decoder.js's own chanRate()
      (unmodified, already public) gives the channel's live mean rate next to
      this neuron's own.
   2. Direct projection: does this neuron's own top synaptic outputs
      (web/js/sim.worker.js's new cmd:'neighbors') include a member of one of
      those channels. Multi-hop influence is deliberately NOT computed here --
      see the Phase 3 planning discussion for why that would need assumptions
      this page has no measurement to back.

   Connections come from the worker's cmd:'neighbors' -- a query, answered
   from the CSR the engine already holds, that never starts, stops or paces
   the simulation loop itself (see sim.worker.js's own comment on it). */
import { fetchGz } from '../../js/data.js';
import { REGIONS, regionOf } from './regions.js';

const HISTORY_LEN = 50;          // 50 samples at the 5 Hz readout rate = 10 s of real history
const NEIGHBOR_MAX = 300;        // edges returned per query; degree/synapse totals are always exact, uncapped
const CHANNEL_NAMES = ['escape', 'turn', 'stop', 'backward', 'landing', 'wing', 'walk', 'proboscis'];

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function buildTypeIndex(labels) {
  const map = new Map();
  const ct = labels.cellType;
  for (let i = 0; i < ct.length; i++) {
    let arr = map.get(ct[i]);
    if (!arr) map.set(ct[i], arr = []);
    arr.push(i);
  }
  return map;
}

export function createInspector({ el, meta, dicts, labels, channels, dec, hz, worker, view, onRegionPick }) {
  const N = labels.cellType.length;
  const typeIndex = buildTypeIndex(labels);
  const history = new Float32Array(HISTORY_LEN);
  let historyN = 0;
  let selected = -1;
  let qidCounter = 0, pendingQid = -1;
  let neighborData = null;
  let rootIdsPromise = null;
  const rootIds = () => (rootIdsPromise ||= fetchGz('../data/rootids.bin.gz')
    .then(b => new BigUint64Array(b.buffer, b.byteOffset, N)).catch(() => null));

  /* ---------------- selection ---------------- */
  function select(i) {
    if (i < 0 || i >= N) return;
    selected = i;
    history.fill(0); historyN = 0;
    neighborData = null;
    view.sel.fill(0); view.sel[i] = 1; view.uploadSel();
    renderStatic();
    renderLive();
    requestNeighbors(i);
  }

  function clearSelection() {
    selected = -1;
    view.sel.fill(0); view.uploadSel();
    renderStatic();
  }

  function requestNeighbors(i) {
    pendingQid = ++qidCounter;
    worker.postMessage({ cmd: 'neighbors', i, qid: pendingQid, max: NEIGHBOR_MAX });
  }

  /* Called by app.js's onWorker() for {type:'neighbors', ...} messages. */
  function onNeighbors(msg) {
    if (msg.qid !== pendingQid || msg.i !== selected) return;   // stale: selection moved on
    neighborData = msg;
    renderConnections();
    renderInvolvement();
  }

  /* Called once per readout() tick (5 Hz) -- same cadence S.hz itself updates at. */
  function sampleHistory() {
    if (selected < 0) return;
    history.copyWithin(0, 1);
    history[HISTORY_LEN - 1] = hz[selected];
    historyN = Math.min(HISTORY_LEN, historyN + 1);
    renderLive();
  }

  /* ---------------- search ---------------- */
  function search(query) {
    const q = query.trim();
    const out = { index: null, rootLookup: false, types: [], regions: [] };
    if (!q) return out;
    if (/^\d+$/.test(q)) {
      const n = Number(q);
      if (Number.isSafeInteger(n) && n < N) out.index = n;
      else if (q.length >= 15) out.rootLookup = q;   // looks like a FlyWire root ID, not an in-range index
    }
    const ql = q.toLowerCase();
    for (let t = 0; t < dicts.cell_type.length; t++) {
      if (dicts.cell_type[t].toLowerCase().includes(ql)) {
        out.types.push({ t, name: dicts.cell_type[t], indices: typeIndex.get(t) || [] });
        if (out.types.length >= 20) break;
      }
    }
    for (const r of REGIONS) if (r.label.toLowerCase().includes(ql)) out.regions.push(r);
    return out;
  }

  function renderResults(query) {
    const r = search(query);
    const rows = [];
    if (r.index !== null) {
      const type = dicts.cell_type[labels.cellType[r.index]];
      rows.push(resultRow('neuron', `#${r.index}`, type, () => select(r.index)));
    }
    for (const t of r.types) rows.push(resultRow('type', t.name, `${t.indices.length} cell${t.indices.length === 1 ? '' : 's'}`, () => selectFirstOfType(t)));
    for (const rg of r.regions) rows.push(resultRow('region', rg.label, 'region', () => { onRegionPick?.(rg.id); el.results.classList.remove('open'); }));
    el.results.innerHTML = rows.length ? '' : '<div class="ins-empty-row dim">No matches</div>';
    if (rows.length) for (const row of rows) el.results.appendChild(row);
    el.results.classList.toggle('open', query.trim().length > 0);

    if (r.rootLookup) {
      el.results.appendChild(resultRow('type', 'Looking up root ID…', '', null));
      rootIds().then(ids => {
        if (!ids || el.search.value.trim() !== query.trim()) return;
        const target = BigInt(r.rootLookup);
        for (let i = 0; i < ids.length; i++) if (ids[i] === target) { select(i); el.results.classList.remove('open'); return; }
        el.results.innerHTML = '<div class="ins-empty-row dim">No neuron with that root ID</div>';
      });
    }
  }

  function resultRow(kind, main, sub, onClick) {
    const row = document.createElement(onClick ? 'button' : 'div');
    if (onClick) { row.type = 'button'; row.addEventListener('click', onClick); }
    row.className = `ins-result ins-result-${kind}`;
    row.innerHTML = `<span class="ins-result-kind">${kind}</span><span class="ins-result-main">${esc(main)}</span><span class="ins-result-sub dim">${esc(sub)}</span>`;
    return row;
  }

  const typeCursor = new Map();    // remembers "which member of this type" across repeated clicks
  function selectFirstOfType(t) {
    if (!t.indices.length) return;
    const prev = typeCursor.get(t.t) ?? -1;
    const next = (prev + 1) % t.indices.length;
    typeCursor.set(t.t, next);
    select(t.indices[next]);
  }

  /* ---------------- rendering ---------------- */
  function renderStatic() {
    if (selected < 0) {
      el.empty.style.display = '';
      el.body.style.display = 'none';
      return;
    }
    el.empty.style.display = 'none';
    el.body.style.display = '';
    const i = selected;
    const type = dicts.cell_type[labels.cellType[i]];
    const region = regionOf(dicts, labels, i) || '—';
    const nt = dicts.top_nt[labels.nt[i]];
    const side = dicts.side[labels.side[i]];
    el.title.textContent = type;
    el.meta.innerHTML =
      `<dt>Neuron</dt><dd class="mono">#${i}</dd>` +
      `<dt>Cell type</dt><dd>${esc(type)}</dd>` +
      `<dt>Region</dt><dd>${esc(region)}</dd>` +
      `<dt>Side</dt><dd>${esc(side)}</dd>` +
      `<dt>Transmitter</dt><dd>${esc(nt)}</dd>`;
    el.connections.innerHTML = '<p class="dim">Querying the connectome…</p>';
    el.involvement.innerHTML = '';
    el.rootLink.textContent = '';
    rootIds().then(ids => {
      if (!ids || selected !== i) return;
      const rid = ids[i];
      if (rid === 0n) return;                        // no annotated root id for this slot
      el.rootLink.innerHTML = `<a href="https://codex.flywire.ai/app/cell_details?root_id=${rid}" target="_blank" rel="noopener">Open in FlyWire Codex →</a>`;
    });
  }

  function renderLive() {
    if (selected < 0) return;
    const i = selected;
    el.rate.textContent = `${hz[i].toFixed(1)} Hz`;
    el.activity.textContent = `${Math.round(Math.min(1, view.act[i]) * 100)}%`;
    drawHistory();
    renderInvolvement();          // the two rates in fact A move every tick even if membership does not
  }

  function drawHistory() {
    const canvas = el.history;
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.clearRect(0, 0, w, h);
    if (historyN < 2) return;
    let max = 1;
    for (let k = 0; k < historyN; k++) max = Math.max(max, history[HISTORY_LEN - historyN + k]);
    ctx.strokeStyle = '#5fd0ff'; ctx.lineWidth = 1.4 * dpr; ctx.beginPath();
    for (let k = 0; k < historyN; k++) {
      const v = history[HISTORY_LEN - historyN + k];
      const x = historyN > 1 ? (k / (historyN - 1)) * w : 0;
      const y = h - 3 * dpr - (v / max) * (h - 6 * dpr);
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function renderConnections() {
    if (!neighborData) return;
    const m = neighborData;
    el.connections.innerHTML =
      connColumn('Outgoing', m.outDegree, m.outSynapses, m.out) +
      connColumn('Incoming', m.inDegree, m.inSynapses, m.in);
  }
  function connColumn(label, degree, synapses, edges) {
    const rows = edges.slice(0, 6).map(e => {
      const name = dicts.cell_type[labels.cellType[e.j]];
      const sign = e.w >= 0 ? '+' : '−';
      return `<div class="conn-row"><span>${esc(name)}</span><span class="mono">${sign}${e.synapses}</span></div>`;
    }).join('');
    return `<div class="conn-col"><h4>${label} <span class="mono">${degree.toLocaleString()}</span> cells · <span class="mono">${synapses.toLocaleString()}</span> synapses</h4>${rows || '<p class="dim">none</p>'}</div>`;
  }

  function renderInvolvement() {
    if (selected < 0) return;
    const i = selected;
    const rows = [];
    let member = null;
    for (const name of CHANNEL_NAMES) {
      const c = channels.channels[name];
      if (c?.all.includes(i)) { member = name; break; }
    }
    if (member) {
      const c = channels.channels[member];
      const channelHz = dec.chanRate(hz, member);
      rows.push(`<p><b>Member of the <code>${member}</code> channel</b> (${c.all.length} cell${c.all.length === 1 ? '' : 's'} — ${esc(c.desc)}). ` +
        `Channel mean rate now: <span class="mono">${channelHz.toFixed(1)} Hz</span>. This neuron: <span class="mono">${hz[i].toFixed(1)} Hz</span>.</p>`);
    } else {
      rows.push('<p class="dim">Not a member of any of the eight named descending/motor channels.</p>');
    }
    if (neighborData) {
      let hit = null;
      for (const name of CHANNEL_NAMES) {
        const c = channels.channels[name];
        if (!c) continue;
        const n = neighborData.out.filter(e => c.all.includes(e.j)).length;
        if (n) { hit = { name, n }; break; }
      }
      if (hit) {
        const shown = neighborData.out.length, total = neighborData.outDegree;
        const caveat = total > shown ? ` (among its ${shown} strongest of ${total} outgoing connections)` : '';
        rows.push(`<p>Projects directly to <span class="mono">${hit.n}</span> cell${hit.n === 1 ? '' : 's'} in the <code>${hit.name}</code> channel${caveat}.</p>`);
      } else {
        rows.push(`<p class="dim">No direct projection to a named channel found among its ${neighborData.out.length} strongest outgoing connections.</p>`);
      }
    }
    el.involvement.innerHTML = rows.join('');
  }

  el.search.addEventListener('input', () => renderResults(el.search.value));
  el.search.addEventListener('focus', () => { if (el.search.value.trim()) el.results.classList.add('open'); });
  document.addEventListener('click', e => {
    if (!e.target.closest('.ins-search-wrap')) el.results.classList.remove('open');
  });
  renderStatic();

  return { select, clearSelection, onNeighbors, sampleHistory, get selectedIndex() { return selected; } };
}
