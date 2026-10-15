import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";

import { FLAGS } from "~/lib/flags";

import { recordRender } from "./perf-store";

const onRender: ProfilerOnRenderCallback = (id, phase, actualDuration) => {
  recordRender(id, phase, actualDuration);
};

/**
 * Wraps a subtree in React's <Profiler> and feeds render counts/durations to the
 * perf store — but only when the `perfOverlay` flag is on. When off it's a plain
 * passthrough (zero overhead).
 */
export function PerfProfiler({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const enabled = FLAGS.perfOverlay;
  if (!enabled) return <>{children}</>;
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}
