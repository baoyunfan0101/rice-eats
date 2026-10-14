// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import L from 'leaflet';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RestaurantSummary } from '../../shared/content/model';
import DiscoveryMap, { type MapProps } from './DiscoveryMap';

// The real Leaflet map (App.test.tsx uses a stub): when it fits the results,
// and that a fit waiting for its delay never overrides the visitor.
const r = (id: string, lat: number, lng: number): RestaurantSummary => ({
  id,
  status: 'published',
  name: id,
  altNames: [],
  cuisines: [],
  tags: [],
  links: {},
  location: { lat, lng },
});
const A = r('a', 29.72, -95.4);
const B = r('b', 29.74, -95.39);
const C = r('c', 29.7, -95.55);

describe('DiscoveryMap', () => {
  const sizes = ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight'] as const;
  beforeAll(() => {
    // jsdom has no layout and cannot run Leaflet's own animations or gestures.
    L.Map.mergeOptions({
      scrollWheelZoom: false,
      doubleClickZoom: false,
      keyboard: false,
      touchZoom: false,
      zoomAnimation: false,
      fadeAnimation: false,
    });
    for (const prop of sizes) {
      Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => 400 });
    }
  });
  afterAll(() => {
    for (const prop of sizes)
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
  });
  let fitBounds: ReturnType<typeof vi.spyOn>;
  let setView: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    fitBounds = vi.spyOn(L.Map.prototype, 'fitBounds');
    setView = vi.spyOn(L.Map.prototype, 'setView');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const setup = (initial: Partial<MapProps> = {}) => {
    let props: MapProps = {
      restaurants: [A, B],
      fitKey: 'a,b',
      selected: '',
      focusRequest: 0,
      onSelect: () => {},
      ...initial,
    };
    const result = render(<DiscoveryMap {...props} />);
    const container = result.container.querySelector('.leaflet-container') as HTMLElement;
    const update = (next: Partial<MapProps>) => {
      props = { ...props, ...next };
      act(() => result.rerender(<DiscoveryMap {...props} />));
    };
    const wait = (ms = 300) => act(() => void vi.advanceTimersByTime(ms));
    return { ...result, container, update, wait };
  };

  it('fits at once on load, then after a pause when the results change', () => {
    const { update, wait } = setup();
    expect(fitBounds).toHaveBeenCalledTimes(1);
    update({ restaurants: [A, C], fitKey: 'a,c' });
    expect(fitBounds).toHaveBeenCalledTimes(1);
    wait();
    expect(fitBounds).toHaveBeenCalledTimes(2);
  });

  it('never refits for the same results (a new sort or a re-render)', () => {
    const { update, wait } = setup();
    update({ restaurants: [B, A] });
    update({ selected: 'a' });
    wait();
    expect(fitBounds).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'a wheel zoom',
      (c: HTMLElement) => c.dispatchEvent(new WheelEvent('wheel', { bubbles: true })),
    ],
    [
      'a double click',
      (c: HTMLElement) => c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
    ],
    [
      'the zoom buttons',
      (c: HTMLElement) => (c.querySelector('.leaflet-control-zoom-in') as HTMLElement).click(),
    ],
    [
      'the keyboard',
      (c: HTMLElement) =>
        c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })),
    ],
  ])('lets %s during the pause cancel the pending fit', (_name, gesture) => {
    const { container, update, wait } = setup();
    update({ restaurants: [A, C], fitKey: 'a,c' });
    act(() => gesture(container));
    wait(1000);
    expect(fitBounds).toHaveBeenCalledTimes(1);
    // A later change of results fits again.
    update({ restaurants: [C], fitKey: 'c' });
    wait();
    expect(fitBounds).toHaveBeenCalledTimes(2);
  });

  it('lets the list show a restaurant without a pending fit moving away', () => {
    const { update, wait } = setup();
    update({ restaurants: [A, C], fitKey: 'a,c' });
    update({ selected: 'c', focusRequest: 1 });
    const focused = setView.mock.calls.length;
    expect(focused).toBeGreaterThan(0);
    wait(1000);
    expect(fitBounds).toHaveBeenCalledTimes(1);
  });

  it('runs nothing after unmounting', () => {
    const { update, unmount, wait } = setup();
    update({ restaurants: [A, C], fitKey: 'a,c' });
    unmount();
    wait(1000);
    expect(fitBounds).toHaveBeenCalledTimes(1);
  });

  it('shows the preview only when the overlays leave room for it', () => {
    const { update } = setup({ selected: 'a', insets: { top: 0, bottom: 0 } });
    expect(screen.getByRole('region', { name: 'a 预览' })).toBeInTheDocument();
    // An expanded bottom sheet (the map is 400px tall here).
    update({ insets: { top: 0, bottom: 344 } });
    expect(screen.queryByRole('region', { name: 'a 预览' })).not.toBeInTheDocument();
    // The selection stays, so the preview returns with the room.
    update({ insets: { top: 0, bottom: 200 } });
    expect(screen.getByRole('region', { name: 'a 预览' })).toBeInTheDocument();
  });
});
