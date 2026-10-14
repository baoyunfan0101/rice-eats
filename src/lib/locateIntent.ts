// "Last user intent wins" for moving the map: the area controls (presets,
// current location, address search) and the map itself (dragging, zooming)
// share one LocateIntent. Every action by the contributor starts a new
// generation; an asynchronous answer (a search result or error, a device
// location) applies only if no newer action happened since it was asked for.
// Programmatic map moves (setView after a preset, a search, a selection, or
// restoring the view) are not actions and never start a generation.

export class LocateIntent {
  private generation = 0;
  private controller?: AbortController;
  private listeners = new Set<() => void>();

  /**
   * Starts a new action: cancels the pending request and makes every older
   * answer stale. Returns the action's generation and a signal for its request.
   */
  begin(): { generation: number; signal: AbortSignal } {
    this.controller?.abort();
    this.controller = new AbortController();
    return { generation: ++this.generation, signal: this.controller.signal };
  }

  /** Whether an answer for this generation may still apply. */
  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  /**
   * The contributor moved the map (or chose a restaurant) directly: pending
   * answers no longer apply, and listeners clear their pending state.
   */
  interrupt(): void {
    this.begin();
    for (const listener of this.listeners) listener();
  }

  /** Called on interrupt(); returns an unsubscribe function. */
  onInterrupt(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
