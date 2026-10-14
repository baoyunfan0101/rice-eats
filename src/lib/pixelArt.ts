// Pixel art drawn from text grids: one character per cell, one rect per
// horizontal run of a character. Used for the logo and the map pins.

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

/** The Rice Eats bowl: steam, a mound of rice, a tomato bowl with a gold band. */
export const BOWL_GRID = [
  '     s    s     ',
  '      s    s    ',
  '     s    s     ',
  '    ########    ',
  '  ##wwwwwwww##  ',
  ' #wwwwwwwwwwww# ',
  '################',
  '#rrrrrrrrrrrrrr#',
  '#yyyyyyyyyyyyyy#',
  ' #rrrrrrrrrrrr# ',
  '  ##rrrrrrrr##  ',
  '    ########    ',
  '     #yyyy#     ',
  '     ######     ',
] as const;

/** Colors of the bowl's characters (the design tokens' values). */
export const BOWL_COLORS: Record<string, string> = {
  '#': '#242238',
  w: '#fffcf4',
  r: '#da6548',
  y: '#f6c858',
  s: '#9a93a8',
};
