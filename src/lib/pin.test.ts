import { describe, expect, it } from 'vitest';
import { PIN_SVG, pinIconOptions, pinSize } from './pin';

describe('map pin', () => {
  it.each([false, true])(
    'is anchored at the tip, the bottom center of its box (selected: %s)',
    (selected) => {
      const { iconSize, iconAnchor } = pinIconOptions(selected);
      expect(iconSize).toEqual([pinSize(selected).w, pinSize(selected).h]);
      expect(iconAnchor).toEqual([iconSize[0] / 2, iconSize[1]]);
    },
  );

  it('draws whole grid cells that fill the box exactly, with the tip centered on the last row', () => {
    const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(PIN_SVG)!;
    const [columns, rows] = [Number(viewBox[1]), Number(viewBox[2])];
    for (const selected of [false, true]) {
      const { w, h } = pinSize(selected);
      expect(Number.isInteger(w / columns)).toBe(true);
      expect(w / columns).toBe(h / rows);
    }
    // The outline cells of the last row: symmetric around the center line.
    const last = [...PIN_SVG.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)"/g)]
      .map(([, x, y, width]) => ({ x: Number(x), y: Number(y), width: Number(width) }))
      .filter((r) => r.y === rows - 1);
    expect(last).toHaveLength(1);
    expect(last[0]!.x + last[0]!.width / 2).toBe(columns / 2);
  });

  it('keeps the selected and unselected states apart by class only', () => {
    expect(pinIconOptions(false).className).toBe('map-pin');
    expect(pinIconOptions(true).className).toBe('map-pin is-selected');
    expect(pinIconOptions(true, '<span>x</span>').html).toBe(`${PIN_SVG}<span>x</span>`);
  });
});
