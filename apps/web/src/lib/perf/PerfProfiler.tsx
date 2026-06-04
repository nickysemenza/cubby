import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";
import { useFlag } from "~/lib/flags";
import { recordRender } from "./perf-store";

const onRender: ProfilerOnRenderCallback = (id, phase, actualDuration) => {
  recordRender(id, phase, actualDuration);
};

/**
 * Wraps a subtree in React's <Profiler> and feeds render counts/durations to the
 * perf store — but only when the `perfOverlay` flag is on. When off it's a plain
 * passthrough (zero overhead). Toggling the flag remounts the subtree, which is
 * fine for a debug control.
 */
export function PerfProfiler({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const enabled = useFlag("perfOverlay");
  if (!enabled) return <>{children}</>;
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}
