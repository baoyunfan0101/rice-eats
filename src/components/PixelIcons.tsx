// Small pixel icons drawn on 8 × 8 grids (decorative; their buttons carry the text).

import { pixelRuns } from '../lib/pixelArt';

function PixelIcon({ grid, className = '' }: { grid: readonly string[]; className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${grid[0]!.length} ${grid.length}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
      className={className}
    >
      {pixelRuns(grid, '#').map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.width} height={1} />
      ))}
    </svg>
  );
}

const CHEVRON = [
  '  #     ',
  '  ##    ',
  '  ###   ',
  '  ####  ',
  '  ####  ',
  '  ###   ',
  '  ##    ',
  '  #     ',
];
const SEARCH = [
  '  ###   ',
  ' #   #  ',
  '#     # ',
  '#     # ',
  '#     # ',
  ' #   #  ',
  '  #### ',
  '      ##',
];
const PIN = [
  '  ####  ',
  ' ##  ## ',
  ' ##  ## ',
  ' ##  ## ',
  '  ####  ',
  '  ####  ',
  '   ##   ',
  '   ##   ',
];
const CHECK = [
  '        ',
  '      ##',
  '     ## ',
  '#   ##  ',
  '## ##   ',
  ' ###    ',
  '  #     ',
  '        ',
];
const CROSS = [
  '        ',
  ' ##  ## ',
  '  ####  ',
  '   ##   ',
  '   ##   ',
  '  ####  ',
  ' ##  ## ',
  '        ',
];
const TARGET = [
  '   ##   ',
  '  ####  ',
  ' ##  ## ',
  '###  ###',
  '###  ###',
  ' ##  ## ',
  '  ####  ',
  '   ##   ',
];
const ARROW_LEFT = [
  '        ',
  '  #     ',
  ' ##     ',
  '########',
  '########',
  ' ##     ',
  '  #     ',
  '        ',
];

export const PixelChevron = (p: { className?: string }) => <PixelIcon grid={CHEVRON} {...p} />;
export const PixelSearch = (p: { className?: string }) => <PixelIcon grid={SEARCH} {...p} />;
export const PixelPin = (p: { className?: string }) => <PixelIcon grid={PIN} {...p} />;
export const PixelCheck = (p: { className?: string }) => <PixelIcon grid={CHECK} {...p} />;
export const PixelCross = (p: { className?: string }) => <PixelIcon grid={CROSS} {...p} />;
export const PixelTarget = (p: { className?: string }) => <PixelIcon grid={TARGET} {...p} />;
export const PixelArrowLeft = (p: { className?: string }) => <PixelIcon grid={ARROW_LEFT} {...p} />;
