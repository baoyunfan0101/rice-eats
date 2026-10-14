// Pixel art drawn from text grids: one character per cell, one rect per
// horizontal run of a character. Used for the wordmark, the icons, and the map pins.

export interface PixelRun {
  x: number;
  y: number;
  width: number;
}

/** The horizontal runs of `char` in `grid`, row by row. */
export function pixelRuns(grid: readonly string[], char: string): PixelRun[] {
  const runs: PixelRun[] = [];
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== char) continue;
      let end = x;
      while (row[end + 1] === char) end++;
      runs.push({ x, y, width: end - x + 1 });
      x = end;
    }
  });
  return runs;
}

/** SVG rects (as markup) for the runs of `char`. */
export const pixelRects = (grid: readonly string[], char: string) =>
  pixelRuns(grid, char)
    .map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="1"/>`)
    .join('');

/** 6 × 7 letter shapes of the wordmark. */
const LETTERS: Record<string, readonly string[]> = {
  R: ['#####.', '##..##', '##..##', '#####.', '##.##.', '##..##', '##..##'],
  I: ['######', '..##..', '..##..', '..##..', '..##..', '..##..', '######'],
  C: ['.#####', '##....', '##....', '##....', '##....', '##....', '.#####'],
  E: ['######', '##....', '##....', '#####.', '##....', '##....', '######'],
  A: ['.####.', '##..##', '##..##', '######', '##..##', '##..##', '##..##'],
  T: ['######', '..##..', '..##..', '..##..', '..##..', '..##..', '..##..'],
  S: ['.#####', '##....', '##....', '.####.', '....##', '....##', '#####.'],
};
const LETTER_GAP = 3;
const WORD_GAP = 6;

/**
 * The arcade wordmark "RICE EATS" as a grid: letters filled with `fill` (RICE)
 * and `gold` (EATS), their top two rows lighter (`W`, `G`), an ink outline
 * (`#`), and a two-step drop shadow (`d`, then ink).
 */
export const WORDMARK_GRID: readonly string[] = (() => {
  const letters: { x: number; y: number; word: 0 | 1 }[] = [];
  let x = 1;
  ['RICE', 'EATS'].forEach((word, w) => {
    for (const ch of word) {
      LETTERS[ch]!.forEach((row, y) =>
        [...row].forEach(
          (c, dx) => c === '#' && letters.push({ x: x + dx, y: y + 1, word: w as 0 | 1 }),
        ),
      );
      x += 6 + LETTER_GAP;
    }
    x += WORD_GAP - LETTER_GAP;
  });
  const width = x - WORD_GAP + 1 + 2;
  const height = 7 + 2 + 2;
  const grid = Array.from({ length: height }, () => Array<string>(width).fill(' '));
  const around = (cx: number, cy: number) =>
    [-1, 0, 1].flatMap((a) => [-1, 0, 1].map((b) => [cx + a, cy + b] as const));
  const set = (cx: number, cy: number, c: string) => {
    if (grid[cy]?.[cx] !== undefined) grid[cy]![cx] = c;
  };
  for (const l of letters) for (const [ox, oy] of around(l.x, l.y)) set(ox + 2, oy + 2, '#');
  for (const l of letters) for (const [ox, oy] of around(l.x, l.y)) set(ox + 1, oy + 1, 'd');
  for (const l of letters) for (const [ox, oy] of around(l.x, l.y)) set(ox, oy, '#');
  for (const l of letters) {
    const light = l.y < 3;
    set(l.x, l.y, l.word === 0 ? (light ? 'W' : 'w') : light ? 'G' : 'g');
  }
  return grid.map((row) => row.join(''));
})();

/** Colors of the wordmark's characters (the design tokens' values). */
export const WORDMARK_COLORS: Record<string, string> = {
  '#': '#242238',
  d: '#973620',
  w: '#fffcf4',
  W: '#ffffff',
  g: '#f6c858',
  G: '#ffe08a',
};
