// The JS Self-Profiling API isn't in lib.dom yet — declare the slice we use.
export interface ProfilerInit {
  sampleInterval: number;
  maxBufferSize: number;
}
interface ProfilerFrame {
  name?: string;
  resourceId?: number;
  line?: number;
  column?: number;
}
interface ProfilerStack {
  frameId: number;
  parentId?: number;
}
interface ProfilerSample {
  timestamp: number;
  stackId?: number;
}
interface ProfilerTrace {
  frames: ProfilerFrame[];
  stacks: ProfilerStack[];
  samples: ProfilerSample[];
  resources: string[];
}
export interface ProfilerSession {
  stop(): Promise<ProfilerTrace>;
}
export type HotFrame = { frame: string; samples: number; pct: number };
export type CaptureProfile = (
  ms?: number,
  sampleInterval?: number,
  topN?: number,
) => Promise<HotFrame[]>;
