import { z } from "zod";

export const HostPerformanceMemorySchema = z.object({
  usedBytes: z.number().finite().nonnegative(),
  totalBytes: z.number().finite().nonnegative(),
});
export type HostPerformanceMemory = z.infer<typeof HostPerformanceMemorySchema>;

export const HostPerformanceGpuSchema = z.object({
  id: z.string(),
  name: z.string(),
  utilizationPercent: z.number().finite().min(0).max(100).nullable(),
  memory: HostPerformanceMemorySchema.nullable(),
});
export type HostPerformanceGpu = z.infer<typeof HostPerformanceGpuSchema>;

export const HostPerformanceGpusAvailableSchema = z.object({
  status: z.literal("available"),
  devices: z.array(HostPerformanceGpuSchema),
});

export const HostPerformanceGpusUnavailableSchema = z.object({
  status: z.literal("unavailable"),
});

export const HostPerformanceGpusNoneSchema = z.object({
  status: z.literal("none"),
});

export const HostPerformanceGpusSchema = z.discriminatedUnion("status", [
  HostPerformanceGpusAvailableSchema,
  HostPerformanceGpusUnavailableSchema,
  HostPerformanceGpusNoneSchema,
]);
export type HostPerformanceGpus = z.infer<typeof HostPerformanceGpusSchema>;

export const HostPerformanceCpuSampleSchema = z.object({
  utilizationPercent: z.number().finite().min(0).max(100).nullable(),
  logicalCores: z.number().int().nonnegative(),
});
export type HostPerformanceCpuSample = z.infer<typeof HostPerformanceCpuSampleSchema>;

export const HostPerformanceSampleSchema = z.object({
  sampledAt: z.number().finite().nonnegative(),
  cpu: HostPerformanceCpuSampleSchema,
  memory: HostPerformanceMemorySchema.nullable(),
  gpus: HostPerformanceGpusSchema,
});
export type HostPerformanceSample = z.infer<typeof HostPerformanceSampleSchema>;

export const HostPerformanceHistoryPointSchema = z.object({
  sampledAt: z.number().finite().nonnegative(),
  cpuPercent: z.number().finite().min(0).max(100).nullable(),
  memoryPercent: z.number().finite().min(0).max(100).nullable(),
  gpuPercent: z.number().finite().min(0).max(100).nullable(),
});
export type HostPerformanceHistoryPoint = z.infer<typeof HostPerformanceHistoryPointSchema>;

export const HostPerformanceSnapshotSchema = z.object({
  sample: HostPerformanceSampleSchema,
  history: z.array(HostPerformanceHistoryPointSchema).max(30),
});
export type HostPerformanceSnapshot = z.infer<typeof HostPerformanceSnapshotSchema>;

export const HostPerformanceGetSnapshotRequestSchema = z.object({
  type: z.literal("host.performance.get_snapshot.request"),
  requestId: z.string(),
});
export type HostPerformanceGetSnapshotRequest = z.infer<
  typeof HostPerformanceGetSnapshotRequestSchema
>;

export const HostPerformanceGetSnapshotResponseSchema = z.object({
  type: z.literal("host.performance.get_snapshot.response"),
  payload: z.object({
    requestId: z.string(),
    snapshot: HostPerformanceSnapshotSchema,
  }),
});
export type HostPerformanceGetSnapshotResponse = z.infer<
  typeof HostPerformanceGetSnapshotResponseSchema
>;
