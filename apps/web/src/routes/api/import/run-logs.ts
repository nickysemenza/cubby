import { createFileRoute } from "@tanstack/react-router";
import { asc, eq } from "drizzle-orm";

import {
  purchaseImportDebugEvent,
  purchaseImportRunLogRequest,
  purchaseImportRunLogResponse,
  type PurchaseImportRunLogEntry,
} from "~/lib/purchase-import-debug";
import { importRun, importRunOperation } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { createRequestContext, requireActor } from "~/server/request-context";

const DEBUG_EVENT_KIND = "__debug_event";
const MAX_LOG_ENTRIES = 2_000;

const emptyMetadata = {
  commandId: null,
  operationId: null,
  operationKind: null,
  host: null,
  browser: null,
  attempt: null,
  count: null,
  outcome: null,
  messageType: null,
  errorType: null,
  errorCode: null,
  error: null,
} as const;

type OperationRow = Pick<
  typeof importRunOperation.$inferSelect,
  "id" | "operationId" | "kind" | "state" | "result" | "error" | "startedAt"
>;

const operationLogEntry = (
  operation: OperationRow,
): PurchaseImportRunLogEntry | null => {
  if (operation.kind === DEBUG_EVENT_KIND) {
    const event = purchaseImportDebugEvent.safeParse(operation.result);
    if (!event.success) return null;
    return {
      id: operation.id,
      occurredAt: event.data.occurredAt,
      source: "mac",
      level:
        event.data.outcome?.startsWith("failed:") || event.data.errorType
          ? "error"
          : "debug",
      event: event.data.event,
      state: operation.state,
      commandId: event.data.commandId ?? null,
      operationId: event.data.operationId ?? null,
      operationKind: event.data.operationKind ?? null,
      host: event.data.host ?? null,
      browser: event.data.browser ?? null,
      attempt: event.data.attempt ?? null,
      count: event.data.count ?? null,
      outcome: event.data.outcome ?? null,
      messageType: event.data.messageType ?? null,
      errorType: event.data.errorType ?? null,
      errorCode: event.data.errorCode ?? null,
      error: null,
    };
  }
  return {
    id: operation.id,
    occurredAt: operation.startedAt.toISOString(),
    source: "server",
    level: operation.state === "failed" ? "error" : "info",
    event: `tool.${operation.kind}`,
    state: operation.state,
    ...emptyMetadata,
    operationId: operation.operationId,
    error: operation.error ? "Operation failed" : null,
  };
};

export const Route = createFileRoute("/api/import/run-logs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const identifier = purchaseImportRunLogRequest.safeParse(
          await request.json(),
        );
        if (!identifier.success) {
          return Response.json(
            { error: "Import run was not found" },
            { status: 404 },
          );
        }
        const context = requireActor(
          await createRequestContext({ headers: request.headers }),
        );
        const party = await context.currentParty();
        if (!party) {
          return Response.json(
            { error: "This login is not linked to a member ledger party yet." },
            { status: 403 },
          );
        }
        const database = getDb(context.db);
        const [run] = await database
          .select({
            id: importRun.id,
            status: importRun.status,
            failureCode: importRun.failureCode,
            startedAt: importRun.startedAt,
            endedAt: importRun.endedAt,
          })
          .from(importRun)
          .where(
            "publicId" in identifier.data
              ? eq(importRun.publicId, identifier.data.publicId)
              : eq(importRun.id, identifier.data.runId),
          )
          .limit(1);
        if (!run) {
          return Response.json(
            { error: "Import run was not found" },
            { status: 404 },
          );
        }
        const operations = await database
          .select({
            id: importRunOperation.id,
            operationId: importRunOperation.operationId,
            kind: importRunOperation.kind,
            state: importRunOperation.state,
            result: importRunOperation.result,
            error: importRunOperation.error,
            startedAt: importRunOperation.startedAt,
            completedAt: importRunOperation.completedAt,
          })
          .from(importRunOperation)
          .where(eq(importRunOperation.runId, run.id))
          .orderBy(
            asc(importRunOperation.startedAt),
            asc(importRunOperation.id),
          )
          .limit(MAX_LOG_ENTRIES + 1);

        const entries: PurchaseImportRunLogEntry[] = [
          {
            id: `run:${run.id}:started`,
            occurredAt: run.startedAt.toISOString(),
            source: "run",
            level: "info",
            event: "run.started",
            state: "running",
            ...emptyMetadata,
          },
        ];
        entries.push(
          ...operations
            .slice(0, MAX_LOG_ENTRIES)
            .map(operationLogEntry)
            .filter(
              (entry): entry is PurchaseImportRunLogEntry => entry !== null,
            ),
        );
        if (run.endedAt) {
          entries.push({
            id: `run:${run.id}:ended`,
            occurredAt: run.endedAt.toISOString(),
            source: "run",
            level: run.status === "failed" ? "error" : "info",
            event: `run.${run.status}`,
            state: run.status,
            ...emptyMetadata,
            error: run.failureCode,
          });
        }
        entries.sort(
          (left, right) =>
            Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
            left.id.localeCompare(right.id),
        );
        return Response.json(
          purchaseImportRunLogResponse.parse({
            entries,
            truncated: operations.length > MAX_LOG_ENTRIES,
          }),
        );
      },
    },
  },
});
