import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

type DurationMap = Record<string, number>;

function loadDurations(root: string): DurationMap {
  const path = `${root}/tooling/test-durations.json`;
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    );
  } catch {
    // A timing hint must never make a test invocation unavailable.
    return {};
  }
}

/**
 * Uses the latest green CI duration map when one exists. Otherwise preserve
 * Vitest's deterministic hash sharding.
 */
export default class DurationSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]) {
    const durations = loadDurations(this.ctx.config.root);
    if (Object.keys(durations).length === 0) return super.shard(files);

    const { count, index } = this.ctx.config.shard!;
    const bins = Array.from({ length: count }, () => ({
      total: 0,
      files: [] as TestSpecification[],
    }));
    const fallback = Math.max(
      1,
      ...Object.values(durations).filter((duration) => duration > 0),
    );
    const ranked = [...files].sort((a, b) => {
      const aDuration =
        durations[relative(this.ctx.config.root, a.moduleId)] ?? fallback;
      const bDuration =
        durations[relative(this.ctx.config.root, b.moduleId)] ?? fallback;
      return bDuration - aDuration || a.moduleId.localeCompare(b.moduleId);
    });

    for (const file of ranked) {
      const bin = bins.reduce((least, candidate) =>
        candidate.total < least.total ? candidate : least,
      );
      bin.files.push(file);
      bin.total +=
        durations[relative(this.ctx.config.root, file.moduleId)] ?? fallback;
    }
    return bins[index - 1]!.files;
  }
}
