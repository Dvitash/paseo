export interface DesktopState {
  display: number;
  port: number;
  slug: string;
  browserEnabled: boolean;
  browserUrl: string | null;
  worktreePath: string;
}

export type DesktopStateReadResult =
  | { kind: "found"; state: DesktopState }
  | { kind: "not_found" }
  | { kind: "parse_error"; message: string }
  | { kind: "invalid_state"; message: string };

export interface DerivedPorts {
  https: number;
  proxy: number;
  backend: number;
}

export interface ProbeOptions {
  timeoutMs?: number;
  host?: string;
  hostHeader?: string;
}

export interface Clock {
  now(): number;
}
