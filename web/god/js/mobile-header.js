/* Phase 7 (mobile): let the tab row (World/Neural/Experiment/Evolution --
   none of which do anything on this page except the last, which is simply
   disabled) collapse away on phones, since it is the one part of the
   pinned header that is pure navigation chrome, not status.

   This never affects the desktop layout: #btnTabsToggle is display:none
   outside @media (max-width:760px) (style.css, same pattern as
   .mobile-only-notice), so the click handler below never fires there, and
   `--header-h` is only ever *read* by CSS rules that are themselves inside
   that same media query -- writing it on a desktop-width page is inert.

   The single fact this needs to track is the header's own rendered
   height, whatever causes it to change: the collapse toggle here, but
   also anything else that could (a slow Google Fonts swap changing text
   metrics, a rotation, a future header edit). A ResizeObserver on the
   header, feeding one CSS custom property that both `.center`'s `top` and
   `main`'s `padding-top` are computed from (style.css), keeps those two
   values from ever needing to be kept in sync by hand. */
const STORAGE_KEY = 'neural-god-mobile-tabs-collapsed';

function readCollapsed() {
  try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch (_) { return false; }
}
function writeCollapsed(v) {
  try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); } catch (_) { /* private mode */ }
}

export function bindMobileTabsCollapse() {
  const header = document.querySelector('header.top');
  const btn = document.getElementById('btnTabsToggle');
  if (!header || !btn) return;

  new ResizeObserver(entries => {
    const h = entries[0].borderBoxSize?.[0]?.blockSize ?? header.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--header-h', `${h}px`);
  }).observe(header);

  function apply(collapsed) {
    header.classList.toggle('tabs-collapsed', collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
  }

  apply(readCollapsed());   // restored state; a no-op visually above 760px, same as the button itself

  btn.addEventListener('click', () => {
    const collapsed = !header.classList.contains('tabs-collapsed');
    apply(collapsed);
    writeCollapsed(collapsed);
  });
}
