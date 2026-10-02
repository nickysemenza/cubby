import type { CookbookRunReport } from "@cubby/schemas/cookbook";
import { z } from "zod";

/**
 * Readers for the parts of a run report this UI renders.
 *
 * `cookbookRunReportSchema` deliberately keeps `calls` and `chunks` as opaque
 * JSON records: the server stores whatever the crate wrote and never re-derives
 * it. The review surface, though, has to lay those rows out in a table, so it
 * states here — and only here — which fields it reads. Every field is optional
 * and every row is parsed independently, so an older stored report, or a newer
 * crate that adds a field, renders what it has instead of blanking the panel.
 */

const chunkRow = z.object({
  id: z.string().default(""),
  start: z.number().optional(),
  end: z.number().optional(),
  status: z.string().optional(),
  final_model: z.string().nullish(),
  attempts: z.number().optional(),
  recipes: z.number().optional(),
  cached: z.boolean().optional(),
  // A flag is a tagged union in Rust; the tag is the part worth showing, and
  // the rest is carried along verbatim for the tooltip.
  flags: z.array(z.looseObject({ flag: z.string() })).default([]),
});
export type ChunkRow = z.output<typeof chunkRow>;

const callRow = z.object({
  seq: z.number().optional(),
  chunk_id: z.string().default(""),
  model: z.string().default(""),
  purpose: z.string().optional(),
  attempt: z.number().optional(),
  latency_ms: z.number().optional(),
  cached: z.boolean().optional(),
  status: z.number().nullish(),
  cost_usd: z.number().nullish(),
  truncated: z.boolean().optional(),
  outcome: z.looseObject({ outcome: z.string() }).optional(),
});
export type CallRow = z.output<typeof callRow>;

const escalation = z.object({
  reason: z.string().default(""),
  flagged_fraction: z.number().optional(),
  from_model: z.string().default(""),
  to_model: z.string().default(""),
});

const unresolvedRef = z.object({
  item_id: z.string().default(""),
  line: z.number().optional(),
  text: z.string().default(""),
});
export type UnresolvedRefRow = z.output<typeof unresolvedRef>;

/**
 * Parse each row on its own. A row the schema cannot read is dropped rather
 * than sinking the panel: a stored report is whatever the crate wrote on the
 * day of the run, and one unreadable entry is no reason to show nothing.
 */
const rows = <T>(raw: CookbookRunReport["chunks"], schema: z.ZodType<T>): T[] =>
  raw.flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });

const reportChunks = (report: CookbookRunReport): ChunkRow[] =>
  rows(report.chunks, chunkRow);

export const reportCalls = (report: CookbookRunReport): CallRow[] =>
  rows(report.calls, callRow);

export const reportEscalation = (report: CookbookRunReport) => {
  const parsed = escalation.safeParse(report.escalation);
  return parsed.success ? parsed.data : null;
};

export const reportUnresolvedRefs = (
  report: CookbookRunReport,
): UnresolvedRefRow[] => {
  const parsed = z.array(unresolvedRef).safeParse(report.unresolved_refs);
  return parsed.success ? parsed.data : [];
};

/**
 * The chunks worth showing in the failures panel: the ones that failed outright
 * (their recipes were lost) and the ones the crate flagged (their recipes are
 * present but suspect — a low parse rate, a truncated response, a title the
 * table of contents has but the text did not yield).
 */
export const troubledChunks = (report: CookbookRunReport): ChunkRow[] =>
  reportChunks(report).filter(
    (chunk) => chunk.status === "failed" || chunk.flags.length > 0,
  );

/** A one-line summary of a chunk's flags, for the panel and its tooltip. */
export const flagSummary = (chunk: ChunkRow): string =>
  chunk.flags.map((flag) => flag.flag).join(", ");
