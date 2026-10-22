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

const report = (
  purpose: string,
  status: string,
  steps: Step[],
): RunStepsReport => ({
  code: shortcode("RUN-4K7M"),
  purpose,
  status,
  steps,
});

const counted = (total: number) => ({
  input: {
    mode: "count" as const,
    total,
    boundary: null,
    countedAt: "2026-10-18T12:00:00Z",
  },
});

describe("Steps ledger", () => {
  it("shows counts and raw errors, offers Retry failed once the Run stops, and reads an unstarted step as Not started", () => {
    const [block] = runStepsBlocks(
      report("maintenance", "needs_review", [
        step({
          key: "exif",
          label: "EXIF/GPS extraction",
          state: "failed",
          found: 5_560,
          done: 5_557,
          failed: 3,
          meta: counted(5_560),
          errors: [
            {
              at: "2026-10-18T12:10:00Z",
              ref: "image:synthetic-1",
              message: "R2 object not found: synthetic/IMG-0001.heic (404)",
            },
          ],
        }),
        step({
          key: "pending-uploads",
          label: "Pending uploads",
          state: "queued",
          found: 12,
          pages: 0,
          startedAt: null,
          endedAt: null,
        }),
      ]),
    );
    if (block?.kind !== "records") throw new Error("expected records");
    const [exif, pending] = block.rows;
    expect(exif?.trailing).toBe("5,557 of 5,560 images");
    expect(exif?.state).toEqual({ kind: "failed", label: "Failures" });
    expect(exif?.lines?.map((line) => line.text)).toContain(
      "R2 object not found: synthetic/IMG-0001.heic (404)",
    );
    expect(exif?.commands?.[0]?.request).toEqual({
      kind: "operation",
      operation: "run.retryStep",
      body: { runId: "RUN-4K7M", stepKey: "exif" },
    });
    expect(pending?.state).toEqual({
      kind: "not_reached",
      label: "Not started",
    });
    expect(pending?.trailing).toBeNull();
    expect(pending?.lines?.map((line) => line.text).join("\n")).not.toMatch(
      /Nothing to do|left/,
    );
  });

  it("withholds Retry failed while running and shows the current action, tallies and no-result reasons", () => {
    const [block] = runStepsBlocks(
      report("sweep", "running", [
        step({
          key: "transfer_pair_scan",
          label: "Transfer pairs: scan",
          state: "running",
          found: 1_280,
          done: 410,
          failed: 2,
          left: 868,
          endedAt: null,
          meta: {
            ...counted(1_280),
            action: null,
            tallies: { pairs: 12 },
            reasons: { no_candidate: 380, suppressed: 4 },
          },
        }),
      ]),
    );
    if (block?.kind !== "records") throw new Error("expected records");
    const [scan] = block.rows;
    expect(scan?.commands).toEqual([]);
    expect(scan?.trailing).toBe("410 of 1,280 movements");
    expect(scan?.lines?.map((line) => line.text)).toEqual(
      expect.arrayContaining([
        "Scanning movements",
        "12 pairs",
        "No result: 380 no candidate · 4 suppressed",
      ]),
    );
  });
});
