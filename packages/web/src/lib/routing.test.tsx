import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHook } from '../test-helpers';
import { ROUTE_HREF, ROUTE_TITLE, parseRoute, useRoute } from './routing';

function goTo(hash: string): void {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new Event('hashchange'));
  });
}

afterEach(() => {
  window.location.hash = '';
});

describe('parseRoute', () => {
  it('treats the canonical forms as the three views', () => {
    expect(parseRoute('#/')).toBe('dump');
    expect(parseRoute('#/flash')).toBe('flash');
    expect(parseRoute('#/preserve')).toBe('preserve');
  });

  it('still understands the original page hashes', () => {
    expect(parseRoute('#dump')).toBe('dump');
    expect(parseRoute('#flash')).toBe('flash');
  });

  it('falls back to the read-only view for anything else', () => {
    expect(parseRoute('')).toBe('dump');
    expect(parseRoute('#')).toBe('dump');
    expect(parseRoute('#/nonsense')).toBe('dump');
    expect(parseRoute('#/FLASH/')).toBe('flash');
    expect(parseRoute('#/PRESERVE/')).toBe('preserve');
  });
});

describe('useRoute', () => {
  it('starts on the dump view and follows hashchange both ways', () => {
    window.location.hash = '';
    const { result, unmount } = renderHook(() => useRoute());
    expect(result.current).toBe('dump');
    expect(document.title).toBe(ROUTE_TITLE.dump);

    goTo(ROUTE_HREF.flash);
    expect(result.current).toBe('flash');
    expect(document.title).toBe(ROUTE_TITLE.flash);

    goTo(ROUTE_HREF.dump);
    expect(result.current).toBe('dump');
    expect(document.title).toBe(ROUTE_TITLE.dump);

    unmount();
  });

  it('stops listening once unmounted', () => {
    window.location.hash = '';
    const { result, unmount } = renderHook(() => useRoute());
    unmount();
    goTo(ROUTE_HREF.flash);
    expect(result.current).toBe('dump');
  });
});
