import { randomUUID } from "node:crypto";
import type { DesktopEventsCursor } from "../shared/rpc";

export interface DesktopEvent {
  sequence: number;
  workspaceId: string;
}

export interface DesktopEventsPollResult {
  cursor: DesktopEventsCursor;
  workspaceIds: string[];
}

export class DesktopEventQueue {
  private readonly generation: string;
  private sequence: number = 0;
  private readonly queue: DesktopEvent[] = [];
  private readonly maxCapacity: number = 128;

  constructor(generation?: string) {
    this.generation = generation || randomUUID();
  }

  getGeneration(): string {
    return this.generation;
  }

  getLatestSequence(): number {
    return this.sequence;
  }

  publish(workspaceId: string): void {
    this.sequence += 1;
    this.queue.push({
      sequence: this.sequence,
      workspaceId,
    });
    if (this.queue.length > this.maxCapacity) {
      this.queue.splice(0, this.queue.length - this.maxCapacity);
    }
  }

  poll(cursor: DesktopEventsCursor | null): DesktopEventsPollResult {
    if (!cursor || cursor.generation !== this.generation) {
      return {
        cursor: {
          generation: this.generation,
          sequence: this.sequence,
        },
        workspaceIds: [],
      };
    }

    if (cursor.sequence >= this.sequence) {
      return {
        cursor: {
          generation: this.generation,
          sequence: this.sequence,
        },
        workspaceIds: [],
      };
    }

    const newEvents = this.queue.filter((event) => event.sequence > cursor.sequence);
    const workspaceIds = newEvents.map((event) => event.workspaceId);

    return {
      cursor: {
        generation: this.generation,
        sequence: this.sequence,
      },
      workspaceIds,
    };
  }
}
