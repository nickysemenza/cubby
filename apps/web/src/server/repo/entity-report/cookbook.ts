import type { ReportBlock, ReportCommand } from "@cubby/schemas/entity-report";
import { cookbookShortcode } from "@cubby/schemas/identifiers";
import { and, eq, sql } from "drizzle-orm";

import { formatCurrency } from "~/lib/utils";
import type { Database } from "~/server/db";
import { cookbook } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

const RETIRED_FORMAT_TEXT =
  "Extracted with a retired format — re-extract from the EPUB to restore the source, its run report, and sub-recipe links.";

/**
 * What one extraction of a book cost and how complete it was: the handful of facts worth reading
 * months later. A book can look finished in the recipes list while the run that produced it dropped
 * chunks, and the only record of that is the stored run report, so `incomplete` is the reason this
 * report exists. Only the report column is read: the stored tree is the whole book.
 */
export async function cookbookExtractionReport(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  const id = await resolveOrThrow(db, "cookbook", code);
  const [row] = await getDb(db)
    .select({
      report: cookbook.report,
      // Rows from before the book-tree format hold a flat array and no readable report.
      retired: sql<boolean>`jsonb_typeof(${cookbook.rawJson}) = 'array'`,
    })
    .from(cookbook)
    .where(and(eq(cookbook.id, id), notDeleted(cookbook)));
  if (row?.retired)
    return [
      {
        kind: "note",
        strong: true,
        tone: "warning",
        text: RETIRED_FORMAT_TEXT,
      },
    ];
  const report = row?.report;
  if (!report)
    return [
      {
        kind: "note",
        text: "No run report is stored for this cookbook — it was imported before runs were recorded, or from a JSON export.",
      },
    ];

  const seconds = report.wall_ms / 1000;
  const recall = report.crosscheck.recall ?? null;
  return [
    {
      kind: "stats",
      figures: [
        {
          label: "Cost",
          value: report.total_cost_usd,
          format: "text",
          text: `${formatCurrency(report.total_cost_usd)}${report.cost_complete ? "" : "+"}`,
        },
        {
          label: "Wall time",
          value: seconds,
          format: "text",
          text: `${Math.round(seconds)}s`,
        },
        {
          label: "Contents titles matched",
          value: report.crosscheck.matched,
          format: "text",
          text: `${report.crosscheck.matched}/${report.crosscheck.nav_titles}`,
        },
        ...(recall === null
          ? []
          : [
              {
                label: "Recall",
                value: recall,
                format: "text" as const,
                text: `${Math.round(recall * 100)}%`,
              },
            ]),
      ],
    },
    ...(report.usage_by_model.length > 0
      ? [
          {
            kind: "note" as const,
            text: `Models: ${report.usage_by_model
              .map((usage) => `${usage.model} (${usage.calls})`)
              .join(", ")}`,
          },
        ]
      : []),
    ...(report.cost_complete
      ? []
      : [
          {
            kind: "note" as const,
            text: "An unpriced model was used, so the real cost is higher than shown.",
          },
        ]),
    ...(report.incomplete || report.cancelled
      ? [
          {
            kind: "note" as const,
            strong: true,
            tone: "warning" as const,
            text: report.cancelled
              ? "This run was cancelled — the book was only partly read."
              : "This run finished incomplete — some chunks failed every model, so recipes in them are missing. Re-extract from the EPUB to recover them.",
          },
        ]
      : []),
  ];
}

/** Source recipes listed at once; "Add all" still imports every one. */
const MAX_LISTED = 100;

/**
 * How much of the book's source has become recipes, and what can be done about the rest: import a
 * source recipe the book does not hold yet, or re-derive the imported ones from the stored
 * extraction (neither uses AI). Reads the stored tree, so a client asks for it only when the person
 * opens the section.
 */
export async function cookbookImportProgressReport(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  const id = await resolveOrThrow(db, "cookbook", code);
  const cookbookId = cookbookShortcode.parse(code);
  const [{ getCookbookSourceCoverage }, { COOKBOOK_COMMAND_CHUNK }] =
    await Promise.all([
      import("~/server/repo/cookbook"),
      import("@cubby/schemas/import-recipe"),
    ]);
  let coverage;
  try {
    coverage = await getCookbookSourceCoverage(db, id);
  } catch {
    // A flat pre-tree array has no readable source; the extraction report says so too.
    return [
      {
        kind: "note",
        strong: true,
        tone: "warning",
        text: RETIRED_FORMAT_TEXT,
      },
    ];
  }
  const { total, missing } = coverage;
  const all = { length: total };
  const importedCount = all.length - missing.length;
  const importCommand = (
    recipeIds: string[],
    label: string,
    prominent: boolean,
    confirm: string | null = null,
  ): ReportCommand => ({
    id: `import:${recipeIds.length === 1 ? recipeIds[0] : "all"}`,
    label,
    prominent,
    confirm,
    request: {
      kind: "import-cookbook-recipes",
      cookbookId,
      recipeIds,
      chunkSize: COOKBOOK_COMMAND_CHUNK,
    },
  });
  const listing: Extract<ReportBlock, { kind: "records" }> = {
    kind: "records",
    title: "Not yet imported",
    rows: missing.slice(0, MAX_LISTED).map((entry) => ({
      entity: null,
      id: null,
      title: entry.recipe.name,
      subtitle: entry.chapter,
      trailing: null,
      key: entry.recipe.id,
      commands: [importCommand([entry.recipe.id], "Add", false)],
    })),
    empty: "Every recipe in the source is in this book.",
    commands: [
      ...(missing.length > 1
        ? [
            importCommand(
              missing.map((entry) => entry.recipe.id),
              `Add all ${missing.length}`,
              true,
              `Import all ${missing.length} source recipes (no AI)? It runs ${COOKBOOK_COMMAND_CHUNK} at a time and stops at the first error.`,
            ),
          ]
        : []),
      {
        id: "reprocess",
        label: "Reprocess",
        prominent: false,
        confirm: `Re-derive the ${importedCount} imported recipe${importedCount === 1 ? "" : "s"} from the stored extraction (no AI)? This rewrites those recipes.`,
        request: { kind: "reprocess-cookbook", cookbookId },
      },
    ],
  };
  if (missing.length > MAX_LISTED)
    listing.footer = `${missing.length - MAX_LISTED} more not listed.`;
  return [
    {
      kind: "stats",
      figures: [
        {
          label: "Imported",
          value: importedCount,
          format: "text",
          text: `${importedCount} of ${all.length} source recipes imported`,
        },
      ],
    },
    listing,
  ];
}
