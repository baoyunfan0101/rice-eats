import { useEffect, useRef, useState, type ReactNode } from 'react';

export type SheetState = 'collapsed' | 'half' | 'expanded';

/** Visible height of the collapsed sheet: the handle and the search field. */
export const COLLAPSED_HEIGHT = 70;
/** The expanded sheet leaves this much of the map visible above it. */
const EXPANDED_GAP = 56;

/** Visible sheet height for a state, in a container of `height` pixels. */
export function sheetHeight(state: SheetState, height: number): number {
  if (state === 'collapsed') return Math.min(COLLAPSED_HEIGHT, height);
  if (state === 'expanded') return Math.max(height - EXPANDED_GAP, COLLAPSED_HEIGHT);
  return Math.max(Math.round(height * 0.5), COLLAPSED_HEIGHT);
}

const STATES: SheetState[] = ['collapsed', 'half', 'expanded'];
const LABELS: Record<SheetState, string> = {
  collapsed: '列表已收起',
  half: '列表半展开',
  expanded: '列表已展开',
};

/**
 * A mobile bottom sheet over the map, in three states (collapsed, half,
 * expanded), dragged up and down. The drag starts on the handle or on any
 * part of the content marked `data-sheet-drag` (the explorer's search and
 * filter bar) that is not a control, so scrolling the list never fights the
 * drag. The handle is also a button that cycles the states, for keyboards and
 * screen readers. `onHeight` reports the visible height so the map can keep
 * its contents clear of the sheet.
 */
export function BottomSheet({
  state,
  onState,
  onHeight,
  children,
}: {
  state: SheetState;
  onState: (state: SheetState) => void;
  onHeight: (height: number) => void;
  children: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [drag, setDrag] = useState<{ startY: number; startHeight: number; height: number }>();
  const samples = useRef<{ y: number; t: number }[]>([]);

  useEffect(() => {
    const element = container.current?.parentElement;
    if (!element) return;
    const update = () => setHeight(element.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const resting = sheetHeight(state, height);
  const visible = drag ? drag.height : resting;
  useEffect(() => {
    if (height > 0 && !drag) onHeight(resting);
  }, [height, resting, drag, onHeight]);

  const expandedHeight = sheetHeight('expanded', height);
  const cycle = () =>
    onState(state === 'collapsed' ? 'half' : state === 'half' ? 'expanded' : 'half');
  /** A press that becomes a drag once it moves; a tap on the handle cycles the states. */
  const pressed = useRef<{ y: number; id: number; handle: boolean }>(undefined);
  const onPointerDown = (e: React.PointerEvent) => {
    const target = e.target as Element;
    if (!target.closest('[data-sheet-drag]')) return;
    if (target.closest('input, select, a, button:not([data-sheet-handle])')) return;
    // Capture now, so the drag continues when the finger leaves the sheet.
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    pressed.current = {
      y: e.clientY,
      id: e.pointerId,
      handle: !!target.closest('[data-sheet-handle]'),
    };
    samples.current = [{ y: e.clientY, t: e.timeStamp }];
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const press = pressed.current;
    if (!press || press.id !== e.pointerId) return;
    samples.current = [...samples.current.slice(-4), { y: e.clientY, t: e.timeStamp }];
    if (!drag && Math.abs(e.clientY - press.y) < 4) return;
    const next = resting + (press.y - e.clientY);
    setDrag({
      startY: press.y,
      startHeight: resting,
      height: Math.min(Math.max(next, COLLAPSED_HEIGHT), expandedHeight),
    });
  };
  const onPointerUp = () => {
    const press = pressed.current;
    pressed.current = undefined;
    if (!drag) {
      if (press?.handle) cycle();
      return;
    }
    const s = samples.current;
    const first = s[0]!;
    const last = s[s.length - 1]!;
    // Upward velocity in px/ms.
    const velocity = last.t > first.t ? (first.y - last.y) / (last.t - first.t) : 0;
    let target: SheetState;
    if (Math.abs(velocity) > 0.5) {
      // A flick goes to the next state past where the sheet was let go.
      const heights = STATES.map((st) => [st, sheetHeight(st, height)] as const);
      target =
        velocity > 0
          ? (heights.find(([, h]) => h > drag.height)?.[0] ?? 'expanded')
          : ([...heights].reverse().find(([, h]) => h < drag.height)?.[0] ?? 'collapsed');
    } else {
      target = STATES.reduce((best, s2) =>
        Math.abs(sheetHeight(s2, height) - drag.height) <
        Math.abs(sheetHeight(best, height) - drag.height)
          ? s2
          : best,
      );
    }
    setDrag(undefined);
    onState(target);
  };

  return (
    <div
      ref={container}
      role="region"
      aria-label="餐厅列表面板"
      data-state={state}
      data-dragging={drag ? '' : undefined}
      className="absolute inset-x-0 bottom-0 z-[1100] flex flex-col overflow-hidden rounded-t-2xl bg-paper shadow-[0_-4px_24px_rgba(0,0,0,0.18)] motion-safe:transition-[height] motion-safe:duration-200 data-dragging:transition-none"
      style={{ height: visible || undefined, paddingBottom: 'env(safe-area-inset-bottom)' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div data-sheet-drag className="flex shrink-0 touch-none justify-center pt-1.5 select-none">
        <button
          type="button"
          data-sheet-handle
          // Pointer taps are handled with the drag; this covers keyboards and screen readers.
          onClick={(e) => {
            if (e.detail === 0) cycle();
          }}
          aria-label={`${LABELS[state]}，点按${state === 'expanded' ? '半展开' : '展开'}`}
          className="flex h-4 w-20 items-start justify-center"
        >
          <span aria-hidden="true" className="h-1 w-9 rounded-full bg-muted/50" />
        </button>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
