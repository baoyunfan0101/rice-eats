// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import L from 'leaflet';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import PickerMap from './PickerMap';

// The real Leaflet map (App.test.tsx uses a stub): programmatic moves must
// never count as the contributor moving the map; gestures and controls must.
describe('PickerMap user moves', () => {
  // jsdom has no layout; Leaflet needs a map size.
  const sizes = ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight'] as const;
  beforeAll(() => {
    // jsdom cannot run Leaflet's own zooms and pans (no layout); the map still
    // receives the events, so this only checks what PickerMap reports.
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
  const RICE = { center: { lat: 29.7174, lng: -95.4018 }, zoom: 15 };
  const setup = () => {
    const onUserMove = vi.fn();
    const onMove = vi.fn();
    const view = (v: typeof RICE) => (
      <PickerMap label="测试地图" view={v} onMove={onMove} onUserMove={onUserMove} />
    );
    const result = render(view(RICE));
    const container = result.container.querySelector('.leaflet-container') as HTMLElement;
    return {
      onUserMove,
      onMove,
      container,
      rerender: (v: typeof RICE) => result.rerender(view(v)),
    };
  };

  it('ignores programmatic moves (a new view from a preset, search, selection, or restore)', () => {
    const { onUserMove, onMove, rerender } = setup();
    act(() => rerender({ center: { lat: 29.704, lng: -95.556 }, zoom: 15 }));
    act(() => rerender({ center: { lat: 29.7333, lng: -95.4123 }, zoom: 16 }));
    expect(onMove).toHaveBeenCalled();
    expect(onUserMove).not.toHaveBeenCalled();
  });

  it('reports wheel and pinch zooms, double clicks, map keys, and the zoom buttons', () => {
    const { onUserMove, container } = setup();
    container.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    expect(onUserMove).toHaveBeenCalledTimes(1);
    container.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(onUserMove).toHaveBeenCalledTimes(2);
    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    container.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
    expect(onUserMove).toHaveBeenCalledTimes(4);
    // Other keys (e.g. Tab to move focus) are not map moves.
    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(onUserMove).toHaveBeenCalledTimes(4);
    const touch = new Event('touchstart', { bubbles: true }) as Event & { touches: unknown[] };
    Object.defineProperty(touch, 'touches', { value: [{}, {}] });
    container.dispatchEvent(touch);
    expect(onUserMove).toHaveBeenCalledTimes(5);
    (container.querySelector('.leaflet-control-zoom-in') as HTMLElement).click();
    expect(onUserMove).toHaveBeenCalledTimes(6);
  });

  it('ignores a one-finger touch (a tap or the start of a drag reported by Leaflet)', () => {
    const { onUserMove, container } = setup();
    const touch = new Event('touchstart', { bubbles: true }) as Event & { touches: unknown[] };
    Object.defineProperty(touch, 'touches', { value: [{}] });
    container.dispatchEvent(touch);
    expect(onUserMove).not.toHaveBeenCalled();
  });
});
