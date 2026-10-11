// Loads generated content (public/generated) with a small in-memory cache.

import { useEffect, useState } from 'react';
import type { ContentIndex, RestaurantDetail } from '../content/model';

const BASE = import.meta.env.BASE_URL;

export type Loadable<T> =
  | { status: 'loading' }
  | { status: 'error'; error: string; notFound?: boolean }
  | { status: 'ready'; data: T };

const cache = new Map<string, Promise<unknown>>();

class NotFoundError extends Error {}

async function fetchJson<T>(path: string): Promise<T> {
  let promise = cache.get(path) as Promise<T> | undefined;
  if (!promise) {
    promise = fetch(`${BASE}${path}`).then(async (response) => {
      if (response.status === 404) throw new NotFoundError(path);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as T;
    });
    // Failed requests are not cached, so "retry" works.
    promise.catch(() => cache.delete(path));
    cache.set(path, promise);
  }
  return promise;
}

export function clearContentCache() {
  cache.clear();
}

function useJson<T>(path: string | undefined, attempt: number): Loadable<T> {
  const [state, setState] = useState<{ key: string; value: Loadable<T> }>();
  const key = `${path}#${attempt}`;
  useEffect(() => {
    if (!path) return;
    let active = true;
    fetchJson<T>(path).then(
      (data) => active && setState({ key, value: { status: 'ready', data } }),
      (error: unknown) =>
        active &&
        setState({
          key,
          value: {
            status: 'error',
            error: String(error),
            notFound: error instanceof NotFoundError,
          },
        }),
    );
    return () => {
      active = false;
    };
  }, [path, key]);
  return state?.key === key ? state.value : { status: 'loading' };
}

export function useContentIndex(attempt = 0): Loadable<ContentIndex> {
  return useJson<ContentIndex>('generated/index.json', attempt);
}

export function useRestaurantDetail(id: string, attempt = 0): Loadable<RestaurantDetail> {
  return useJson<RestaurantDetail>(`generated/restaurants/${encodeURIComponent(id)}.json`, attempt);
}
