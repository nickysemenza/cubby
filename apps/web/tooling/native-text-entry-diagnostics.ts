import { closeSync, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";

const count = z.number().int().safe().nonnegative();
const eventSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("commit-start"), expectedLength: count }),
  z.object({
    phase: z.literal("commit-poll"),
    elapsedMs: count,
    observedLength: z.number().int().safe().min(-1),
    expectedPrefixLength: z.number().int().safe().min(-1),
  }),
  z.object({
    phase: z.literal("commit-result"),
    outcome: z.enum(["settled", "unobservable", "notObserved"]),
    elapsedMs: count,
  }),
]);

// The reporter callback is not awaited by the SDK. Read synchronously before
// replay daemon cleanup deletes its log; retain only a bounded numeric projection.
export function readNativeTextEntryDiagnostics(file: string) {
  if (basename(file) !== "runner.log") return;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "r");
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return;
    const length = Math.min(stat.size, 256_000);
    const buffer = Buffer.alloc(length);
    const bytes = readSync(descriptor, buffer, 0, length, stat.size - length);
    const events: z.infer<typeof eventSchema>[] = [];
    for (const line of buffer
      .subarray(0, bytes)
      .toString("utf8")
      .split(/\r?\n/u)) {
      const start = line.match(
        /\[DEBUG-1874\] wait start expectedLen=(\d+) route=replacement$/u,
      );
      const poll = line.match(
        /\[DEBUG-1874\] poll t=(\d+)ms observedLen=(-?\d+) expectedPrefixLen=(-?\d+)$/u,
      );
      const result = line.match(
        /\[DEBUG-1874\] wait outcome=(settled|unobservable|notObserved) elapsedMs=(\d+) route=replacement$/u,
      );
      const parsed = eventSchema.safeParse(
        start
          ? { phase: "commit-start", expectedLength: Number(start[1]) }
          : poll
            ? {
                phase: "commit-poll",
                elapsedMs: Number(poll[1]),
                observedLength: Number(poll[2]),
                expectedPrefixLength: Number(poll[3]),
              }
            : result
              ? {
                  phase: "commit-result",
                  outcome: result[1],
                  elapsedMs: Number(result[2]),
                }
              : undefined,
      );
      if (parsed.success && events.length < 1_000) events.push(parsed.data);
    }
    return { schemaVersion: 1 as const, events };
  } catch {
    return;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readReplayTextEntryDiagnostics(
  temporaryRoot: string,
  session: string,
) {
  // agent-device 0.21.20 exposes the replay session in progress events, but
  // supplies its log path only after deleting the isolated daemon directory.
  const name = session.replaceAll(/[^a-zA-Z0-9._-]/gu, "_");
  if (!name || name === "." || name === "..") return;
  try {
    for (const directory of readdirSync(temporaryRoot, {
      withFileTypes: true,
    })) {
      if (
        !directory.isDirectory() ||
        !directory.name.startsWith("agent-device-replay-daemon-")
      )
        continue;
      const result = readNativeTextEntryDiagnostics(
        join(temporaryRoot, directory.name, "sessions", name, "runner.log"),
      );
      if (result) return result;
    }
  } catch {
    return;
  }
}
