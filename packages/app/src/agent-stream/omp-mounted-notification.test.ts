import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { buildAgentStreamRenderModel, isOmpMountedNotification } from "./model";

function notification(message: string, level: "info" | "warning" | "error" = "info"): StreamItem {
  return {
    kind: "notification",
    sourceType: "notification",
    id: message,
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    level,
    message,
  };
}

describe("OMP mounted notifications", () => {
  it("recognizes only informational xd mounted notices", () => {
    expect(isOmpMountedNotification(notification("xd://: mounted mcp__foo, mcp__bar"))).toBe(true);
    expect(isOmpMountedNotification(notification("  xd://: mounted mcp__foo"))).toBe(true);
    expect(isOmpMountedNotification(notification("xd://: connected mcp__foo"))).toBe(false);
    expect(isOmpMountedNotification(notification("xd://: mounted mcp__foo", "warning"))).toBe(false);
  });

  it("removes mounted notices from both history and the live head", () => {
    const historyNotice = notification("xd://: mounted mcp__blender_foo, mcp__blender_bar");
    const liveNotice = {
      ...notification("xd://: mounted mcp__robloxstudio_foo"),
      id: "live-mounted",
    };
    const ordinaryNotice = {
      ...notification("OMP is ready"),
      id: "ordinary",
    };

    const model = buildAgentStreamRenderModel({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail: [historyNotice, ordinaryNotice],
      head: [liveNotice],
      platform: "web",
      isMobileBreakpoint: false,
    });

    expect(model.history.map((item) => item.id)).toEqual(["ordinary"]);
    expect(model.segments.liveHead).toHaveLength(0);
  });
});
