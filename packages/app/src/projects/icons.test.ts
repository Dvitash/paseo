import { describe, expect, it } from "vitest";
import { resolveProjectIconLookup } from "./icons";
import { stableIconData } from "./stable-icon-data";

describe("project icon lookup", () => {
  const target = {
    projectId: "prj_host_local",
    iconWorkingDir: "/projects/paseo",
  };

  it("uses the host-local project ID with custom-icon-capable daemons", () => {
    expect(resolveProjectIconLookup(target, true)).toEqual({
      kind: "project",
      projectId: "prj_host_local",
    });
  });

  it("uses the project directory with legacy daemons", () => {
    expect(resolveProjectIconLookup(target, false)).toEqual({
      kind: "legacy",
      cwd: "/projects/paseo",
    });
  });

  it("waits while custom-icon capability is unknown", () => {
    expect(resolveProjectIconLookup(target, null)).toBeNull();
  });
});

describe("stable icon data", () => {
  it("keeps the previously rendered array when every entry is unchanged", () => {
    const previous = ["data:image/png;base64,one", null, "data:image/png;base64,three"];
    const next = ["data:image/png;base64,one", null, "data:image/png;base64,three"];

    expect(stableIconData(previous, next)).toBe(previous);
  });

  it("replaces the array when an entry changes", () => {
    const previous = ["data:image/png;base64,one", null];
    const next = ["data:image/png;base64,one", "data:image/png;base64,two"];

    expect(stableIconData(previous, next)).toBe(next);
  });

  it("replaces the array when an entry stops resolving", () => {
    const previous = ["data:image/png;base64,one", "data:image/png;base64,two"];
    const next = ["data:image/png;base64,one", null];

    expect(stableIconData(previous, next)).toBe(next);
  });

  it("replaces the array when its length changes", () => {
    const previous = ["data:image/png;base64,one"];
    const next = ["data:image/png;base64,one", null];

    expect(stableIconData(previous, next)).toBe(next);
  });
});
