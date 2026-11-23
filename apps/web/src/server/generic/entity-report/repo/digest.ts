import type {
  EntityReportOut,
  ReportBlock,
} from "@cubby/schemas/entity-report";

import { formatCurrency } from "~/lib/number-format";

const NAMES = 3;

type Stats = Extract<ReportBlock, { kind: "stats" }>;

const figureText = (figure: Stats["figures"][number]) =>
  figure.text ??
  (figure.value === null
    ? "—"
    : figure.format === "money"
      ? formatCurrency(figure.value)
      : String(figure.value));

/** One block in words, or undefined when it has no line worth reading. */
function blockDigest(block: ReportBlock): string | undefined {
  switch (block.kind) {
    case "stats":
      return block.figures.length
        ? block.figures
            .slice(0, NAMES)
            .map((figure) => `${figure.label} ${figureText(figure)}`)
            .join(" · ")
        : undefined;
    case "records": {
      const count = block.totalCount ?? block.rows.length;
      if (count === 0) return block.empty || undefined;
      const names = block.rows.slice(0, NAMES).map((row) => row.title);
      return [
        `${count} · ${names.join(", ")}${count > names.length ? "…" : ""}`,
        ...(block.footer ? [block.footer] : []),
      ].join(" · ");
    }
    case "progress":
      return block.summary || undefined;
    case "note":
      return block.text || undefined;
    case "table":
      return block.rows.length
        ? `${block.rows.length}${block.truncated ? "+" : ""} ${block.rows.length === 1 ? "row" : "rows"}`
        : block.empty;
    case "chart":
      return block.caption;
    case "schedule":
      return block.rows.length ? `${block.rows.length} scheduled` : undefined;
  }
}

/**
 * The line a folded report stands on, composed once from its blocks for every
 * client: a builder's own digest wins, else the first block that reads well
 * in one line (its leading figures, a record count with the first names, a
 * progress summary or a note).
 */
export function withDigest(report: EntityReportOut): EntityReportOut {
  if (report.digest !== undefined) return report;
  for (const block of report.blocks) {
    const digest = blockDigest(block);
    if (digest) return { ...report, digest };
  }
  return report;
}
