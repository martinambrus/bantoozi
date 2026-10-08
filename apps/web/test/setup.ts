import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

import '../src/zod-jitless.js';

// The config has no `globals`, so Testing Library cannot register these itself.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Testing Library drains its async wrapper with setTimeout(0) and advances fake timers only when a
// `jest` global exists; with it, `userEvent.setup({ advanceTimers: vi.advanceTimersByTime })` is exact.
(globalThis as { jest?: unknown }).jest = {
  advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms),
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// jsdom gaps: pointer capture (used by @use-gesture), scrolling, media queries, observers and modal
// dialogs. Tests that depend on real behaviour of these stub them per test.
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.scrollIntoView ??= () => {};
window.scrollTo = () => {};
window.matchMedia ??= (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
});
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
globalThis.ResizeObserver ??= NoopObserver as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver ??= NoopObserver as unknown as typeof IntersectionObserver;
HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.show ??= function show(this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
};
