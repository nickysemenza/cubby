import type { ReportRecordRow } from "@cubby/schemas/entity-report";
import { describe, expect, it } from "vitest";

import { foldRepeatedRows } from "./fold-repeats";

const event = (
  id: string,
  fields: Partial<ReportRecordRow> = {},
): ReportRecordRow => ({
  entity: null,
  id: null,
  title: "commit_photo_group",
  trailing: null,
  key: id,
  at: `2026-10-13T17:52:0${id}.000Z`,
  state: { kind: "done", label: "Done" },
  lines: [{ text: `photo-group:${id}`, tone: "muted" }],
  ...fields,
});

const rowsOf = (rows: ReportRecordRow[]) => {
  const [block] = foldRepeatedRows({
    blocks: [{ kind: "records", rows, empty: "" }],
  }).blocks;
  if (block?.kind !== "records") throw new Error("records block missing");
  return block.rows;
};

describe("foldRepeatedRows", () => {
  it("folds a run of the same timed event into one counted row that keeps each row's evidence", () => {
    const rows = rowsOf([event("1"), event("2"), event("3")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "1",
      title: "commit_photo_group",
      trailing: "×3",
      at: "2026-10-13T17:52:01.000Z",
      lines: [],
      detail: { label: "3 events" },
    });
    // Each folded event keeps its own time beside what only it said.
    expect(rows[0]?.detail?.text.split("\n")).toEqual([
      expect.stringMatching(/:01 [AP]M · photo-group:1$/u),
      expect.stringMatching(/:02 [AP]M · photo-group:2$/u),
      expect.stringMatching(/:03 [AP]M · photo-group:3$/u),
    ]);
  });

  it("keeps lines every folded row shares on the folded row", () => {
    const shared = { text: "server", tone: "muted" as const };
    const rows = rowsOf([
      event("1", { lines: [shared] }),
      event("2", { lines: [shared] }),
    ]);
    expect(rows[0]?.lines).toEqual([shared]);
    expect(rows[0]?.detail?.text).not.toContain("server");
  });

  // A failure's diagnostic, a record link, a command and an untimed row each stay on their own row.
  it("never folds failures, rows that open or act on something, or untimed rows", () => {
    const failed = { state: { kind: "failed" as const, label: "Failed" } };
    expect(rowsOf([event("1", failed), event("2", failed)])).toHaveLength(2);
    expect(
      rowsOf([
        event("1", { entity: "run", id: "RUN-4K7M" }),
        event("2", { entity: "run", id: "RUN-4K7M" }),
      ]),
    ).toHaveLength(2);
    expect(
      rowsOf([event("1", { at: undefined }), event("2", { at: undefined })]),
    ).toHaveLength(2);
    expect(
      rowsOf([event("1"), event("2", { title: "other" }), event("3")]),
    ).toHaveLength(3);
  });
});
