import type {
  EntityReportOut,
  ReportBlock,
  ReportRecordRow,
} from "@cubby/schemas/entity-report";

import { formatInstant } from "~/lib/date-format";

type Line = NonNullable<ReportRecordRow["lines"]>[number];

const lineKey = (line: Line) => `${line.tone ?? ""}:${line.text}`;

/**
 * A row that only reports a moment: it opens nothing, decides nothing and has no failure to read.
 * Failures and warnings never fold, so their diagnostics stay on their own rows.
 */
const foldable = (row: ReportRecordRow) =>
  row.at !== undefined &&
  row.id === null &&
  row.trailing === null &&
  !row.imageUrl &&
  !row.listLink &&
  !row.externalLink &&
  !row.detail &&
  !row.choice &&
  !row.commands?.length &&
  !row.actions?.length &&
  row.state?.kind !== "failed" &&
  row.state?.kind !== "warning" &&
  !row.lines?.some(
    (line) => line.tone === "warning" || line.tone === "destructive",
  );

const sameEvent = (a: ReportRecordRow, b: ReportRecordRow) =>
  a.title === b.title &&
  a.state?.kind === b.state?.kind &&
  a.state?.label === b.state?.label &&
  JSON.stringify(a.badges ?? []) === JSON.stringify(b.badges ?? []);

/** A run of the same event as its first row with a count; what differs moves into its detail. */
const fold = (run: ReportRecordRow[]): ReportRecordRow => {
  const [first] = run;
  if (!first) throw new Error("A folded run has no rows.");
  if (run.length === 1) return first;
  const shared = (first.lines ?? []).filter((line) =>
    run.every((row) =>
      (row.lines ?? []).some((own) => lineKey(own) === lineKey(line)),
    ),
  );
  const sharedKeys = new Set(shared.map(lineKey));
  // Each folded row keeps its own moment beside what only it said.
  const differs = run.map((row) =>
    [
      ...(row.at ? [formatInstant(row.at, "time")] : []),
      ...(row.lines ?? [])
        .filter((line) => !sharedKeys.has(lineKey(line)))
        .map((line) => line.text),
    ].join(" · "),
  );
  return {
    ...first,
    trailing: `×${run.length}`,
    lines: shared,
    detail: { label: `${run.length} events`, text: differs.join("\n") },
  };
};

const foldRows = (rows: readonly ReportRecordRow[]) => {
  const runs: ReportRecordRow[][] = [];
  for (const row of rows) {
    const run = runs.at(-1);
    const last = run?.at(-1);
    if (run && last && foldable(last) && foldable(row) && sameEvent(last, row))
      run.push(row);
    else runs.push([row]);
  }
  return runs.map(fold);
};

/**
 * Consecutive timed rows that say the same thing (a run committing eleven photo groups) read as
 * one row, `×11`, for every client; each row's own evidence stays in the folded row's detail.
 */
export function foldRepeatedRows(report: EntityReportOut): EntityReportOut {
  return {
    ...report,
    blocks: report.blocks.map((block): ReportBlock =>
      block.kind === "records" && block.presentation !== "filmstrip"
        ? { ...block, rows: foldRows(block.rows) }
        : block,
    ),
  };
}
