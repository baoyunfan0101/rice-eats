import { describe, expect, it, vi } from 'vitest';
import { LocateIntent } from './locateIntent';

describe('LocateIntent', () => {
  it('makes older generations stale and cancels their requests', () => {
    const intent = new LocateIntent();
    const first = intent.begin();
    expect(intent.isCurrent(first.generation)).toBe(true);
    const second = intent.begin();
    expect(first.signal.aborted).toBe(true);
    expect(intent.isCurrent(first.generation)).toBe(false);
    expect(intent.isCurrent(second.generation)).toBe(true);
  });

  it('interrupts pending work and notifies listeners until they unsubscribe', () => {
    const intent = new LocateIntent();
    const pending = intent.begin();
    const listener = vi.fn();
    const unsubscribe = intent.onInterrupt(listener);
    intent.interrupt();
    expect(pending.signal.aborted).toBe(true);
    expect(intent.isCurrent(pending.generation)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    intent.interrupt();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
