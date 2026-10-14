import { BOWL_COLORS, BOWL_GRID, pixelRuns } from '../lib/pixelArt';

/** The pixel rice bowl (decorative: the wordmark beside it names the site). */
export function BowlMark({ className = '' }: { className?: string }) {
  const width = BOWL_GRID[0].length;
  return (
    <svg
      viewBox={`0 0 ${width} ${BOWL_GRID.length}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {Object.entries(BOWL_COLORS).map(([char, color]) => (
        <g key={char} fill={color}>
          {pixelRuns(BOWL_GRID, char).map((r) => (
            <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.width} height={1} />
          ))}
        </g>
      ))}
    </svg>
  );
}

/** The Rice Eats logo: the bowl on a gold tile and the pixel wordmark. */
export function Logo() {
  return (
    <span className="flex items-center gap-2.5">
      <span className="flex size-10 items-center justify-center border-2 border-ink bg-gold-300 shadow-px-sm">
        <BowlMark className="size-7" />
      </span>
      <span className="font-pixel text-xl leading-none font-bold whitespace-nowrap">
        Rice <span className="text-chili-600">Eats</span>
      </span>
    </span>
  );
}
