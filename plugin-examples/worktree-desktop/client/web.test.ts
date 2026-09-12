import { describe, expect, it } from "vitest";
import { validateDesktopUrl } from "../shared/rpc";
import {
  DESKTOP_IFRAME_ALLOW,
  DESKTOP_IFRAME_REFERRER_POLICY,
  DESKTOP_IFRAME_SANDBOX,
} from "./policy";

describe("desktop web security policy", () => {
  it("validates safe desktop streaming URLs using shared validator", () => {
    expect(validateDesktopUrl("http://127.0.0.1:6080/vnc.html").ok).toBe(true);
    expect(validateDesktopUrl("http://localhost:20110").ok).toBe(true);
    expect(validateDesktopUrl("https://spark.internal/desktop").ok).toBe(true);
    expect(validateDesktopUrl("https://tailscale-node:8080/stream?token=abc").ok).toBe(true);

    // Rejects embedded credentials
    expect(validateDesktopUrl("http://user:pass@127.0.0.1:6080").ok).toBe(false);
    expect(validateDesktopUrl("https://admin:secret@spark.internal/").ok).toBe(false);

    // Rejects non-http(s) protocols
    expect(validateDesktopUrl("javascript:alert(1)").ok).toBe(false);
    expect(validateDesktopUrl("data:text/html,<h1>bad</h1>").ok).toBe(false);
    expect(validateDesktopUrl("file:///etc/passwd").ok).toBe(false);
    expect(validateDesktopUrl("ws://127.0.0.1:6080").ok).toBe(false);

    // Rejects malformed strings
    expect(validateDesktopUrl("").ok).toBe(false);
    expect(validateDesktopUrl("   ").ok).toBe(false);
    expect(validateDesktopUrl("not-a-valid-url").ok).toBe(false);
  });

  it("configures iframe allow policy with audio, pointer lock, and clipboard without microphone", () => {
    const tokens = DESKTOP_IFRAME_ALLOW.split(";").map((t) => t.trim());

    expect(tokens).toContain("autoplay");
    expect(tokens).toContain("fullscreen");
    expect(tokens).toContain("clipboard-read");
    expect(tokens).toContain("clipboard-write");

    // Microphone and camera must not be permitted by default
    expect(tokens.some((t) => t.startsWith("microphone"))).toBe(false);
    expect(tokens.some((t) => t.startsWith("camera"))).toBe(false);
  });

  it("configures iframe sandbox policy without top-navigation", () => {
    const tokens = DESKTOP_IFRAME_SANDBOX.split(/\s+/);

    expect(tokens).toContain("allow-scripts");
    expect(tokens).toContain("allow-same-origin");
    expect(tokens).toContain("allow-forms");
    expect(tokens).toContain("allow-downloads");
    expect(tokens).toContain("allow-pointer-lock");
    expect(tokens).toContain("allow-popups");

    // Top-navigation must be strictly disallowed
    expect(tokens).not.toContain("allow-top-navigation");
    expect(tokens).not.toContain("allow-top-navigation-by-user-activation");
    expect(tokens).not.toContain("allow-top-navigation-to-custom-protocols");
  });

  it("enforces no-referrer policy", () => {
    expect(DESKTOP_IFRAME_REFERRER_POLICY).toBe("no-referrer");
  });
});
