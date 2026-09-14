import { expect, test } from "vitest";
import { isAppActivelyVisible, isAppVisible } from "./app-visibility";

test("a visible desktop app remains visible when another window has focus", () => {
  const input = {
    appState: "active",
    native: false,
    documentVisible: true,
    windowFocused: false,
  };

  expect(isAppVisible(input)).toBe(true);
  expect(isAppActivelyVisible(input)).toBe(false);
});

test("a hidden desktop page is neither visible nor actively visible", () => {
  const input = {
    appState: "active",
    native: false,
    documentVisible: false,
    windowFocused: true,
  };

  expect(isAppVisible(input)).toBe(false);
  expect(isAppActivelyVisible(input)).toBe(false);
});

test("a visible PWA is not hidden by a stale native-style AppState value", () => {
  expect(isAppVisible({ appState: "background", native: false, documentVisible: true })).toBe(true);
});

test("native visibility still follows AppState rather than document state", () => {
  expect(isAppVisible({ appState: "background", native: true, documentVisible: true })).toBe(false);
  expect(isAppVisible({ appState: "active", native: true, documentVisible: false })).toBe(true);
});
