import { useEffect, useRef, useState, type ReactNode } from 'react';

export type SheetState = 'collapsed' | 'half' | 'expanded';

/** Visible height of the collapsed sheet: the handle and the search field. */
export const COLLAPSED_HEIGHT = 128;
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
 * expanded). It is dragged by its top bar only, so scrolling the list inside
 * never fights the drag; the handle is also a button (cycling the states) and
 * the bar has explicit buttons, so no gesture is required. `onHeight` reports
 * the visible height so the map can keep its contents clear of the sheet.
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
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest('button, input, select, a')) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    samples.current = [{ y: e.clientY, t: e.timeStamp }];
    setDrag({ startY: e.clientY, startHeight: resting, height: resting });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    samples.current = [...samples.current.slice(-4), { y: e.clientY, t: e.timeStamp }];
    const next = drag.startHeight + (drag.startY - e.clientY);
    setDrag({ ...drag, height: Math.min(Math.max(next, COLLAPSED_HEIGHT), expandedHeight) });
  };
  const onPointerUp = () => {
    if (!drag) return;
    const s = samples.current;
    const first = s[0]!;
    const last = s[s.length - 1]!;
    // Upward velocity in px/ms: a flick moves one state in its direction.
    const velocity = last.t > first.t ? (first.y - last.y) / (last.t - first.t) : 0;
    let target: SheetState;
    if (Math.abs(velocity) > 0.5) {
      const i = STATES.indexOf(state);
      target = STATES[Math.min(Math.max(i + (velocity > 0 ? 1 : -1), 0), 2)]!;
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

  const cycle = () =>
    onState(state === 'collapsed' ? 'half' : state === 'half' ? 'expanded' : 'half');
  return (
    <div
      ref={container}
      role="region"
      aria-label="餐厅列表面板"
      data-state={state}
      className="absolute inset-x-0 bottom-0 z-[1100] flex flex-col overflow-hidden rounded-t-2xl bg-paper shadow-[0_-4px_24px_rgba(0,0,0,0.18)] motion-safe:transition-[height] motion-safe:duration-200 data-dragging:transition-none"
      data-dragging={drag ? '' : undefined}
      style={{ height: visible || undefined, paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div
        className="flex shrink-0 touch-none items-center justify-between gap-2 px-4 pt-2 pb-1 select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <span className="w-16" />
        <button
          type="button"
          onClick={cycle}
          aria-label={`${LABELS[state]}，点按${state === 'expanded' ? '半展开' : '展开'}`}
          className="flex h-6 w-16 items-center justify-center"
        >
          <span aria-hidden="true" className="h-1.5 w-10 rounded-full bg-muted/50" />
        </button>
        {state === 'collapsed' ? (
          <button
            type="button"
            onClick={() => onState('half')}
            className="w-16 text-right text-sm font-semibold text-chili-700"
          >
            展开
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onState('collapsed')}
            className="w-16 text-right text-sm font-semibold text-chili-700"
          >
            看地图
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
