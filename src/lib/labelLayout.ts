/**
 * Placement of restaurant name labels beside map pins, in container pixels.
 * Pure (no Leaflet) so it can be tested directly.
 */

import { pinSize } from './pin';

export type LabelSide = 'right' | 'left';

export interface LabelPin {
  key: string;
  /** The pin tip in container pixels. */
  x: number;
  y: number;
  name: string;
  selected: boolean;
}

export interface LabelPlacement {
  side: LabelSide;
  /** Width available to the label; longer names are truncated to it. */
  maxWidth: number;
  /**
   * Vertical shift (pixels, down when positive) from the label's usual place
   * beside the pin head, so it stays inside the map near the top or bottom
   * edge. The pin itself never moves.
   */
  dy: number;
}

/** Widest a label gets, in pixels (matches `max-w-44` in the CSS). */
export const LABEL_MAX_WIDTH = 176;
/** Labels keep this distance from the map edge. */
const EDGE = 4;
/** Narrowest label worth showing for an unselected pin. */
const MIN_WIDTH = 48;

const labelHeight = (selected: boolean) => (selected ? 24 : 20);
/** Gap between the pin's center line and the label (the label overlaps the pin edge by 2px). */
const labelOffset = (selected: boolean) => pinSize(selected).w / 2 - 2;

/** Approximate rendered width of a name: CJK characters are about twice as wide. */
export function labelWidth(name: string, selected = false): number {
  let units = 0;
  for (const ch of name) units += /[⺀-￿]/.test(ch) ? 2 : 1.1;
  const width = units * (selected ? 7.5 : 6.5) + 14;
  return Math.min(LABEL_MAX_WIDTH, Math.ceil(width));
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
const overlaps = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

function pinBox(p: LabelPin): Box {
  const { w, h } = pinSize(p.selected);
  return { left: p.x - w / 2, right: p.x + w / 2, top: p.y - h, bottom: p.y };
}

/** The label's usual top, beside the pin head (matches the CSS). */
const baseTop = (p: LabelPin) => p.y - pinSize(p.selected).h + (p.selected ? -2 : 0);

function labelBox(p: LabelPin, side: LabelSide, width: number, top: number): Box {
  const offset = labelOffset(p.selected);
  const bottom = top + labelHeight(p.selected);
  return side === 'right'
    ? { left: p.x + offset, right: p.x + offset + width, top, bottom }
    : { left: p.x - offset - width, right: p.x - offset, top, bottom };
}

/**
 * Chooses which pins get a name label and on which side, so that labels stay
 * inside the map, do not overlap each other, and do not cover other pins
 * (which would block clicks on them).
 *
 * Vertically, a label sits beside the pin head, shifted down near the top
 * edge or up near the bottom edge so it stays inside the map (`dy`).
 *
 * The selected pin is placed first and always gets a label: on the side with
 * room (truncated to fit when neither side has room for the whole name),
 * preferring a side that covers nothing. The others follow nearest the map
 * center first, on the right when the whole name fits there and on the left
 * otherwise (truncated only when neither side has room for it); a pin
 * with no free side keeps its pin without a label (its name is still its
 * tooltip, and the list below the map names every restaurant in view).
 */
export function placeLabels(
  pins: LabelPin[],
  size: { width: number; height: number },
): Map<string, LabelPlacement> {
  const result = new Map<string, LabelPlacement>();
  const cx = size.width / 2;
  const cy = size.height / 2;
  const ordered = [...pins].sort(
    (a, b) =>
      Number(b.selected) - Number(a.selected) ||
      Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy),
  );
  const inView = (p: LabelPin) =>
    p.x >= 0 && p.x <= size.width && p.y >= 0 && p.y <= size.height + pinSize(p.selected).h;
  // Pins in view are obstacles for every label but their own.
  const pinBoxes = pins.filter(inView).map((p) => ({ key: p.key, box: pinBox(p) }));
  const placed: Box[] = [];

  const room = (p: LabelPin, side: LabelSide) => {
    const offset = labelOffset(p.selected);
    const space = side === 'right' ? size.width - EDGE - (p.x + offset) : p.x - offset - EDGE;
    return Math.min(labelWidth(p.name, p.selected), Math.floor(space));
  };
  // Pins stacked on this one cannot be avoided, so they do not count.
  const free = (p: LabelPin, box: Box) => {
    const own = pinBox(p);
    return (
      !placed.some((b) => overlaps(b, box)) &&
      !pinBoxes.some((o) => o.key !== p.key && !overlaps(o.box, own) && overlaps(o.box, box))
    );
  };
  const inside = (box: Box) => box.top >= 0 && box.bottom <= size.height;
  /** The label's top, kept inside the map vertically. */
  const topFor = (p: LabelPin) =>
    Math.max(EDGE, Math.min(baseTop(p), size.height - EDGE - labelHeight(p.selected)));

  for (const p of ordered.filter(inView)) {
    const full = labelWidth(p.name, p.selected);
    const top = topFor(p);
    const options = (['right', 'left'] as const).map((side) => {
      const maxWidth = room(p, side);
      return { side, maxWidth, box: labelBox(p, side, Math.max(maxWidth, 0), top) };
    });
    let choice: (typeof options)[number] | undefined;
    if (p.selected) {
      // Whole name and nothing covered, then whole name, then the most room.
      choice =
        options.find((o) => o.maxWidth >= full && free(p, o.box)) ??
        options.find((o) => o.maxWidth >= full) ??
        [...options].sort((a, b) => b.maxWidth - a.maxWidth)[0];
    } else {
      // The whole name if a side allows it, else a truncated one near an edge.
      const fits = (o: (typeof options)[number], min: number) =>
        o.maxWidth >= min && inside(o.box) && free(p, o.box);
      choice =
        options.find((o) => fits(o, full)) ??
        options.find((o) => fits(o, Math.min(full, MIN_WIDTH)));
    }
    if (!choice || choice.maxWidth <= 0) continue;
    placed.push(choice.box);
    result.set(p.key, { side: choice.side, maxWidth: choice.maxWidth, dy: top - baseTop(p) });
  }
  return result;
}
