/** Shared pacing and checkpoint loop for long lived Run consumers. */
export type BatchOutcome = "applied" | "queued" | "failed";
export interface PacedBatchPorts {
  isPaused(): Promise<boolean>;
  saveProgress(progress: {
    total: number;
    done: number;
    applied: number;
    queued: number;
    failed: number;
  }): Promise<void>;
  wait(milliseconds: number): Promise<void>;
}
export async function runPacedBatch<T>(args: {
  targets: readonly T[];
  startAt?: number;
  pacePerMinute?: number;
  work(target: T, index: number): Promise<BatchOutcome>;
  ports: PacedBatchPorts;
}) {
  const total = args.targets.length;
  const pace = args.pacePerMinute ?? 300;
  if (!Number.isFinite(pace) || pace <= 0)
    throw new Error("pacePerMinute must be positive");
  let done = args.startAt ?? 0;
  let applied = 0;
  let queued = 0;
  let failed = 0;
  const interval = 60_000 / pace;
  let lastAt = 0;
  for (let index = done; index < total; index++) {
    if (await args.ports.isPaused()) break;
    if (lastAt)
      await args.ports.wait(Math.max(0, interval - (Date.now() - lastAt)));
    if (await args.ports.isPaused()) break;
    lastAt = Date.now();
    try {
      const outcome = await args.work(args.targets[index]!, index);
      if (outcome === "applied") applied++;
      else if (outcome === "queued") queued++;
      else failed++;
    } catch {
      // SILENT: one failed item is represented in the persisted failed count; continue the batch.
      failed++;
    }
    done = index + 1;
    await args.ports.saveProgress({ total, done, applied, queued, failed });
  }
  return { total, done, applied, queued, failed, paused: done < total };
}
