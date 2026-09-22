/* NEURAL GOD -- Brain Regions filter.

   The same eight populations web/js/app.js's own (page-local, unexported)
   REGIONS array defines -- super_class / cell_class membership tests over the
   real FlyWire annotations, re-declared here rather than imported, since a
   page script exports nothing. Labels match web/js/i18n.js's English strings
   for the same keys.

   A neuron a region does not claim is not deleted or hidden by "no filter" --
   REGIONS only decides who gets dimmed when a specific region IS selected. */
export const REGIONS = [
  { id: 'optic-l', label: 'Optic lobe (left)',
    pick: (d, L, i) => d.super_class[L.superClass[i]] === 'optic' && d.side[L.side[i]] === 'left' },
  { id: 'optic-r', label: 'Optic lobe (right)',
    pick: (d, L, i) => d.super_class[L.superClass[i]] === 'optic' && d.side[L.side[i]] === 'right' },
  { id: 'central', label: 'Central brain',
    pick: (d, L, i) => d.super_class[L.superClass[i]] === 'central' },
  { id: 'sez', label: 'Taste centre',
    pick: (d, L, i) => d.cell_class[L.cellClass[i]] === 'gustatory' },
  { id: 'al', label: 'Antennal lobe · smell',
    pick: (d, L, i) => d.cell_class[L.cellClass[i]] === 'ALPN' },
  { id: 'mb', label: 'Mushroom body · memory',
    pick: (d, L, i) => d.cell_class[L.cellClass[i]] === 'Kenyon_Cell' },
  { id: 'cx', label: 'Central complex · navigation',
    pick: (d, L, i) => d.cell_class[L.cellClass[i]] === 'CX' },
  { id: 'dn', label: 'Descending · to the body',
    pick: (d, L, i) => d.super_class[L.superClass[i]] === 'descending' },
];

/* One O(8N) pass at boot (a bounded startup cost, not a per-frame one -- the
   same shape as the bench's own buildRegions()). `membership[i]` is the index
   into REGIONS that claims neuron i, or 255 if none does; also returns each
   region's real count, so the dropdown can say how many cells it covers
   instead of just naming it. */
export function buildRegionMembership(dicts, labels) {
  const N = labels.cellType.length;
  const membership = new Uint8Array(N).fill(255);
  const counts = new Array(REGIONS.length).fill(0);
  for (let r = 0; r < REGIONS.length; r++) {
    const pick = REGIONS[r].pick;
    for (let i = 0; i < N; i++) {
      if (pick(dicts, labels, i)) { membership[i] = r; counts[r]++; }
    }
  }
  return { membership, counts };
}

const DIM_OUT_OF_REGION = 0.12;

/* Writes BrainView.dim (gl.js's own, already-public per-neuron opacity
   multiplier) for the resting glow, and returns the same array so app.js's
   30 Hz activity loop can multiply the *firing* glow by it too -- gl.js's
   shader only ever applies `dim` to the resting term, so without this a
   filtered-out neuron would still flash at full brightness while spiking. */
export function applyRegionFilter(view, membership, regionIndex) {
  const dim = view.dim;
  for (let i = 0; i < dim.length; i++) {
    dim[i] = (regionIndex < 0 || membership[i] === regionIndex) ? 1 : DIM_OUT_OF_REGION;
  }
  view.uploadDim();
  return dim;
}

/* The region (if any) a specific neuron belongs to, for the Inspector's
   detail panel -- reuses the same picks rather than the precomputed
   membership array, since a single lookup does not need the full pass. */
export function regionOf(dicts, labels, i) {
  for (const r of REGIONS) if (r.pick(dicts, labels, i)) return r.label;
  return null;
}
