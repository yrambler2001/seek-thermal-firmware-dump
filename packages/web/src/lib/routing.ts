/**
 * Two views, selected by the URL hash — the same shape the original page had,
 * with `#/` and `#/flash` as the canonical forms. The original's `#dump` and
 * `#flash` still resolve, because links to them exist in the wild.
 */

import { useEffect, useState } from 'react';

export type Route = 'dump' | 'flash';

export const ROUTE_HREF: Readonly<Record<Route, string>> = {
  dump: '#/',
  flash: '#/flash',
};

/** Page titles, carried over from the original's `applyView()`. */
export const ROUTE_TITLE: Readonly<Record<Route, string>> = {
  dump: 'Seek Thermal Firmware Dump (WebUSB)',
  flash: 'Seek Thermal Firmware & Flashing (WebUSB)',
};

export function parseRoute(hash: string): Route {
  const cleaned = hash.replace(/^#/, '').replace(/^\//, '').replace(/\/$/, '').toLowerCase();
  return cleaned === 'flash' ? 'flash' : 'dump';
}

export function currentRoute(): Route {
  return parseRoute(typeof location === 'undefined' ? '' : location.hash);
}

/** Subscribes to `hashchange`. No router dependency, and none is needed. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(currentRoute);

  useEffect(() => {
    const onHashChange = (): void => {
      setRoute(currentRoute());
    };
    window.addEventListener('hashchange', onHashChange);
    /* The hash may have changed between the initial render and this effect. */
    onHashChange();
    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  useEffect(() => {
    document.title = ROUTE_TITLE[route];
  }, [route]);

  return route;
}
