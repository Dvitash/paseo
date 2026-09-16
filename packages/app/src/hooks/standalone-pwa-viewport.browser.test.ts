/// <reference types="vite/client" />

import { afterEach, describe, expect, it } from "vitest";
import shellHtml from "../../public/index.html?raw";
import { installStandalonePwaViewport } from "./standalone-pwa-viewport";

// Real browser layout using the production HTML/reset, not a mocked DOMRect.
// Only the buggy dynamic viewport/VisualViewport metrics are simulated. This
// does not replace verification in an installed PWA on physical iOS hardware.
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15";
const fixtures: Array<{ frame: HTMLIFrameElement; dispose?: () => void }> = [];

async function mountShell({
  userAgent = IPHONE,
  platform = "iPhone",
  touchPoints = 5,
  standalone = true,
  shortfall = 59,
} = {}) {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;left:0;top:0;width:390px;height:844px;border:0";
  const loaded = new Promise<void>((resolve) => {
    frame.addEventListener("load", () => resolve(), { once: true });
  });
  frame.srcdoc = shellHtml
    .replace(/<link\b[^>]*>/g, "")
    .replaceAll("100dvh", `calc(100vh - ${shortfall}px)`)
    .replace(
      "<head>",
      `<head><script>
        Object.defineProperties(navigator, {
          userAgent: {value: ${JSON.stringify(userAgent)}, configurable: true},
          platform: {value: ${JSON.stringify(platform)}, configurable: true},
          maxTouchPoints: {value: ${touchPoints}, configurable: true},
          standalone: {value: ${standalone}, configurable: true}
        });
      </script>`,
    )
    .replace(
      "</head>",
      `<style>
        #fixture-app {display:flex;flex-direction:column;flex:1;min-height:0}
        #history {flex:1;min-height:0;overflow:auto}
        #history-content {height:2400px}
        #composer-rail {padding:0 16px 50px;flex-shrink:0}
        #composer {box-sizing:border-box;display:block;width:100%;height:104px}
      </style></head>`,
    )
    .replace(
      '<div id="root"></div>',
      `<div id="root"><div id="fixture-app">
        <div id="history"><div id="history-content">Conversation</div></div>
        <div id="composer-rail"><textarea id="composer">Keep this draft</textarea></div>
      </div></div>`,
    );
  fixtures.push({ frame });
  document.body.appendChild(frame);
  await loaded;
  const view = frame.contentWindow!;
  const doc = view.document;
  const viewport = Object.assign(new EventTarget(), {
    height: 844 - shortfall,
    pageTop: 0,
    scale: 1,
  });
  Object.defineProperties(view, {
    innerHeight: { value: 844 - shortfall, configurable: true },
    visualViewport: { value: viewport, configurable: true },
  });
  const root = doc.getElementById("root")!;
  const input = doc.getElementById("composer") as HTMLTextAreaElement;
  const history = doc.getElementById("history")!;
  const initialBottom = root.getBoundingClientRect().bottom;
  fixtures[fixtures.length - 1].dispose = installStandalonePwaViewport(view);
  const settle = () =>
    new Promise<void>((resolve) => {
      view.requestAnimationFrame(() => view.requestAnimationFrame(() => resolve()));
    });
  const resize = async (height: number, pageTop = 0) => {
    viewport.height = height;
    viewport.pageTop = pageTop;
    viewport.dispatchEvent(new Event("resize"));
    await settle();
  };
  const expectBottom = (bottom: number) => {
    expect(root.getBoundingClientRect().bottom).toBeCloseTo(bottom, 1);
    // 34px home-indicator inset + 16px normal composer spacing, exactly once.
    expect(input.getBoundingClientRect().bottom).toBeCloseTo(bottom - 50, 1);
  };
  return {
    frame,
    view,
    doc,
    root,
    input,
    history,
    viewport,
    settle,
    resize,
    expectBottom,
    initialBottom,
  };
}

afterEach(() => {
  for (const { frame, dispose } of fixtures.splice(0)) {
    dispose?.();
    frame.remove();
  }
});

describe("standalone PWA shell geometry", () => {
  it("fills the screen before runtime sizing, even when both JS heights are short", async () => {
    const fixture = await mountShell();
    fixture.input.focus();
    await fixture.settle();
    expect(fixture.doc.documentElement.classList.contains("ios-standalone")).toBe(true);
    expect(fixture.doc.body.getBoundingClientRect().height).toBe(844);
    expect(fixture.initialBottom).toBe(844);
    fixture.expectBottom(844);
    expect(fixture.doc.activeElement).toBe(fixture.input);
  });

  it("does not overextend a healthy standalone viewport", async () => {
    const fixture = await mountShell({ shortfall: 0 });
    fixture.expectBottom(844);
    expect(fixture.doc.documentElement.scrollHeight).toBe(844);
  });

  it("survives repeated keyboard cycles without losing focus, selection, or scroll", async () => {
    const fixture = await mountShell();
    fixture.input.focus();
    fixture.input.setSelectionRange(5, 9);
    fixture.history.scrollTop = 320;
    for (let cycle = 0; cycle < 3; cycle++) {
      await fixture.resize(500, 40);
      fixture.expectBottom(540);
      expect(fixture.root.getBoundingClientRect().top).toBe(40);
      await fixture.resize(785);
      fixture.expectBottom(844);
      expect(fixture.doc.activeElement).toBe(fixture.input);
      expect(fixture.input.selectionStart).toBe(5);
      expect(fixture.input.selectionEnd).toBe(9);
      expect(fixture.input.value).toBe("Keep this draft");
      expect(fixture.history.scrollTop).toBe(320);
    }
  });

  it("restores the bottom after blur while keyboard metrics are stale", async () => {
    const fixture = await mountShell();
    fixture.input.focus();
    await fixture.resize(500, 80);
    fixture.input.blur();
    await fixture.settle();
    fixture.expectBottom(844);
  });

  it("recovers on pageshow with no resize event", async () => {
    const fixture = await mountShell();
    fixture.input.focus();
    await fixture.resize(500, 80);
    fixture.viewport.height = 785;
    fixture.viewport.pageTop = 0;
    fixture.view.dispatchEvent(new Event("pageshow"));
    await fixture.settle();
    fixture.expectBottom(844);
  });

  it("recovers on visibilitychange with no resize event", async () => {
    const fixture = await mountShell();
    fixture.input.focus();
    await fixture.resize(500);
    fixture.viewport.height = 785;
    fixture.doc.dispatchEvent(new Event("visibilitychange"));
    await fixture.settle();
    fixture.expectBottom(844);
  });

  it("uses the new CSS size after rotation and split-window resizing", async () => {
    const fixture = await mountShell();
    fixture.input.focus();
    await fixture.resize(500);
    fixture.frame.style.width = "844px";
    fixture.frame.style.height = "390px";
    await fixture.resize(390);
    fixture.expectBottom(390);
    await fixture.resize(210);
    fixture.expectBottom(210);
    fixture.frame.style.width = "500px";
    fixture.frame.style.height = "600px";
    await fixture.resize(541);
    fixture.expectBottom(600);
  });

  it("does not interpret pinch zoom as a software keyboard", async () => {
    const fixture = await mountShell();
    fixture.input.focus();
    fixture.viewport.scale = 2;
    await fixture.resize(400, 100);
    fixture.expectBottom(844);
    fixture.viewport.scale = 1;
    await fixture.resize(785);
    fixture.expectBottom(844);
  });

  it("follows visual viewport scrolling while the keyboard is open", async () => {
    const fixture = await mountShell();
    fixture.input.focus();
    await fixture.resize(500);
    fixture.viewport.pageTop = 80;
    fixture.viewport.dispatchEvent(new Event("scroll"));
    await fixture.settle();
    fixture.expectBottom(580);
  });

  it("recognizes a focused contenteditable editor", async () => {
    const fixture = await mountShell();
    const editor = fixture.doc.createElement("div");
    editor.contentEditable = "true";
    editor.textContent = "Editable";
    fixture.root.appendChild(editor);
    editor.focus();
    await fixture.resize(500);
    expect(fixture.root.getBoundingClientRect().height).toBe(500);
  });

  it("does not mistake a focused readonly textarea for a keyboard", async () => {
    const fixture = await mountShell();
    fixture.input.readOnly = true;
    fixture.input.focus();
    await fixture.resize(500);
    fixture.expectBottom(844);
  });

  it("also gates desktop-user-agent iPad standalone installations", async () => {
    const fixture = await mountShell({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15",
      platform: "MacIntel",
    });
    fixture.expectBottom(844);
  });

  it("leaves ordinary iPhone Safari on its dynamic viewport", async () => {
    const fixture = await mountShell({ standalone: false });
    expect(fixture.doc.documentElement.classList.contains("ios-standalone")).toBe(false);
    fixture.input.focus();
    await fixture.resize(500);
    fixture.expectBottom(785);
  });

  it("leaves Android standalone layout unchanged", async () => {
    const fixture = await mountShell({
      userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0 Mobile Safari/537.36",
      platform: "Linux armv81",
    });
    expect(fixture.doc.documentElement.classList.contains("ios-standalone")).toBe(false);
    fixture.input.focus();
    await fixture.resize(500);
    fixture.expectBottom(785);
  });

  it("leaves desktop standalone layout unchanged", async () => {
    const fixture = await mountShell({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15",
      platform: "MacIntel",
      touchPoints: 0,
    });
    expect(fixture.doc.documentElement.classList.contains("ios-standalone")).toBe(false);
    fixture.expectBottom(785);
  });
});
