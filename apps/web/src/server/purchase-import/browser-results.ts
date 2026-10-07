import {
  browserBridgeRequest,
  browserBridgeResult,
  browserObservation,
  browserPageCapture,
  type BrowserBridgeResult,
  type BrowserObservation,
} from "@cubby/schemas/purchase-import";
import { z } from "zod";

import { env } from "~/env";
import type { Database } from "~/server/db";
import { runEvidence } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  setOperationResult,
  type OperationKey,
} from "~/server/repo/run-operation";
import { uploadToS3 } from "~/server/utils/s3";

import { derivePageCapture, readSnapshotDom } from "./browser-page";

/** Where a captured page's DOM is kept, so the server can read it again. */
export interface BrowserEvidenceStorage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

export const productionBrowserEvidenceStorage: BrowserEvidenceStorage = {
  put: (key, bytes, contentType) =>
    uploadToS3({ key, body: Buffer.from(bytes), contentType }),
};

/** A capture as the server read it, cached on its command's operation row. */
export const materializedPage = z.object({
  capture: browserPageCapture,
  domEvidenceId: z.uuid(),
  observation: browserObservation,
});
export type MaterializedPage = z.infer<typeof materializedPage>;

/** A browser command's operation row: the command, its id, and later facts. */
export const browserCommandRecord = z.looseObject({
  commandId: z.uuid(),
  command: browserBridgeRequest,
  page: materializedPage.optional(),
  /** Operation ids of the server's automatic retries, oldest first. */
  retries: z.array(z.string()).optional(),
  /** A public page the server read itself; the Mac never saw this step. */
  serverResult: browserBridgeResult.optional(),
  /** The attempt the run paused on; reading it again after resume retries. */
  pausedAt: z.string().optional(),
});
export type BrowserCommandRecord = z.infer<typeof browserCommandRecord>;

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
  if (input.record.page) return input.record.page;
  const outcome = input.result.outcome;
  if (outcome.status !== "completed" || !outcome.snapshot)
    throw new Error("Browser command produced no page snapshot");
  const snapshot = outcome.snapshot;
  const html = await readSnapshotDom(snapshot.dom);
  const operation = input.record.command.operation;
  const targetId =
    operation.type === "capture"
      ? (operation.evidenceScope?.targetId ?? null)
      : null;
  const evidenceId = crypto.randomUUID();
  const objectKey = `${env.R2_KEY_PREFIX}/import-runs/${input.runShortcode}/${targetId ?? "pages"}/${evidenceId}-page.html`;
  const bytes = new TextEncoder().encode(html);
  await input.storage.put(objectKey, bytes, "text/html; charset=utf-8");
  const capture = derivePageCapture({
    html,
    sourceURL: snapshot.sourceURL,
    title: snapshot.title,
    capturedAt: snapshot.capturedAt,
    allowedHosts: input.allowedHosts,
    requestedURL:
      operation.type === "capture" ? (operation.recoveryURL ?? null) : null,
    evidence:
      snapshot.screenshot.status === "captured"
        ? snapshot.screenshot.evidence
        : [],
  });
  await getDb(db)
    .insert(runEvidence)
    .values({
      id: evidenceId,
      runId: input.key.runId,
      targetId,
      kind: "browser_capture",
      objectKey,
      checksum: snapshot.dom.sha256,
      mediaType: "text/html",
      byteSize: bytes.byteLength,
      sourceMetadata: {
        sourceURL: snapshot.sourceURL,
        derivationRevision: capture.captureVersion,
        truncated: snapshot.dom.truncated,
      },
    });
  const page = materializedPage.parse({
    capture,
    domEvidenceId: evidenceId,
    observation: outcome.observation,
  });
  await setOperationResult(getDb(db), input.key, {
    ...input.record,
    page,
  });
  return page;
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
export const MAX_BROWSER_RETRIES = 1;

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
