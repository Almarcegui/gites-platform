// Ce que jsdom n'a pas et dont Mantine a besoin.
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

import "../i18n";

const { getComputedStyle } = window;
window.getComputedStyle = (el) => getComputedStyle(el);
window.HTMLElement.prototype.scrollIntoView = () => {};
window.scrollTo = () => {};
let wide = true;
export function setWide(v: boolean) {
  wide = v;
}
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((q: string) => ({
    matches: q.includes("min-width: 64em") ? wide : false,
    media: q,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = RO as unknown as typeof ResizeObserver;
afterEach(() => {
  cleanup();
  localStorage.clear();
});
// Les zones de texte qui grandissent écoutent le chargement des polices.
if (!("fonts" in document)) {
  Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {}, ready: Promise.resolve() } });
}
