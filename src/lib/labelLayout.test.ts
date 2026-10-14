import { describe, expect, it } from 'vitest';
import { LABEL_MAX_WIDTH, labelWidth, placeLabels, type LabelPin } from './labelLayout';

const SIZE = { width: 600, height: 400 };
const MOBILE = { width: 343, height: 320 };
const pin = (key: string, x: number, y: number, extra: Partial<LabelPin> = {}): LabelPin => ({
  key,
  x,
  y,
  name: key,
  selected: false,
  ...extra,
});

describe('labelWidth', () => {
  it('counts CJK characters as wider and caps long names', () => {
    expect(labelWidth('蜀味小馆')).toBeGreaterThan(labelWidth('Taco'));
    expect(labelWidth('The Very Long Name of a Neighborhood Bistro and Wine Bar')).toBe(
      LABEL_MAX_WIDTH,
    );
    expect(labelWidth('Taco', true)).toBeGreaterThan(labelWidth('Taco'));
  });
});

describe('placeLabels', () => {
  it('names a lone pin on its right', () => {
    expect(placeLabels([pin('Taco Stop', 300, 200)], SIZE).get('Taco Stop')).toEqual({
      side: 'right',
      maxWidth: labelWidth('Taco Stop'),
      dy: 0,
    });
  });

  it('flips labels near the right edge to the left, inside the map', () => {
    const labels = placeLabels([pin('Noodle Corner', 590, 200)], SIZE);
    expect(labels.get('Noodle Corner')?.side).toBe('left');
    // Near the left edge the label stays on the right.
    expect(placeLabels([pin('Noodle Corner', 5, 200)], SIZE).get('Noodle Corner')?.side).toBe(
      'right',
    );
  });

  it('labels pins in all four corners without leaving the map', () => {
    const corners = [
      pin('NW', 20, 45),
      pin('NE', 580, 45),
      pin('SW', 20, 395),
      pin('SE', 580, 395),
    ];
    const labels = placeLabels(corners, SIZE);
    expect([...labels.keys()].sort()).toEqual(['NE', 'NW', 'SE', 'SW']);
    expect(labels.get('NE')?.side).toBe('left');
    expect(labels.get('NW')?.side).toBe('right');
  });

  it('leaves out names that would overlap, keeping those nearest the center', () => {
    // Three pins almost on top of each other: two names fit, on either side.
    const labels = placeLabels(
      [
        pin('Far Cafe', 330, 120),
        pin('Center Deli', 300, 200),
        pin('Close Bar', 302, 203),
        pin('Third Pub', 304, 206),
      ],
      SIZE,
    );
    expect(labels.get('Center Deli')?.side).toBe('right');
    expect(labels.get('Close Bar')?.side).toBe('left');
    expect(labels.has('Third Pub')).toBe(false);
    expect(labels.has('Far Cafe')).toBe(true);
  });

  it('puts a label on the other side instead of over a neighboring pin', () => {
    // A pin just right of A: A's name goes left rather than cover it.
    const labels = placeLabels([pin('A', 300, 200), pin('B', 340, 200)], SIZE);
    expect(labels.get('A')?.side).toBe('left');
    expect(labels.get('B')?.side).toBe('right');
  });

  it('always names the selected restaurant, even where others crowd it', () => {
    const crowd = [0, 1, 2, 3, 4, 5].map((i) => pin(`Crowd ${i}`, 290 + i * 4, 200));
    const labels = placeLabels(
      [...crowd, pin('Selected Spot', 300, 200, { selected: true })],
      SIZE,
    );
    expect(labels.get('Selected Spot')).toBeDefined();
    // At most one of the crowd fits beside it.
    expect(crowd.filter((p) => labels.has(p.key)).length).toBeLessThanOrEqual(1);
  });

  it('keeps the selected name inside a narrow (mobile) map, truncating if needed', () => {
    const name = '一个名字非常非常长的川菜馆子（休斯顿莱斯大学店）';
    for (const x of [8, MOBILE.width / 2, MOBILE.width - 8]) {
      const label = placeLabels([pin(name, x, 160, { name, selected: true })], MOBILE).get(name)!;
      expect(label).toBeDefined();
      const offset = 14;
      const left = label.side === 'right' ? x + offset : x - offset - label.maxWidth;
      const right = label.side === 'right' ? x + offset + label.maxWidth : x - offset;
      expect(left).toBeGreaterThanOrEqual(0);
      expect(right).toBeLessThanOrEqual(MOBILE.width);
      expect(label.maxWidth).toBeGreaterThan(100);
    }
  });

  it('handles long English and Chinese names next to each other', () => {
    const labels = placeLabels(
      [
        pin('en', 200, 200, { name: 'Pappas Bros. Steakhouse & Seafood Downtown' }),
        pin('zh', 200, 240, { name: '蜀味小馆川菜火锅' }),
      ],
      SIZE,
    );
    expect(labels.get('en')).toEqual({ side: 'right', maxWidth: LABEL_MAX_WIDTH, dy: 0 });
    expect(labels.get('zh')?.side).toBe('right');
  });

  /** The label's box in container pixels, as rendered. */
  const rendered = (p: LabelPin, l: { side: string; maxWidth: number; dy: number }) => {
    const h = p.selected ? 24 : 20;
    const top = p.y - (p.selected ? 42 : 30) + l.dy;
    const offset = p.selected ? 14 : 10;
    const left = l.side === 'right' ? p.x + offset : p.x - offset - l.maxWidth;
    return { left, top, right: left + l.maxWidth, bottom: top + h };
  };
  const within = (box: ReturnType<typeof rendered>, size: { width: number; height: number }) => {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(size.width);
    expect(box.bottom).toBeLessThanOrEqual(size.height);
  };

  it('keeps labels inside the map vertically near the top and bottom, the pin unmoved', () => {
    for (const selected of [true, false]) {
      const top = pin('Top', 300, 12, { selected });
      const t = placeLabels([top], SIZE).get('Top')!;
      expect(t.dy).toBeGreaterThan(0);
      within(rendered(top, t), SIZE);
      const bottom = pin('Bottom', 300, SIZE.height + 20, { selected });
      const b = placeLabels([bottom], SIZE).get('Bottom')!;
      expect(b.dy).toBeLessThan(0);
      within(rendered(bottom, b), SIZE);
    }
    // In the middle, no shift.
    expect(placeLabels([pin('Mid', 300, 200)], SIZE).get('Mid')!.dy).toBe(0);
  });

  it('handles the corners in both directions at once, on a phone too', () => {
    const name = '一个名字非常非常长的川菜馆子（休斯顿莱斯大学店）';
    for (const size of [SIZE, MOBILE]) {
      for (const [x, y] of [
        [8, 10],
        [size.width - 8, 10],
        [8, size.height + 30],
        [size.width - 8, size.height + 30],
      ] as const) {
        const p = pin(name, x, y, { name, selected: true });
        const l = placeLabels([p], size).get(name)!;
        within(rendered(p, l), size);
        expect(l.side).toBe(x < size.width / 2 ? 'right' : 'left');
      }
    }
  });

  it('skips pins outside the map without labelling them into view', () => {
    expect(placeLabels([pin('Gone', -50, 200)], SIZE).has('Gone')).toBe(false);
  });
});
