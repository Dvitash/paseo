import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AdvisorComments } from "./advisor-comments";

interface MountedCard {
  root: Root;
  container: HTMLDivElement;
}

const mountedCards: MountedCard[] = [];

function mountAdvisorComments(props: {
  text?: string;
  label?: string;
  disableOuterSpacing?: boolean;
}): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <AdvisorComments
        text={props.text}
        label={props.label}
        disableOuterSpacing={props.disableOuterSpacing}
      />,
    );
  });

  mountedCards.push({ root, container });

  const card = container.firstElementChild;
  if (!(card instanceof HTMLElement)) {
    throw new Error("AdvisorComments did not render an element");
  }
  return card;
}

afterEach(() => {
  for (const mounted of mountedCards.splice(0)) {
    act(() => mounted.root.unmount());
    mounted.container.remove();
  }
});

describe("AdvisorComments renderer", () => {
  it("renders muted Advisor heading and inline comments with severity labels", () => {
    const text = [
      "[nit] [review-bot] Nit comment text",
      "[concern] Concern comment text",
      "[blocker] Blocker comment text",
    ].join("\n\n");

    const element = mountAdvisorComments({ text });

    // One Advisor heading
    expect(element.textContent).toContain("Advisor");

    // Severity labels visible
    expect(element.textContent).toContain("Nit");
    expect(element.textContent).toContain("Concern");
    expect(element.textContent).toContain("Blocker");

    // Advisor tag visible
    expect(element.textContent).toContain("review-bot");

    // Complete comment bodies inline
    expect(element.textContent).toContain("Nit comment text");
    expect(element.textContent).toContain("Concern comment text");
    expect(element.textContent).toContain("Blocker comment text");

    // Non-collapsible: no buttons, no chevrons
    const buttons = element.querySelectorAll("button, [role='button']");
    expect(buttons.length).toBe(0);

    const accents = ["nit", "concern", "blocker"].map((severity) => {
      const note = element.querySelector(`[data-testid="advisor-comment-item-${severity}"]`);
      if (!(note instanceof HTMLElement)) {
        throw new Error(`Missing ${severity} comment`);
      }
      expect(note.checkVisibility()).toBe(true);
      expect(note.getBoundingClientRect().height).toBeGreaterThan(0);
      return getComputedStyle(note).borderLeftColor;
    });
    expect(new Set(accents).size).toBe(3);
  });

  it("preserves continuation paragraphs across multiple lines within a note", () => {
    const text = `[concern] Paragraph one of concern.

Paragraph two with deeper details.

[nit] A separate nit comment.`;

    const element = mountAdvisorComments({ text });

    expect(element.textContent).toContain("Paragraph one of concern.");
    expect(element.textContent).toContain("Paragraph two with deeper details.");
    expect(element.textContent).toContain("A separate nit comment.");
  });

  it("renders Markdown code, emphasis, lists, and links inside advisor notes", () => {
    const element = mountAdvisorComments({
      text: [
        "[blocker] Check `packages/app/src/composer/model-turn-metrics.tsx`.",
        "",
        "```ts",
        'const status = "running";',
        'expect(status).toBe("running");',
        "```",
        "",
        "**Retain metrics** between turns.",
        "",
        "- Keep the last values",
        "- Handle null metrics",
        "",
        "[Read the docs](https://paseo.sh)",
      ].join("\n"),
    });
    element.style.width = "320px";

    expect(element.textContent).not.toContain("```");
    expect(element.textContent).not.toContain("`packages/");
    expect(element.textContent).not.toContain("**Retain metrics**");
    expect(element.textContent).toContain('const status = "running";');
    expect(element.textContent).toContain('expect(status).toBe("running");');
    expect(element.textContent).toContain("Retain metrics");
    expect(element.textContent).toContain("Keep the last values");
    expect(element.textContent).toContain("Handle null metrics");
    expect(element.querySelector('[role="link"]')?.textContent).toBe("Read the docs");
    expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
  });

  it("renders untyped neutral notes with fallback Note label", () => {
    const text = "General architectural advice without severity tag";
    const element = mountAdvisorComments({ text });

    expect(element.textContent).toContain("Advisor");
    expect(element.textContent).toContain("Note");
    expect(element.textContent).toContain("General architectural advice without severity tag");
  });

  it("falls back to label if text is empty", () => {
    const element = mountAdvisorComments({ label: "Advisor · 1 note" });

    expect(element.textContent).toContain("Advisor");
    expect(element.textContent).toContain("Note");
    expect(element.textContent).toContain("Advisor · 1 note");
  });

  it("keeps long comments fully visible in a compact column without expansion", () => {
    const text = `[blocker] ${"Check the authorization boundary. ".repeat(100)}`;
    const element = mountAdvisorComments({ text, disableOuterSpacing: true });
    element.style.width = "320px";
    const note = element.querySelector('[data-testid="advisor-comment-item-blocker"]');
    if (!(note instanceof HTMLElement)) {
      throw new Error("Missing blocker comment");
    }
    expect(note.checkVisibility()).toBe(true);
    expect(note.textContent).toContain(text.slice("[blocker] ".length).trim());
    expect(note.getBoundingClientRect().height).toBeGreaterThan(400);
    expect(note.scrollHeight).toBeLessThanOrEqual(note.clientHeight + 1);
    expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
    expect(element.querySelectorAll("button, [role='button']")).toHaveLength(0);
  });
});
