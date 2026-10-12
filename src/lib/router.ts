// Minimal History API router. The site has three kinds of pages (browsing,
// restaurant details, and the submission page), so a routing library would be overkill.

import { useSyncExternalStore } from 'react';

const BASE = import.meta.env.BASE_URL; // "/rice-eats/" in production

export type Route =
  | { kind: 'browse'; params: URLSearchParams }
  | { kind: 'restaurant'; id: string }
  | { kind: 'submit'; restaurantId?: string }
  | { kind: 'notFound' };

export function parseRoute(pathname: string, search: string): Route {
  const relative = pathname.startsWith(BASE)
    ? pathname.slice(BASE.length)
    : pathname.replace(/^\//, '');
  const parts = relative.split('/').filter(Boolean);
  if (parts.length === 0) return { kind: 'browse', params: new URLSearchParams(search) };
  if (parts.length === 2 && parts[0] === 'r') {
    return { kind: 'restaurant', id: decodeURIComponent(parts[1]!) };
  }
  if (parts.length === 1 && parts[0] === 'submit') {
    const restaurantId = new URLSearchParams(search).get('restaurant') ?? undefined;
    return { kind: 'submit', ...(restaurantId ? { restaurantId } : {}) };
  }
  return { kind: 'notFound' };
}

export function browseHref(params?: URLSearchParams): string {
  const query = params?.toString();
  return query ? `${BASE}?${query}` : BASE;
}

export function restaurantHref(id: string): string {
  // Trailing slash: GitHub Pages serves r/<id>/index.html there without a redirect.
  return `${BASE}r/${encodeURIComponent(id)}/`;
}

/** The submission page, optionally about one restaurant (by its stable id). */
export function submitHref(restaurantId?: string): string {
  const query = restaurantId ? `?${new URLSearchParams({ restaurant: restaurantId })}` : '';
  return `${BASE}submit/${query}`;
}

const listeners = new Set<() => void>();
function notify() {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}
const getHref = () => window.location.pathname + window.location.search;

export function useLocationHref(): string {
  return useSyncExternalStore(subscribe, getHref, getHref);
}

interface NavigateOptions {
  replace?: boolean;
}

/** In-app navigation entries are marked so "back" can return to the previous page. */
export function navigate(href: string, options: NavigateOptions = {}): void {
  if (href === getHref()) return;
  const state = { inApp: true };
  if (options.replace) window.history.replaceState(state, '', href);
  else window.history.pushState(state, '', href);
  notify();
}

/** True when the current entry was reached through in-app navigation. */
export function canGoBack(): boolean {
  return Boolean((window.history.state as { inApp?: boolean } | null)?.inApp);
}

/** Click handler for <a> elements that keeps modified clicks (new tab etc.) native. */
export function handleLinkClick(event: React.MouseEvent<HTMLAnchorElement>, href: string) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  event.preventDefault();
  navigate(href);
}
