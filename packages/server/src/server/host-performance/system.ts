import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  HostPerformanceGpu,
  HostPerformanceGpus,
  HostPerformanceMemory,
} from "@getpaseo/protocol/host-performance";
import { execCommand } from "../../utils/spawn.js";

const MIB = 1024 * 1024;
const GPU_COMMAND_TIMEOUT_MS = 1000;
const GPU_RETRY_MS = 60_000;

export interface HostCpuCounters {
  idle: number;
  total: number;
  logicalCores: number;
}

export interface HostSystemReading {
  cpu: HostCpuCounters;
  memory: HostPerformanceMemory | null;
  gpus: HostPerformanceGpus;
}

function unavailableFile(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return (
    error.code === "ENOENT" ||
    error.code === "ENOTDIR" ||
    error.code === "EACCES" ||
    error.code === "EPERM" ||
    error.code === "ENODEV" ||
    error.code === "EIO" ||
    error.code === "EINVAL" ||
    error.code === "ENOTSUP" ||
    error.code === "EOPNOTSUPP" ||
    error.code === "EBUSY" ||
    error.code === "EAGAIN" ||
    error.code === "ETIMEDOUT"
  );
}

interface OptionalTextOptions {
  file: string;
  readText?: (file: string) => Promise<string>;
}

async function optionalText({ file, readText }: OptionalTextOptions): Promise<string | null> {
  try {
    return await (readText ? readText(file) : readFile(file, "utf8"));
  } catch (error) {
    if (unavailableFile(error)) return null;
    throw error;
  }
}

function nonnegativeNumber(text: string | null): number | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function percent(text: string | null): number | null {
  const value = nonnegativeNumber(text);
  if (value === null || value > 100) return null;
  return value;
}

function memoryUsage(
  usedBytes: number | null,
  totalBytes: number | null,
): HostPerformanceMemory | null {
  if (usedBytes === null || totalBytes === null) return null;
  const finite = Number.isFinite(usedBytes) && Number.isFinite(totalBytes);
  const valid = finite && usedBytes >= 0 && totalBytes > 0 && usedBytes <= totalBytes;
  if (!valid) return null;
  return { usedBytes, totalBytes };
}

export function parseLinuxMemory(text: string): HostPerformanceMemory | null {
  const totalMatch = /^MemTotal:\s+(\d+)\s+kB$/m.exec(text);
  const availableMatch = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
  if (!totalMatch || !availableMatch) return null;
  const totalBytes = Number(totalMatch[1]) * 1024;
  const availableBytes = Number(availableMatch[1]) * 1024;
  const valid =
    Number.isFinite(totalBytes) && Number.isFinite(availableBytes) && availableBytes <= totalBytes;
  if (!valid) return null;
  return memoryUsage(totalBytes - availableBytes, totalBytes);
}

async function readMemory(): Promise<HostPerformanceMemory | null> {
  if (process.platform === "linux") {
    const text = await optionalText({ file: "/proc/meminfo" });
    // Linux's free-memory count excludes reclaimable caches; MemAvailable measures usable headroom.
    return text === null ? null : parseLinuxMemory(text);
  }
  const totalBytes = os.totalmem();
  const usedBytes = Math.max(0, totalBytes - os.freemem());
  return memoryUsage(usedBytes, totalBytes);
}

function readCpu(): HostCpuCounters {
  const cores = os.cpus();
  let idle = 0;
  let total = 0;
  for (const core of cores) {
    idle += core.times.idle;
    total += core.times.user + core.times.nice + core.times.sys + core.times.idle + core.times.irq;
  }
  return { idle, total, logicalCores: cores.length };
}

export function parseNvidiaGpus(text: string): HostPerformanceGpus {
  if (!text.trim()) return { status: "none" };
  const devices: HostPerformanceGpu[] = [];
  for (const line of text.trim().split(/\r?\n/)) {
    const fields = line.split(",").map((field) => field.trim());
    if (fields.length < 5) continue;
    const id = fields[0];
    const name = fields.slice(1, -3).join(", ");
    if (!id || !name) continue;
    const utilizationPercent = percent(fields[fields.length - 3] ?? null);
    const usedMiB = nonnegativeNumber(fields[fields.length - 2] ?? null);
    const totalMiB = nonnegativeNumber(fields[fields.length - 1] ?? null);
    const usedBytes = usedMiB === null ? null : usedMiB * MIB;
    const totalBytes = totalMiB === null ? null : totalMiB * MIB;
    const memory = memoryUsage(usedBytes, totalBytes);
    // N/A on unified-memory GPUs (including GB10) is not a separate zero-byte VRAM pool.
    devices.push({ id, name, utilizationPercent, memory });
  }
  if (devices.length === 0) return { status: "unavailable" };
  return { status: "available", devices };
}

async function readNvidiaGpus(): Promise<HostPerformanceGpus> {
  try {
    const result = await execCommand(
      "nvidia-smi",
      [
        "--query-gpu=uuid,name,utilization.gpu,memory.used,memory.total",
        "--format=csv,noheader,nounits",
      ],
      { timeout: GPU_COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024, shell: false },
    );
    return parseNvidiaGpus(result.stdout);
  } catch (error) {
    // Missing CLI/driver, unsupported query and timed-out GPU access are optional telemetry failures.
    const isCommandFailure =
      error instanceof Error && ("code" in error || "signal" in error || "killed" in error);
    if (isCommandFailure) return { status: "unavailable" };
    throw error;
  }
}

interface LinuxGpuOptions {
  drmRoot: string;
  excludeNvidia: boolean;
  readText?: (file: string) => Promise<string>;
}

async function readDrmDevice(
  card: string,
  options: LinuxGpuOptions,
): Promise<HostPerformanceGpu | null> {
  const devicePath = path.join(options.drmRoot, card, "device");
  const readText = options.readText;
  const vendorText = await optionalText({ file: path.join(devicePath, "vendor"), readText });
  const vendor = vendorText?.trim();
  if (options.excludeNvidia && vendor === "0x10de") return null;
  let name = "GPU";
  if (vendor === "0x1002") name = "AMD GPU";
  if (vendor === "0x8086") name = "Intel GPU";
  if (vendor === "0x10de") name = "NVIDIA GPU";
  const [busy, used, total] = await Promise.all([
    optionalText({ file: path.join(devicePath, "gpu_busy_percent"), readText }),
    optionalText({ file: path.join(devicePath, "mem_info_vram_used"), readText }),
    optionalText({ file: path.join(devicePath, "mem_info_vram_total"), readText }),
  ]);
  const utilizationPercent = percent(busy);
  const memory = memoryUsage(nonnegativeNumber(used), nonnegativeNumber(total));
  return { id: card, name, utilizationPercent, memory };
}

export async function readLinuxGpus(options: LinuxGpuOptions): Promise<HostPerformanceGpus> {
  let entries: string[];
  try {
    entries = await readdir(options.drmRoot);
  } catch (error) {
    if (unavailableFile(error)) return { status: "unavailable" };
    throw error;
  }
  const cards = entries.filter((name) => /^card\d+$/.test(name)).sort();
  const readings = await Promise.all(cards.map((card) => readDrmDevice(card, options)));
  const devices = readings.filter((device) => device !== null);
  if (devices.length === 0) return { status: "none" };
  return { status: "available", devices };
}

export function mergeGpuReadings(
  nvidia: HostPerformanceGpus,
  linux: HostPerformanceGpus,
): HostPerformanceGpus {
  if (nvidia.status === "available") {
    if (linux.status !== "available") return nvidia;
    return { status: "available", devices: [...nvidia.devices, ...linux.devices] };
  }
  if (linux.status === "available") return linux;
  // Compute-only NVIDIA drivers and GPU containers need not expose DRM cards.
  if (nvidia.status === "none" && linux.status === "none") return { status: "none" };
  return { status: "unavailable" };
}

function createGpuReader(): () => Promise<HostPerformanceGpus> {
  let retryNvidiaAt = 0;
  return async () => {
    const supportsNvidia = process.platform === "linux" || process.platform === "win32";
    if (!supportsNvidia) return { status: "unavailable" };
    let nvidia: HostPerformanceGpus = { status: "unavailable" };
    const now = Date.now();
    if (now >= retryNvidiaAt) {
      nvidia = await readNvidiaGpus();
      if (nvidia.status === "unavailable") retryNvidiaAt = now + GPU_RETRY_MS;
    }
    if (process.platform !== "linux") return nvidia;
    const linux = await readLinuxGpus({
      drmRoot: "/sys/class/drm",
      excludeNvidia: nvidia.status === "available",
    });
    return mergeGpuReadings(nvidia, linux);
  };
}

export function createHostSystemReader(): () => Promise<HostSystemReading> {
  const readGpus = createGpuReader();
  return async () => {
    const cpu = readCpu();
    const [memory, gpus] = await Promise.all([readMemory(), readGpus()]);
    return { cpu, memory, gpus };
  };
}
