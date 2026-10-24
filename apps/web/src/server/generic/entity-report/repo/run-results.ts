import { auditEntitySchema, auditLogActionSchema } from "@cubby/schemas/audit";
import type { ReportBlock } from "@cubby/schemas/entity-report";
import { parseEntityRef, type RunId } from "@cubby/schemas/identifiers";
import { suggestionListFamily } from "@cubby/schemas/suggestion-list";
import { and, count, desc, eq, inArray, max, sql } from "drizzle-orm";

import type { RunDetailStep } from "~/contracts/run-detail.contract";
import type { Database } from "~/server/db/database";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import {
  assessment,
  assessmentState,
  auditLog,
} from "~/server/db/retained-tables";

const RECORD_LIMIT = 25;

/** Read existing evidence only. Composition batches labels and public codes before transport. */
export async function runResultsBlocks(
  db: Database,
  runId: RunId,
  code: string,
  steps: readonly Pick<
    RunDetailStep,
    "key" | "label" | "done" | "skipped" | "failed"
  >[],
): Promise<ReportBlock[]> {
  const connection = getDb(db);
  const changed = connection
    .select({
      entity: auditLog.entityKind,
      id: auditLog.entityId,
      created:
        sql<boolean>`bool_or(${auditLog.action} = ${auditLogActionSchema.enum.create})`.as(
          "created",
        ),
      edited:
        sql<boolean>`bool_or(${auditLog.action} = ${auditLogActionSchema.enum.update})`.as(
          "edited",
        ),
      deleted:
        sql<boolean>`bool_or(${auditLog.action} = ${auditLogActionSchema.enum.delete})`.as(
          "deleted",
        ),
      at: max(auditLog.createdAt).as("at"),
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.runId, runId),
        inArray(auditLog.entityKind, auditEntitySchema.options),
      ),
    )
    .groupBy(auditLog.entityKind, auditLog.entityId)
    .as("changed");
  const publicationScope = eq(
    sql<string>`${assessment.producer}->>'runId'`,
    runId,
  );
  const [rows, [totals], publications, [assessed]] = await Promise.all([
    connection
      .select()
      .from(changed)
      .orderBy(desc(changed.at), changed.entity, changed.id)
      .limit(RECORD_LIMIT),
    connection
      .select({
        records: count(),
        created:
          sql<number>`count(*) filter (where ${changed.created})`.mapWith(
            Number,
          ),
        edited: sql<number>`count(*) filter (where ${changed.edited})`.mapWith(
          Number,
        ),
        deleted:
          sql<number>`count(*) filter (where ${changed.deleted})`.mapWith(
            Number,
          ),
      })
      .from(changed),
    connection
      .select({
        family: assessment.family,
        status: assessmentState.status,
        active: assessmentState.active,
        total: count(),
      })
      .from(assessment)
      .leftJoin(assessmentState, eq(assessmentState.id, assessment.id))
      // Producer is immutable history; later review or supersession must not erase publication.
      .where(publicationScope)
      .groupBy(
        assessment.family,
        assessmentState.status,
        assessmentState.active,
      ),
    connection
      .select({
        records:
          sql<number>`count(distinct (${assessment.subject}->>'entity', ${assessment.subject}->>'recordId')) filter (where ${assessment.subject}->>'recordId' is not null)`.mapWith(
            Number,
          ),
      })
      .from(assessment)
      .where(
        and(
          publicationScope,
          inArray(assessment.family, suggestionListFamily.options),
        ),
      ),
  ]);
  const figure = (label: string, value: number) => ({
    label,
    value,
    format: "count" as const,
  });
  const blocks: ReportBlock[] = [
    {
      kind: "stats",
      title: "Changed by this Run",
      figures: [
        figure("Records", totals?.records ?? 0),
        figure("Created", totals?.created ?? 0),
        figure("Edited", totals?.edited ?? 0),
        figure("Deleted", totals?.deleted ?? 0),
      ],
    },
    {
      kind: "records",
      title: "Records changed",
      totalCount: totals?.records ?? 0,
      empty:
        "No record changes are attributed to this Run. Published Suggestions and processed inputs appear separately.",
      rows: rows.map((row) => {
        const ref = parseEntityRef(row.entity, row.id);
        return {
          entity: ref.entity,
          id: ref.id,
          title: ref.entity,
          trailing: null,
          badges: [
            ...(row.created ? [{ label: "Created" }] : []),
            ...(row.edited ? [{ label: "Edited" }] : []),
            ...(row.deleted ? [{ label: "Deleted" }] : []),
          ],
        };
      }),
    },
  ];
  if ((totals?.records ?? 0) > 0)
    blocks.push({
      kind: "note",
      text: "Each record is counted once per action, even if changed repeatedly. A record can be both created and edited. Changes contains the full history and field differences.",
    });
  const suggestions = publications.filter((row) =>
    suggestionListFamily.options.some((family) => family === row.family),
  );
  const published = suggestions.reduce((sum, row) => sum + row.total, 0);
  const statusCount = (status: string) =>
    suggestions
      .filter(
        (row) => row.status === status && (status !== "pending" || row.active),
      )
      .reduce((sum, row) => sum + row.total, 0);
  const inactive = suggestions
    .filter((row) => row.status === "pending" && !row.active)
    .reduce((sum, row) => sum + row.total, 0);
  const historyOnly = suggestions
    .filter((row) => row.status === null)
    .reduce((sum, row) => sum + row.total, 0);
  if (published) {
    blocks.push(
      {
        kind: "stats",
        title: "Suggestions published",
        figures: [
          figure("Published", published),
          figure("Records assessed", assessed?.records ?? 0),
          figure("Pending", statusCount("pending")),
          figure("Applied", statusCount("applied")),
          figure("Rejected", statusCount("rejected")),
          figure("Superseded", statusCount("superseded")),
          figure("Resolved", statusCount("resolved")),
          ...(inactive ? [figure("Inactive", inactive)] : []),
          ...(historyOnly ? [figure("History only", historyOnly)] : []),
        ],
      },
      {
        kind: "note",
        text: "Suggestion statuses reflect later reviews and applications too. An applied Suggestion does not mean this Run changed its records. Review this Run’s Suggestions to inspect their evidence and application receipts.",
      },
      {
        kind: "table",
        columns: ["Review"],
        rows: [
          {
            id: "suggestions",
            cells: ["Review this Run’s Suggestions"],
            presentation: {
              "0": {
                kind: "links",
                links: [
                  {
                    label: "Review this Run’s Suggestions",
                    href: `/suggestions?runId=${encodeURIComponent(code)}`,
                  },
                ],
              },
            },
          },
        ],
      },
    );
  }
  const other = publications
    .filter((row) => !suggestions.includes(row))
    .reduce((sum, row) => sum + row.total, 0);
  if (other)
    blocks.push({
      kind: "stats",
      title: "Other decisions published",
      figures: [figure("Published", other)],
    });
  if (steps.length)
    blocks.push(
      {
        kind: "table",
        title: "Inputs processed",
        columns: ["Step", "Completed work units", "Skipped", "Failed"],
        rows: steps.map((step) => ({
          id: step.key,
          cells: [
            step.label,
            String(step.done),
            String(step.skipped),
            String(step.failed),
          ],
        })),
      },
      {
        kind: "note",
        text: "Work units can revisit a record or process it in several steps; they are not unique record counts. Steps shows the input scopes and available review links.",
      },
    );
  return blocks;
}
