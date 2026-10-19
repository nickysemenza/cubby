import { shortcode } from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";

import { runStepsBlocks, type RunStepsReport } from "./run";

type Step = RunStepsReport["steps"][number];

const step = (fields: Partial<Step> & Pick<Step, "key" | "label">): Step => ({
  id: crypto.randomUUID(),
  runId: crypto.randomUUID() as Step["runId"],
  position: 0,
  state: "done",
  found: 0,
  done: 0,
  failed: 0,
  skipped: 0,
  pages: 1,
  left: 0,
  childRunId: null,
  childShortcode: null,
  cursor: null,
  pausedReason: null,
  pausedUntil: null,
  errors: [],
  meta: null,
  startedAt: new Date("2026-10-18T12:00:00Z"),
  endedAt: new Date("2026-10-18T12:18:00Z"),
  createdAt: new Date("2026-10-18T12:00:00Z"),
  updatedAt: new Date("2026-10-18T12:18:00Z"),
  ...fields,
});

const report = (status: string, steps: Step[]): RunStepsReport => ({
  code: shortcode("RUN-4K7M"),
  status,
  steps,
});

describe("Steps ledger", () => {
  it("shows counts and raw errors, offers Retry failed once the Run stops, and collapses idle steps", () => {
    const [block] = runStepsBlocks(
      report("needs_review", [
        step({
          key: "exif",
          label: "EXIF/GPS extraction",
          state: "failed",
          found: 5_560,
          done: 5_557,
          failed: 3,
          errors: [
            {
              at: "2026-10-18T12:10:00Z",
              ref: "image:synthetic-1",
              message: "R2 object not found: synthetic/IMG-0001.heic (404)",
            },
          ],
        }),
        step({ key: "embeddings", label: "Embeddings" }),
        step({ key: "recipes", label: "Recipe totals" }),
      ]),
    );
    if (block?.kind !== "records") throw new Error("expected records");
    expect(block.rows.map((row) => row.title)).toEqual([
      "EXIF/GPS extraction",
      "2 steps with nothing to do",
    ]);
    const [exif, idle] = block.rows;
    expect(exif?.trailing).toBe("5,557 of 5,560");
    expect(exif?.state).toEqual({ kind: "failed", label: "Failures" });
    expect(exif?.lines?.map((line) => line.text)).toEqual([
      "5,557 done · 3 failed · 0 skipped · 0 left · 18m 0s",
      "R2 object not found: synthetic/IMG-0001.heic (404)",
    ]);
    expect(exif?.commands?.[0]?.request).toEqual({
      kind: "retry-run-step",
      runId: "RUN-4K7M",
      stepKey: "exif",
    });
    expect(idle?.lines?.[0]?.text).toBe("Embeddings, Recipe totals");
  });

  it("withholds Retry failed while the Run is still running and links a step's child Run", () => {
    const [block] = runStepsBlocks(
      report("running", [
        step({
          key: "connections",
          label: "Connections",
          state: "waiting",
          found: 1_280,
          done: 410,
          failed: 2,
          left: 868,
          childShortcode: "RUN-8T2Q",
          endedAt: null,
        }),
      ]),
    );
    if (block?.kind !== "records") throw new Error("expected records");
    expect(block.rows[0]?.commands).toEqual([]);
    expect(block.rows[0]).toMatchObject({ entity: "run", id: "RUN-8T2Q" });
  });
});
