import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createInstance } from "i18next";
import { ModelTurnMetricsPill } from "./model-turn-metrics";

const i18n = createInstance();
await i18n.init({
  lng: "en",
  resources: {
    en: {
      translation: {
        composer: {
          modelTurnMetrics: {
            current: "Current model turn",
            previous: "Previous model turn",
            description: "Subagents are excluded. Unavailable metrics show —.",
          },
        },
      },
    },
  },
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("React", React);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(metrics: React.ComponentProps<typeof ModelTurnMetricsPill>["metrics"]) {
  act(() => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <ModelTurnMetricsPill metrics={metrics} />
      </I18nextProvider>,
    );
  });
  const pill = container.querySelector('[data-testid="composer-model-turn-metrics-pill"]');
  if (!(pill instanceof HTMLElement)) throw new Error("Metrics pill did not render");
  return pill;
}

describe("model turn metrics pill", () => {
  it("shows pending metrics, then current TTFT, and retains the completed turn", () => {
    let pill = render({ status: "running", ttftMs: null, tokensPerSecond: null });
    expect(pill.textContent).toBe("TTFT — · TPS —");
    expect(pill.getAttribute("aria-label")).toContain("Current model turn");

    pill = render({ status: "running", ttftMs: 1234, tokensPerSecond: null });
    expect(pill.textContent).toBe("TTFT 1.23s · TPS —");

    pill = render({ status: "completed", ttftMs: 1234, tokensPerSecond: 52.345 });
    expect(pill.textContent).toBe("TTFT 1.23s · TPS 52.3");
    expect(pill.getAttribute("aria-label")).toContain("Previous model turn");
    expect(pill.getAttribute("aria-label")).toContain("Subagents are excluded");

    pill = render({ status: "running", ttftMs: null, tokensPerSecond: null });
    expect(pill.textContent).toBe("TTFT — · TPS —");
    expect(pill.getAttribute("aria-label")).toContain("Current model turn");
  });

  it("renders real zero values without treating them as unavailable", () => {
    const pill = render({ status: "completed", ttftMs: 0, tokensPerSecond: 0 });
    expect(pill.textContent).toBe("TTFT 0.00s · TPS 0.0");
  });
});
