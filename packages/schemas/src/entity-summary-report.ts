/**
 * A summary has one useful informational block plus every diagnostic/coverage note.
 * Remaining information belongs to the full report. Preserve each retained row's
 * links, date and provenance; only workflow controls are removed.
 */
export function summaryReportProjection(
  blocks: readonly import("./entity-report").ReportBlock[],
) {
  const primary = blocks.find(
    (block) =>
      block.kind !== "note" &&
      (block.kind !== "records" || block.rows.length > 0),
  );
  const notes = blocks.filter((block) => block.kind === "note");
  if (!primary)
    return {
      blocks: [
        ...notes,
        ...blocks.filter((block) => block.kind === "records").slice(0, 1),
      ],
      more: false,
    };
  const projected =
    primary.kind === "stats"
      ? { ...primary, figures: primary.figures.slice(0, 4) }
      : primary.kind === "records"
        ? {
            ...primary,
            rows: primary.rows
              .slice(0, 3)
              .map(
                ({
                  actions: _actions,
                  commands: _commands,
                  choice: _choice,
                  ...row
                }) => row,
              ),
            actions: undefined,
            verbs: undefined,
            form: undefined,
            commands: undefined,
          }
        : primary.kind === "table"
          ? { ...primary, rows: primary.rows.slice(0, 3) }
          : primary;
  const truncated =
    primary.kind === "stats"
      ? primary.figures.length > 4
      : primary.kind === "records" || primary.kind === "table"
        ? primary.rows.length > 3
        : false;
  return {
    blocks: blocks.flatMap((block) =>
      block === primary ? [projected] : block.kind === "note" ? [block] : [],
    ),
    more:
      truncated ||
      blocks.some((block) => block !== primary && block.kind !== "note"),
  };
}
