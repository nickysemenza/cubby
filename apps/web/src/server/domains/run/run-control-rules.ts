/**
 * The status and purpose rules `run.control` applies before it pauses,
 * resumes, retries or restarts a Run. The control paths throw the refusal;
 * the Run read reports the same refusals as `actionReasons`, so a row offers
 * a verb exactly when its control would accept it on these grounds. Control
 * still rechecks ownership and the work a retry or restart would carry.
 */
import { agentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import { isExecutedRunPurpose } from "@cubby/schemas/run-fields";

/** The row verbs whose availability a Run read reports. */
type RunRowVerb = "pause" | "resume" | "retry" | "restart";

type RunControlRow = {
  purpose: string;
  status: string;
  failureCode: string | null;
  /** A live retry or restart successor names this Run. */
  hasSuccessor: boolean;
};

/**
 * A funding-paused import an older coordinator stopped for review while its
 * targets were still pending. It is waiting for AI funding, not for review:
 * resume and the funding window both continue it. Retry and restart leave the
 * predecessor in `needs_review` with its `execution_limit` code, but its
 * unresolved targets then belong to the successor, so a predecessor with any
 * successor is never funding-resumable.
 */
export const isFundingStoppedForReview = (row: RunControlRow) =>
  row.status === "needs_review" &&
  row.failureCode === "execution_limit" &&
  !row.hasSuccessor;

const AGENT_FINISHED = new Set([
  "completed",
  "failed",
  "needs_review",
  "dispatch_failed",
]);
const AGENT_RETRYABLE = new Set(["needs_review", "completed", "failed"]);
const AGENT_RESUMABLE = new Set(["paused", "paused_auth", "paused_offline"]);

/** Why `run.control` refuses `verb` on this Run, or null when it proceeds. */
export function runControlRefusal(
  verb: RunRowVerb,
  row: RunControlRow,
): string | null {
  if (row.purpose === "mail_search")
    return "Historical vendor-search Runs cannot execute again; start current research instead.";
  // A Workflow executes these Runs; its control acts on the Job.
  if (isExecutedRunPurpose(row.purpose))
    switch (verb) {
      case "pause":
        return (row.purpose === "mail_reclassify" || row.purpose === "sweep") &&
          row.status === "running"
          ? null
          : "Only running member-requested AI work can be paused";
      case "resume":
        return row.status === "paused" || row.status === "paused_auth"
          ? null
          : "Only paused AI work can be resumed";
      case "retry":
        return row.status === "failed"
          ? null
          : `Only a failed Run can be retried (${row.status})`;
      case "restart":
        return `A ${row.purpose} Run supports cancel and retry only`;
    }
  const coordinated = agentImportRunPurpose.safeParse(row.purpose).success;
  switch (verb) {
    case "pause":
      return row.status === "running"
        ? null
        : `Purchase import run is fenced in ${row.status}`;
    case "resume":
      return AGENT_RESUMABLE.has(row.status) || isFundingStoppedForReview(row)
        ? null
        : `Purchase import run is fenced in ${row.status}`;
    case "retry":
      if (!AGENT_RETRYABLE.has(row.status))
        return `Purchase import run is not terminal in ${row.status}`;
      // A retried Run answers with its existing successor.
      return coordinated || row.hasSuccessor
        ? null
        : "Only agent import runs can be retried";
    case "restart":
      if (!AGENT_FINISHED.has(row.status))
        return `Only a finished run can be started again (${row.status})`;
      return coordinated ? null : "Only agent import runs can be started again";
  }
}

/** Every row verb's refusal, keyed by verb: the Run read's `actionReasons`. */
export const runActionReasons = (row: RunControlRow) => ({
  pause: runControlRefusal("pause", row),
  resume: runControlRefusal("resume", row),
  retry: runControlRefusal("retry", row),
  restart: runControlRefusal("restart", row),
});
