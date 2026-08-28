// On-demand CPU profiling for dev, via the JS Self-Profiling API. This is the
// one tool that catches "every measurement is fast but the page is slow" bugs —
// where the cost is in commit-phase work, native code, or third-party
// instrumentation that React's <Profiler> (render-only) and ad-hoc
// console.time() can't see. (It's how the recipe-view freeze was traced to
// Sentry's O(n²) `addSpanChildren`.)
//
// Usage (dev console): `await __jsProfile(5000)` — profiles the next N ms and
// prints/returns the hottest main-thread frames. Requires the
// `Document-Policy: js-profiling` response header, which the dev server sets
// (see vite.config.ts); restart `vite dev` if it errors as disabled.
//
// Dev-only: `installJsProfiler()` is gated behind a non-prod check in router.tsx
// and tree-shaken from production.

// The JS Self-Profiling API isn't in lib.dom yet — declare the slice we use.
interface ProfilerInit {
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
declare global {
  var Profiler: {
    new (init: ProfilerInit): { stop(): Promise<ProfilerTrace> };
  };
  interface Window {
    __jsProfile?: typeof captureProfile;
  }
}

type HotFrame = { frame: string; samples: number; pct: number };

/**
 * Profile the main thread for `ms`, then aggregate samples into the hottest leaf
 * frames (`name @file:line`). Prints a table and returns the ranked list.
 */
async function captureProfile(
  ms = 5000,
  sampleInterval = 10,
  topN = 25,
): Promise<HotFrame[]> {
  let profiler: { stop(): Promise<ProfilerTrace> };
  try {
    profiler = new Profiler({ sampleInterval, maxBufferSize: 1_000_000 });
  } catch (e) {
    console.warn(
      "[__jsProfile] JS profiling is disabled — the dev server must send " +
        "`Document-Policy: js-profiling`. Restart `vite dev` and retry.",
      e,
    );
    return [];
  }

  await new Promise((r) => setTimeout(r, ms));
  const trace = await profiler.stop();

  const counts = new Map<string, number>();
  for (const sample of trace.samples) {
    if (sample.stackId == null) continue;
    const stack = trace.stacks[sample.stackId];
    if (!stack) continue;
    const frame = trace.frames[stack.frameId];
    if (!frame) continue;
    const file =
      frame.resourceId != null
        ? (trace.resources[frame.resourceId] ?? "")
            .split("/")
            .pop()
            ?.split("?")[0]
        : "";
    const key = `${frame.name || "(anonymous)"} @${file || "?"}:${frame.line ?? "?"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const total = trace.samples.length || 1;
  const top: HotFrame[] = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([frame, samples]) => ({
      frame,
      samples,
      pct: Math.round((samples / total) * 1000) / 10,
    }));

  console.info(
    `[__jsProfile] ${trace.samples.length} samples over ~${ms}ms ` +
      `(≈${trace.samples.length * sampleInterval}ms of activity). Top frames:`,
  );
  console.table(top);
  return top;
}

/** Expose `window.__jsProfile` in dev. No-op on the server. */
export function installJsProfiler(): void {
  if (typeof window === "undefined") return;
  window.__jsProfile = captureProfile;
}
