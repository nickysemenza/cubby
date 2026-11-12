import type { LedgerPartyId, RunId } from "@cubby/schemas/identifiers";
import {
  agentImportRunPurpose,
  type AgentImportRunPurpose,
} from "@cubby/schemas/import-run-agent";
import type { AgentFailureCode } from "@cubby/schemas/purchase-agent-services";
import type { RunPurpose } from "@cubby/schemas/run-fields";

import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import type { run } from "~/server/db/schema";

type RunInput = (typeof run.$inferSelect)["input"];

/**
 * One row of a Run's roster: what its detail shows, what a restart copies
 * and, while `state` is unresolved, what a retry carries.
 */
export type RunTargetRow = {
  readonly id: string;
  readonly entityKind: "image" | "purchase" | "product" | "run" | "email";
  readonly entityId: string;
  readonly entityCode: string | null;
  readonly workKey: string;
  readonly position: number | null;
  readonly vendorAccountId: string | null;
  readonly vendorAccountCode: string | null;
  readonly vendorAccountLabel: string | null;
  readonly sourceKind: string | null;
  readonly sourceExternalKey: string | null;
  readonly targetFingerprint: string;
  readonly state: string;
  readonly outcome: string | null;
  readonly warning: string | null;
  readonly diff: unknown;
  readonly completedAt: Date | null;
};

/**
 * What an agent-coordinated purpose does at each generic Run transition. The
 * owning domain implements it; generic control calls it inside the control
 * transaction after its own row writes.
 */
export type RunPurposeLifecycle = {
  readonly targets: (
    client: DrizzleClient | DrizzleTransaction,
    runId: RunId,
  ) => Promise<RunTargetRow[]>;
  /**
   * Moves work to a successor. `carried` is every target for a restart and
   * the unresolved ones for a retry.
   */
  readonly handOff: (
    tx: DrizzleTransaction,
    handoff: {
      from: RunId;
      to: RunId;
      carried: readonly RunTargetRow[];
      restart: boolean;
    },
  ) => Promise<void>;
  /** The retry successor's `Run.input`, narrowed to the carried targets. */
  readonly retryInput?: (
    input: RunInput,
    carried: readonly RunTargetRow[],
  ) => RunInput;
  /** The member cancelled a Run that still holds work. */
  readonly cancelled?: (
    tx: DrizzleTransaction,
    run: { runId: RunId; input: RunInput },
  ) => Promise<void>;
  /** The coordinator reported failure; runs in the failing transaction. */
  readonly failed?: (
    tx: DrizzleTransaction,
    run: {
      runId: RunId;
      ledgerPartyId: LedgerPartyId | null;
      failureCode: AgentFailureCode;
      detail: string | undefined;
    },
  ) => Promise<void>;
  /** The coordinator never started, so nothing else will release its work. */
  readonly dispatchFailed?: (
    tx: DrizzleTransaction,
    runId: RunId,
  ) => Promise<void>;
  /** Waits until the Run may admit its coordinator. */
  readonly beforeCoordinatorAdmission?: (
    db: Database,
    runId: RunId,
  ) => Promise<void>;
};

const lifecycles = {
  mail_import: async () =>
    (await import("~/server/domains/purchase-import/repo/mail-run-lifecycle"))
      .mailRunLifecycle,
  photo_inventory: async () =>
    (await import("~/server/domains/photo-import/repo/run/photo-run"))
      .photoRunLifecycle,
} satisfies Record<AgentImportRunPurpose, () => Promise<RunPurposeLifecycle>>;

/** The owning domain's lifecycle, or null for a purpose without a coordinator. */
/** Target states a retry carries to its successor. */
export const UNRESOLVED_TARGET_STATES: ReadonlySet<string> = new Set([
  "pending",
  "prepared",
  "unresolved",
  "needs_evidence",
  "unavailable",
]);

export async function runPurposeLifecycle(
  purpose: RunPurpose | string,
): Promise<RunPurposeLifecycle | null> {
  const agent = agentImportRunPurpose.safeParse(purpose);
  return agent.success ? lifecycles[agent.data]() : null;
}
