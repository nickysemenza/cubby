import type { UnparsedError } from "~/lib/error-utils";
import {
  getMailDiscoveryWorkflow,
  getVendorMailSearchWorkflow,
} from "~/server/cf-env";

import type { WorkflowRunParams, WorkflowRunPurpose } from "./contract";

/** The instance states Cloudflare reports, plus `missing` once retention ends. */
export type WorkflowInstanceState =
  | "queued"
  | "running"
  | "paused"
  | "errored"
  | "terminated"
  | "complete"
  | "waiting"
  | "waitingForPause"
  | "rollingBack"
  | "unknown"
  | "missing";

export type WorkflowInstanceStatus = {
  state: WorkflowInstanceState;
  error: string | null;
};

/** States in which the instance will not run another step. */
export const ENDED_INSTANCE_STATES: ReadonlySet<WorkflowInstanceState> =
  new Set(["errored", "terminated", "complete", "missing"]);

/**
 * The seam between Run bookkeeping and Cloudflare's Workflow bindings.
 * Integration tests inject a recording fake; the Worker uses the bindings.
 */
export interface WorkflowLauncher {
  create(
    purpose: WorkflowRunPurpose,
    id: string,
    params: WorkflowRunParams,
  ): Promise<void>;
  /** Stops a live instance; an ended or expired one is left alone. */
  terminate(purpose: WorkflowRunPurpose, id: string): Promise<void>;
  status(
    purpose: WorkflowRunPurpose,
    id: string,
  ): Promise<WorkflowInstanceStatus>;
}

/**
 * Instance state is diagnostics only — the Run row is the record — so a
 * failed attempt stays inspectable for a month and a success for a week.
 */
const RETENTION = {
  successRetention: "7 days",
  errorRetention: "30 days",
} as const;

const bindingFor = (purpose: WorkflowRunPurpose) => {
  const binding =
    purpose === "mail_search"
      ? getVendorMailSearchWorkflow()
      : getMailDiscoveryWorkflow();
  if (!binding)
    throw new Error(`The ${purpose} Workflow binding is not configured`);
  return binding;
};

const notFound = (error: UnparsedError) =>
  error instanceof Error && /not.?found/iu.test(error.message);

export const productionWorkflowLauncher: WorkflowLauncher = {
  async create(purpose, id, params) {
    await bindingFor(purpose).create({ id, params, retention: RETENTION });
  },
  async terminate(purpose, id) {
    try {
      const instance = await bindingFor(purpose).get(id);
      const { status } = await instance.status();
      if (["errored", "terminated", "complete"].includes(status)) return;
      await instance.terminate();
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  },
  async status(purpose, id) {
    try {
      const status = await (await bindingFor(purpose).get(id)).status();
      return { state: status.status, error: status.error?.message ?? null };
    } catch (error) {
      if (notFound(error)) return { state: "missing", error: null };
      throw error;
    }
  },
};
