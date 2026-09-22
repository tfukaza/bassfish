export declare const MiB: number;
export interface MemorySample {
  physicalBytes: number;
  swappedBytes?: number;
  metric?: string;
}
export declare function collectRetainedMemory(): Promise<NodeJS.MemoryUsage>;
export declare function processMemory(pid: number): Promise<MemorySample>;
export declare function measureMemoryWindow(
  samples: MemorySample[],
  label: string,
  ceilingBytes?: number,
): { growthBytes: number; samples: number; finalBytes: number };
export declare function verifyMemoryWindow(
  samples: MemorySample[],
  label: string,
  ceilingBytes?: number,
): { growthBytes: number; samples: number; finalBytes: number };
