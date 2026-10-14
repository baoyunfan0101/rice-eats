import bowl96 from '../assets/rice-bowl-96.png';
import bowl144 from '../assets/rice-bowl-144.png';
import { pixelRuns, WORDMARK_COLORS, WORDMARK_GRID } from '../lib/pixelArt';

/** The rice bowl with eyes (decorative: the wordmark or the text beside it names things). */
export function BowlMark({ className = '' }: { className?: string }) {
  return (
    <img
      src={bowl96}
      srcSet={`${bowl96} 96w, ${bowl144} 144w`}
      sizes="48px"
      width={96}
      height={96}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={className}
    />
  );
}

/** The arcade wordmark: RICE in rice white, EATS in gold. */
function Wordmark({ className = '' }: { className?: string }) {
  const width = WORDMARK_GRID[0]!.length;
  return (
    <svg
      viewBox={`0 0 ${width} ${WORDMARK_GRID.length}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {Object.entries(WORDMARK_COLORS).map(([char, color]) => (
        <g key={char} fill={color}>
          {pixelRuns(WORDMARK_GRID, char).map((r) => (
            <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.width} height={1} />
          ))}
        </g>
      ))}
    </svg>
  );
}

/** The Rice Eats logo: the rice bowl and the pixel wordmark. */
export function Logo() {
  return (
    <span className="flex items-center gap-1.5">
      <BowlMark className="size-10 sm:size-12" />
      <Wordmark className="h-[22px] w-auto sm:h-[28px]" />
    </span>
  );
}
