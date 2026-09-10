import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeGpuReadings, parseLinuxMemory, parseNvidiaGpus, readLinuxGpus } from "./system.js";

describe("host memory", () => {
  it("counts reclaimable Linux cache as available instead of reporting false pressure", () => {
    expect(
      parseLinuxMemory("MemTotal: 1000 kB\nMemFree: 10 kB\nMemAvailable: 600 kB\nCached: 500 kB\n"),
    ).toEqual({
      usedBytes: 400 * 1024,
      totalBytes: 1000 * 1024,
    });
  });

  it("does not turn missing or corrupt memory counters into zero usage", () => {
    expect(parseLinuxMemory("MemTotal: 1000 kB\nMemFree: 10 kB\n")).toBeNull();
    expect(parseLinuxMemory("MemTotal: 0 kB\nMemAvailable: 0 kB\n")).toBeNull();
    expect(parseLinuxMemory("MemTotal: 100 kB\nMemAvailable: 200 kB\n")).toBeNull();
  });
});

describe("NVIDIA telemetry", () => {
  it("reads separate GPU utilization and dedicated memory for each device", () => {
    expect(
      parseNvidiaGpus(
        "GPU-a, NVIDIA RTX 4090, 75, 1024, 24564\nGPU-b, NVIDIA RTX 3090, 0, 0, 24576\n",
      ),
    ).toEqual({
      status: "available",
      devices: [
        {
          id: "GPU-a",
          name: "NVIDIA RTX 4090",
          utilizationPercent: 75,
          memory: { usedBytes: 1024 * 1024 * 1024, totalBytes: 24564 * 1024 * 1024 },
        },
        {
          id: "GPU-b",
          name: "NVIDIA RTX 3090",
          utilizationPercent: 0,
          memory: { usedBytes: 0, totalBytes: 24576 * 1024 * 1024 },
        },
      ],
    });
  });

  it("preserves GB10 utilization without inventing a VRAM pool for unified memory", () => {
    expect(parseNvidiaGpus("GPU-spark, NVIDIA GB10, 7, [N/A], [N/A]\n")).toEqual({
      status: "available",
      devices: [{ id: "GPU-spark", name: "NVIDIA GB10", utilizationPercent: 7, memory: null }],
    });
  });

  it("distinguishes unsupported counters, idle hardware, no devices, and malformed output", () => {
    expect(parseNvidiaGpus("GPU-a, NVIDIA GPU, [Not Supported], 0, 0\n")).toEqual({
      status: "available",
      devices: [{ id: "GPU-a", name: "NVIDIA GPU", utilizationPercent: null, memory: null }],
    });
    expect(parseNvidiaGpus("GPU-a, NVIDIA GPU, 101, 99, 10\n")).toEqual({
      status: "available",
      devices: [{ id: "GPU-a", name: "NVIDIA GPU", utilizationPercent: null, memory: null }],
    });
    expect(parseNvidiaGpus("")).toEqual({ status: "none" });
    expect(parseNvidiaGpus("unexpected driver output")).toEqual({ status: "unavailable" });
  });
});

describe("Linux DRM telemetry", () => {
  it("reads AMD counters and leaves unsupported Intel counters unavailable without external programs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-gpu-test-"));
    try {
      const amd = path.join(root, "card0", "device");
      const intel = path.join(root, "card1", "device");
      await Promise.all([
        mkdir(amd, { recursive: true }),
        mkdir(intel, { recursive: true }),
        mkdir(path.join(root, "card0-HDMI-A-1")),
      ]);
      await Promise.all([
        writeFile(path.join(amd, "vendor"), "0x1002\n"),
        writeFile(path.join(amd, "gpu_busy_percent"), "42\n"),
        writeFile(path.join(amd, "mem_info_vram_used"), "1024\n"),
        writeFile(path.join(amd, "mem_info_vram_total"), "4096\n"),
        writeFile(path.join(intel, "vendor"), "0x8086\n"),
      ]);
      expect(await readLinuxGpus({ drmRoot: root, excludeNvidia: false })).toEqual({
        status: "available",
        devices: [
          {
            id: "card0",
            name: "AMD GPU",
            utilizationPercent: 42,
            memory: { usedBytes: 1024, totalBytes: 4096 },
          },
          { id: "card1", name: "Intel GPU", utilizationPercent: null, memory: null },
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hides only confirmed absent hardware, not inaccessible telemetry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-gpu-empty-"));
    try {
      expect(await readLinuxGpus({ drmRoot: root, excludeNvidia: false })).toEqual({
        status: "none",
      });
      expect(
        await readLinuxGpus({ drmRoot: path.join(root, "missing"), excludeNvidia: false }),
      ).toEqual({ status: "unavailable" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("optional GPU failures", () => {
  it("does not mistake a failed compute-only NVIDIA probe for absent hardware", () => {
    expect(mergeGpuReadings({ status: "unavailable" }, { status: "none" })).toEqual({
      status: "unavailable",
    });
    expect(mergeGpuReadings({ status: "none" }, { status: "none" })).toEqual({
      status: "none",
    });
    const available = parseNvidiaGpus("GPU-a, NVIDIA GB10, 10, [N/A], [N/A]");
    expect(mergeGpuReadings(available, { status: "none" })).toEqual(available);
  });

  it.each(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EBUSY", "EAGAIN"])(
    "preserves the other GPU counters when a driver sensor reports %s",
    async (code) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "paseo-gpu-sensor-"));
      try {
        const device = path.join(root, "card0", "device");
        await mkdir(device, { recursive: true });
        await Promise.all([
          writeFile(path.join(device, "vendor"), "0x1002"),
          writeFile(path.join(device, "mem_info_vram_used"), "1024"),
          writeFile(path.join(device, "mem_info_vram_total"), "4096"),
        ]);
        const gpus = await readLinuxGpus({
          drmRoot: root,
          excludeNvidia: false,
          readText: async (file) => {
            if (file.endsWith("gpu_busy_percent")) {
              throw Object.assign(new Error("Sensor unsupported"), { code });
            }
            return readFile(file, "utf8");
          },
        });
        expect(gpus).toEqual({
          status: "available",
          devices: [
            {
              id: "card0",
              name: "AMD GPU",
              utilizationPercent: null,
              memory: { usedBytes: 1024, totalBytes: 4096 },
            },
          ],
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
