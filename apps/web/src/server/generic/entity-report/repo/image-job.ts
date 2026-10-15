import type { ReportBlock, ReportRowState } from "@cubby/schemas/entity-report";
import {
  imageProcessingAttemptState,
  type ImageProcessingAttemptState,
} from "@cubby/schemas/image-processing";
import { asc, count, desc, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import {
  imageProcessingAttempt,
  imageProcessingEvent,
} from "~/server/db/image-processing-schema";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

/** Events beyond this stay in storage; the report says how many it left out. */
const EVENT_LIMIT = 200;

type Records = Extract<ReportBlock, { kind: "records" }>;
type Row = Records["rows"][number];

const ATTEMPT_STATE = {
  ready: { kind: "done", label: "Completed" },
  skipped: { kind: "skipped", label: "Skipped" },
  failed: { kind: "failed", label: "Failed" },
  expired: { kind: "failed", label: "Lease expired" },
  waiting: { kind: "warning", label: "Waiting for Apple" },
  leased: { kind: "running", label: "Claimed" },
  running: { kind: "running", label: "Processing" },
} as const satisfies Record<
  ImageProcessingAttemptState,
  { kind: ReportRowState; label: string }
>;

/** An unrecognised stored state keeps its own word without a mark. */
const attemptState = (state: string) => {
  const known = imageProcessingAttemptState.safeParse(state);
  return known.success
    ? ATTEMPT_STATE[known.data]
    : { kind: "not_reached" as const, label: state };
};

const json = (value: unknown) => JSON.stringify(value, null, 2);

const executorName = (executor: unknown): string | null =>
  executor && typeof executor === "object" && "name" in executor
    ? String(executor.name)
    : null;

const row = (fields: Partial<Row> & Pick<Row, "title">): Row => ({
  entity: null,
  id: null,
  trailing: null,
  ...fields,
});

/**
 * An Image job's attempts (newest first, each with its retained diagnostics
 * and result) and then its events, for web and native to draw alike.
 */
export async function imageJobAttemptsReport(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  const jobId = await resolveOrThrow(db, "imageJob", code);
  const [attempts, events, [total]] = await Promise.all([
    getDb(db)
      .select()
      .from(imageProcessingAttempt)
      .where(eq(imageProcessingAttempt.jobId, jobId))
      .orderBy(desc(imageProcessingAttempt.number)),
    getDb(db)
      .select()
      .from(imageProcessingEvent)
      .where(eq(imageProcessingEvent.jobId, jobId))
      .orderBy(
        asc(imageProcessingEvent.occurredAt),
        asc(imageProcessingEvent.id),
      )
      .limit(EVENT_LIMIT),
    getDb(db)
      .select({ value: count() })
      .from(imageProcessingEvent)
      .where(eq(imageProcessingEvent.jobId, jobId)),
  ]);
  const remaining = (total?.value ?? 0) - events.length;
  return [
    {
      kind: "records",
      title: "Attempts",
      empty: "No attempt has claimed this job yet.",
      rows: attempts.map((attempt) => {
        const executor = executorName(attempt.executor);
        const evidence = [
          attempt.diagnostics === null
            ? null
            : `Diagnostics\n${json(attempt.diagnostics)}`,
          attempt.result === null ? null : `Result\n${json(attempt.result)}`,
        ].filter((part) => part !== null);
        return row({
          title: `Attempt #${attempt.number}`,
          at: (attempt.completedAt ?? attempt.startedAt).toISOString(),
          state: attemptState(attempt.state),
          lines: [
            ...(executor ? [{ text: executor, tone: "muted" as const }] : []),
            ...(attempt.error
              ? [{ text: attempt.error, tone: "destructive" as const }]
              : []),
            ...(evidence.length === 0
              ? [
                  {
                    text: "No diagnostics were recorded for this attempt.",
                    tone: "muted" as const,
                  },
                ]
              : []),
          ],
          ...(evidence.length > 0
            ? {
                detail: {
                  label: "Diagnostics and result",
                  text: evidence.join("\n\n"),
                },
              }
            : {}),
        });
      }),
    },
    {
      kind: "records",
      title: "Events",
      empty: "No events have been recorded.",
      rows: events.map((event) =>
        row({
          title: event.event,
          at: event.occurredAt.toISOString(),
          state: {
            kind:
              event.level === "error"
                ? "failed"
                : event.level === "debug"
                  ? "skipped"
                  : "done",
            label: event.level,
          },
          lines: [
            {
              text:
                event.attempt === null
                  ? event.source
                  : `${event.source} · attempt #${event.attempt}`,
              tone: "muted",
            },
          ],
          ...(event.details === null
            ? {}
            : { detail: { label: "Diagnostics", text: json(event.details) } }),
        }),
      ),
      ...(remaining > 0
        ? { footer: `${remaining} later events are retained but not shown.` }
        : {}),
    },
  ];
}
