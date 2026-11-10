import { statSync } from "node:fs";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { seededRandom } from "./test-seed.ts";

/**
 * Vitest's path-hash sharding balances file counts, not work: one CI shard
 * drew 393 integration test-seconds against another's 202 and set the
 * slowest lane. This assigns each project's files largest-first to the
 * lightest shard by source size, which tracks duration closely enough to
 * keep every shard within a few percent of even. Within a shard, files keep
 * the seeded shuffle `sequence.shuffle.files` would give them.
 */
export class SizeBalancedSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]) {
    const { index, count } = this.ctx.config.shard ?? { index: 1, count: 1 };
    const size = new Map(files.map((f) => [f, statSync(f.moduleId).size]));
    const byProject = new Map<string, TestSpecification[]>();
    for (const file of files)
      byProject.set(file.project.name, [
        ...(byProject.get(file.project.name) ?? []),
        file,
      ]);
    const mine: TestSpecification[] = [];
    for (const group of byProject.values()) {
      const load = Array<number>(count).fill(0);
      const largestFirst = [...group].sort(
        (a, b) =>
          (size.get(b) ?? 0) - (size.get(a) ?? 0) ||
          a.moduleId.localeCompare(b.moduleId),
      );
      for (const file of largestFirst) {
        const lightest = load.indexOf(Math.min(...load));
        load[lightest] = (load[lightest] ?? 0) + (size.get(file) ?? 0);
        if (lightest === index - 1) mine.push(file);
      }
    }
    return mine;
  }

  override async sort(files: TestSpecification[]) {
    const random = seededRandom(this.ctx.config.sequence.seed);
    const shuffled = [...files];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    return shuffled;
  }
}
