import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetailStyles } from "./tool-call-shell-detail";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
    borderWidth: { 1: 1 },
    borderRadius: { base: 6 },
    fontSize: { code: 13 },
    fontFamily: { mono: "monospace" },
    colors: {
      surface1: "#111",
      surface2: "#222",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
}));

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "toolCallDetails.output": "Output",
        "toolCallDetails.shellWallLabel": "Wall:",
        "toolCallDetails.shellTimeoutLabel": "Timeout:",
        "toolCallDetails.shellTimeoutNone": "none",
      })[key] ?? key,
  }),
}));

vi.mock("react-native-gesture-handler", () => ({
  ScrollView: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "gh-scroll" }, children),
}));

import { ShellDetailSection } from "./tool-call-shell-detail";

let root: Root | null = null;
let container: HTMLElement | null = null;

const ds: DetailStyles = {
  sectionFillStyle: {},
  codeBlockFillStyle: {},
  codeVerticalScrollStyle: {},
  scrollAreaFillStyle: {},
  scrollAreaStyle: {},
  jsonScrollCombined: {},
  jsonScrollErrorCombined: {},
  fullBleedContainerStyle: {},
  loadingContainerStyle: {},
  resolvedMaxHeight: undefined,
  shouldFill: false,
  isFullBleed: true,
};

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function render(element: React.ReactElement) {
  act(() => {
    root?.render(element);
  });
}

describe("ShellDetailSection", () => {
  it("renders the command with a $ prompt, an Output divider, and the output", () => {
    render(
      <ShellDetailSection
        command="echo hi"
        output={"hi\n"}
        ds={ds}
        status="completed"
        startedAt={new Date("2026-01-01T00:00:00Z")}
        endedAt={new Date("2026-01-01T00:00:02Z")}
      />,
    );

    const text = container?.textContent ?? "";
    expect(text).toContain("$ echo hi");
    expect(text).toContain("Output");
    expect(text).toContain("hi");
    expect(text).toContain("Wall:");
    expect(text).toContain("2.00s");
  });

  it("shows the timeout when provided", () => {
    render(
      <ShellDetailSection
        command="sleep 5"
        output={null}
        timeoutMs={300_000}
        ds={ds}
        status="running"
        startedAt={new Date()}
      />,
    );

    const text = container?.textContent ?? "";
    expect(text).toContain("Timeout: 300s");
  });

  it("shows Timeout: none when timeoutMs is 0", () => {
    render(
      <ShellDetailSection command="ls" output={null} timeoutMs={0} ds={ds} status="completed" />,
    );

    expect(container?.textContent).toContain("Timeout: none");
  });

  it("omits the timeout segment when timeoutMs is undefined", () => {
    render(<ShellDetailSection command="ls" output={null} ds={ds} status="completed" />);

    expect(container?.textContent).not.toContain("Timeout:");
  });

  it("counts the wall clock up while running", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    render(
      <ShellDetailSection
        command="sleep 10"
        output={null}
        ds={ds}
        status="running"
        startedAt={new Date("2026-01-01T00:00:00Z")}
      />,
    );

    expect(container?.textContent).toContain("0.00s");

    act(() => {
      vi.setSystemTime(new Date("2026-01-01T00:00:01.450Z"));
      vi.advanceTimersByTime(50);
    });

    expect(container?.textContent).toContain("1.50s");
  });

  it("freezes the wall clock at endedAt once completed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:10Z"));

    render(
      <ShellDetailSection
        command="sleep 1"
        output="done"
        ds={ds}
        status="completed"
        startedAt={new Date("2026-01-01T00:00:00Z")}
        endedAt={new Date("2026-01-01T00:00:01.250Z")}
      />,
    );

    expect(container?.textContent).toContain("1.25s");

    act(() => {
      vi.setSystemTime(new Date("2026-01-01T00:00:20Z"));
      vi.advanceTimersByTime(500);
    });

    expect(container?.textContent).toContain("1.25s");
  });

  it("pins the wall clock at 0.00s without timing data", () => {
    render(<ShellDetailSection command="ls" output={null} ds={ds} status="completed" />);

    expect(container?.textContent).toContain("0.00s");
  });
});
