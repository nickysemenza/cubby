import {
  browserBridgeRequest,
  browserBridgeResult,
  browserObservation,
  browserPageCapture,
  type BrowserBridgeResult,
  type BrowserObservation,
} from "@cubby/schemas/purchase-import";
import { retainedResearchObservation } from "@cubby/schemas/research";
import {
  MAX_EXTERNAL_HTML_BYTES,
  readResponseWithLimit,
} from "@cubby/shared/external-fetch";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import {
  readOperation,
  setOperationResult,
  type OperationKey,
} from "~/server/repo/run-operation";
import { getS3Object, uploadToS3 } from "~/server/utils/s3";

import { derivePageCapture, readSnapshotDom } from "./browser-page";
import { retainResearchObservation } from "./research-observations";

/** Where a captured page's DOM is kept, so the server can read it again. */
export interface BrowserEvidenceStorage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get?(key: string): Promise<string>;
}

export const productionBrowserEvidenceStorage: BrowserEvidenceStorage &
  Required<Pick<BrowserEvidenceStorage, "get">> = {
  put: (key, bytes, contentType) =>
    uploadToS3({ key, body: Buffer.from(bytes), contentType }),
  get: async (key) => {
    const response = await getS3Object(key);
    const bytes = await readResponseWithLimit(
      response,
      MAX_EXTERNAL_HTML_BYTES,
    );
    const content = new TextDecoder().decode(bytes);
    if (!response.ok)
      throw new Error(
        `Retained evidence storage HTTP ${response.status}: ${content}`,
      );
    return content;
  },
};

/** A capture as the server read it, cached on its command's operation row. */
const materializedPage = z.object({
  capture: browserPageCapture,
  domEvidenceId: z.uuid(),
  observation: browserObservation,
  research: retainedResearchObservation,
});
export type MaterializedPage = z.infer<typeof materializedPage>;

/** A browser command's operation row: the command, its id, and later facts. */
export const browserCommandRecord = z.looseObject({
  commandId: z.uuid(),
  command: browserBridgeRequest,
  /** The exact source task authorized when this command was issued. */
  workRef: z.uuid(),
  /** The owned account supplying transport; it need not be the task Vendor. */
  brokerAccountId: z.uuid().optional(),
  /** Receipt in the durable agent transcript, separate from source upload. */
  observationDelivered: z.boolean().optional(),
  /** Automatic read reconciliation is bounded; member resume remains explicit. */
  recoveryDepth: z.number().int().nonnegative().optional(),
  page: materializedPage.optional(),
  /** Operation ids of the server's automatic retries, oldest first. */
  retries: z.array(z.string()).optional(),
  /** Retained broker outcome, including terminal failures replayed by the host. */
  serverResult: browserBridgeResult.optional(),
  /** The attempt the run paused on; reading it again after resume retries. */
  pausedAt: z.string().optional(),
});
export type BrowserCommandRecord = z.infer<typeof browserCommandRecord>;

function assertRecordedCommand(
  current: BrowserCommandRecord,
  supplied: BrowserCommandRecord,
) {
  if (
    current.commandId !== supplied.commandId ||
    current.workRef !== supplied.workRef ||
    current.brokerAccountId !== supplied.brokerAccountId ||
    JSON.stringify(current.command) !== JSON.stringify(supplied.command)
  )
    throw new Error(
      "Browser snapshot authority does not match its stored command.",
    );
}

/**
 * Read a completed capture once: decode the Mac's DOM, keep it as run
 * evidence, derive the page, and cache that on the command's operation row.
 * Later reads (the agent, the importer) reuse the cached page.
 */
export async function materializeCapture(
  db: Database,
  input: {
    key: OperationKey;
    runShortcode: string;
    record: BrowserCommandRecord;
    result: BrowserBridgeResult;
    allowedHosts: readonly string[];
    storage: BrowserEvidenceStorage;
  },
): Promise<MaterializedPage> {
  const record = browserCommandRecord.parse(input.record);
  const result = browserBridgeResult.parse(input.result);
  if (
    record.commandId !== record.command.id ||
    record.command.runID !== input.key.runId ||
    record.command.operationId !== input.key.operationId ||
    result.commandID !== record.commandId ||
    result.operationID !== input.key.operationId ||
    result.runID !== input.key.runId
  )
    throw new Error("Browser result does not belong to this command and run");
  const persisted = browserCommandRecord.parse(
    (await readOperation(getDb(db), input.key))?.result,
  );
  assertRecordedCommand(persisted, record);
  const outcome = result.outcome;
  if (outcome.status !== "completed" || !outcome.snapshot)
    throw new Error("Browser command produced no page snapshot");
  const snapshot = outcome.snapshot;
  const html = await readSnapshotDom(snapshot.dom);
  const operation = record.command.operation;
  const research = await retainResearchObservation(
    db,
    {
      runId: input.key.runId,
      workRef: record.workRef,
      callId: record.commandId,
      kind: "browser_capture",
      sourceMetadata: {
        brokerAccountId: record.brokerAccountId,
        sourceURL: snapshot.sourceURL,
        servedURL: snapshot.servedURL,
        title: snapshot.title,
        capturedAt: snapshot.capturedAt,
        truncated: snapshot.dom.truncated,
        observationId: snapshot.observationId,
        actions: snapshot.actions,
        actionsTruncated: snapshot.actionsTruncated,
        screenshots:
          snapshot.screenshot.status === "captured"
            ? snapshot.screenshot.evidence
            : [],
      },
      content: html,
    },
    { storage: input.storage },
  );
  const capture = derivePageCapture({
    html,
    sourceURL: snapshot.servedURL,
    title: snapshot.title,
    capturedAt: snapshot.capturedAt,
    allowedHosts: input.allowedHosts,
    requestedURL:
      operation.type === "read"
        ? (operation.recoveryURL ?? null)
        : operation.type === "navigate"
          ? operation.url
          : null,
    evidence:
      snapshot.screenshot.status === "captured"
        ? snapshot.screenshot.evidence
        : [],
    truncated: snapshot.dom.truncated,
  });
  const page = materializedPage.parse({
    capture,
    domEvidenceId: research.evidenceId,
    observation: outcome.observation,
    research,
  });
  return withTransaction(db, async (tx) => {
    const current = browserCommandRecord.parse(
      (await readOperation(tx, input.key, { forUpdate: true }))?.result,
    );
    assertRecordedCommand(current, record);
    // Duplicate materializers preserve the durable receipt and the first cached page.
    if (current.page) return current.page;
    await setOperationResult(tx, input.key, { ...current, page });
    return page;
  });
}

type FailedOutcome = Extract<
  BrowserBridgeResult["outcome"],
  { status: "failed" }
>;

/**
 * What the server does about a failed browser command. The Mac reports what
 * it saw; this table decides. A retry is a fresh command (optionally after
 * raising the window), so a reconnecting Mac never has to replay a finished
 * one. A pause names a condition only the member can fix.
 */
export type BrowserRecovery =
  | { action: "retry"; raiseWindow: boolean }
  | {
      action: "pause";
      status: "paused_offline" | "paused_auth";
      reason: string;
    }
  | { action: "stop_outdated_client" }
  | { action: "fail" };

/** Automatic retries a single browser step gets before it pauses. */
const MAX_BROWSER_RETRIES = 1;

const SCREEN_RECORDING_FIX =
  "Allow Cubby to record the screen (System Settings > Privacy & Security > Screen & System Audio Recording), then reopen Cubby.";
const memberFix = {
  javascript_disabled:
    "In Chrome, turn on View > Developer > Allow JavaScript from Apple Events.",
  browser_permission_denied:
    "Allow Cubby to control the browser (System Settings > Privacy & Security > Automation).",
} satisfies Partial<Record<FailedOutcome["code"], string>>;

export function browserRecovery(
  outcome: FailedOutcome,
  retriesSoFar: number,
): BrowserRecovery {
  if (outcome.code === "client_update_required")
    return { action: "stop_outdated_client" };
  if (outcome.screenshotGap === "screen_recording_denied")
    return {
      action: "pause",
      status: "paused_offline",
      reason: SCREEN_RECORDING_FIX,
    };
  const fix =
    outcome.code === "javascript_disabled" ||
    outcome.code === "browser_permission_denied"
      ? memberFix[outcome.code]
      : null;
  if (fix) return { action: "pause", status: "paused_offline", reason: fix };
  const canRetry = retriesSoFar < MAX_BROWSER_RETRIES;
  if (outcome.code === "screenshot_unavailable")
    return canRetry
      ? {
          action: "retry",
          raiseWindow:
            outcome.screenshotGap === "window_minimized" ||
            outcome.screenshotGap === "window_off_screen",
        }
      : {
          action: "pause",
          status: "paused_offline",
          reason: `Cubby could not take a screenshot of its browser window (${outcome.screenshotGap ?? "unknown"}). Bring the window forward, then resume the run.`,
        };
  if (outcome.code === "page_unreadable" || outcome.code === "upload_failed")
    return canRetry
      ? { action: "retry", raiseWindow: false }
      : {
          action: "pause",
          status: "paused_offline",
          reason: outcome.message,
        };
  if (
    outcome.retryable ||
    outcome.code === "deadline_exceeded" ||
    outcome.code === "browser_unavailable"
  )
    return {
      action: "pause",
      status: "paused_offline",
      reason: outcome.message,
    };
  return { action: "fail" };
}

/** A short, human line for what the Mac saw, for logs and the Runs UI. */
export function describeObservation(observation: BrowserObservation): string {
  const where = observation.url ? new URL(observation.url).host : "no page";
  const window = observation.window;
  const windowState = !window
    ? "window not found"
    : window.minimized
      ? "window minimized"
      : window.onScreen === false
        ? "window off screen"
        : window.recovered
          ? "window recovered"
          : "window ready";
  return [where, observation.readyState ?? "unknown", windowState].join(" · ");
}
