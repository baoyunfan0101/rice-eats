// The map pin shared by the discovery map and the submission map: a simple
// pixel location pin (not a food sprite), drawn on an 8 × 10 grid. The SVG
// fills its icon box exactly and the tip is the bottom center of the box, so
// the Leaflet anchor (bottom center) is precisely the pin's tip at any zoom,
// map position, or screen size. Unselected pins use 3px grid cells, selected
// ones 4px.

import { pixelRects } from './pixelArt';

const GRID = [
  '  ####  ',
  ' #oooo# ',
  '#oo..oo#',
  '#oo..oo#',
  '#oooooo#',
  ' #oooo# ',
  '  #oo#  ',
  '  #oo#  ',
  '  #oo#  ',
  '   ##   ',
];
const COLUMNS = 8;
const ROWS = GRID.length;

/** Pixel size of a pin; the tip is at (w / 2, h). */
export const pinSize = (selected: boolean) => {
  const cell = selected ? 4 : 3;
  return { w: COLUMNS * cell, h: ROWS * cell };
};

/** The pin's SVG markup (colors come from CSS: `.pin-fill`, `.pin-dot`). */
export const PIN_SVG =
  `<svg class="pin-shape" viewBox="0 0 ${COLUMNS} ${ROWS}" shape-rendering="crispEdges" aria-hidden="true" focusable="false">` +
  `<g fill="#242238">${pixelRects(GRID, '#')}</g>` +
  `<g class="pin-fill">${pixelRects(GRID, 'o')}</g>` +
  `<g class="pin-dot">${pixelRects(GRID, '.')}</g>` +
  `</svg>`;

/** Leaflet DivIcon options for a pin: the box is the pin, anchored at its tip. */
export function pinIconOptions(selected: boolean, extraHtml = '') {
  const { w, h } = pinSize(selected);
  return {
    className: `map-pin${selected ? ' is-selected' : ''}`,
    html: PIN_SVG + extraHtml,
    iconSize: [w, h] as [number, number],
    iconAnchor: [w / 2, h] as [number, number],
  };
}
