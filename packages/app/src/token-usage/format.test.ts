import { describe, expect, it } from "vitest";
import { formatTokenStat } from "./format.js";

describe("formatTokenStat", () => {
  it("formats zero and invalid numbers", () => {
    expect(formatTokenStat(0)).toBe("0");
    expect(formatTokenStat(-5)).toBe("0");
    expect(formatTokenStat(null)).toBe("0");
    expect(formatTokenStat(undefined)).toBe("0");
    expect(formatTokenStat(NaN)).toBe("0");
  });

  it("formats numbers under 1000 directly", () => {
    expect(formatTokenStat(42)).toBe("42");
    expect(formatTokenStat(999)).toBe("999");
  });

  it("formats thousands with K suffix", () => {
    expect(formatTokenStat(5000)).toBe("5K");
    expect(formatTokenStat(5400)).toBe("5.4K");
    expect(formatTokenStat(71000)).toBe("71K");
    expect(formatTokenStat(86000)).toBe("86K");
  });

  it("formats millions with M suffix", () => {
    expect(formatTokenStat(1200000)).toBe("1.2M");
    expect(formatTokenStat(27000000)).toBe("27M");
  });

  it("formats billions with B suffix", () => {
    expect(formatTokenStat(1200000000)).toBe("1.2B");
    expect(formatTokenStat(126600000000)).toBe("127B");
  });
});
