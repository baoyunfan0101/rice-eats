// Moves of a Leaflet map by the visitor, as opposed to programmatic ones.
// Leaflet's movestart, moveend, and zoomend also fire for setView and
// fitBounds, so they are not used: a drag is Leaflet's dragstart (never fired
// by setView), and a zoom or keyboard pan is recognized from the input that
// causes it (wheel, double click, a two-finger touch, the zoom buttons, or the
// map's keys).

import type L from 'leaflet';

/** Keys Leaflet's keyboard handler pans or zooms with. */
const MAP_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '+', '-', '=', '_']);

/** Calls `onMove` whenever the visitor starts moving the map; returns an unsubscribe function. */
export function onUserMove(map: L.Map, onMove: () => void): () => void {
  const report = () => onMove();
  const container = map.getContainer();
  const onTouch = (e: TouchEvent) => {
    if (e.touches.length > 1) report();
  };
  const onKey = (e: KeyboardEvent) => {
    if (MAP_KEYS.has(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey) report();
  };
  const onClick = (e: MouseEvent) => {
    if ((e.target as Element).closest('.leaflet-control-zoom')) report();
  };
  map.on('dragstart', report);
  container.addEventListener('wheel', report, { passive: true });
  container.addEventListener('dblclick', report);
  container.addEventListener('touchstart', onTouch, { passive: true });
  container.addEventListener('keydown', onKey);
  // Capture: Leaflet's controls stop click propagation.
  container.addEventListener('click', onClick, true);
  return () => {
    map.off('dragstart', report);
    container.removeEventListener('wheel', report);
    container.removeEventListener('dblclick', report);
    container.removeEventListener('touchstart', onTouch);
    container.removeEventListener('keydown', onKey);
    container.removeEventListener('click', onClick, true);
  };
}
