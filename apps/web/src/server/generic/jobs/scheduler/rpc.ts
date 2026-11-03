import type { JobShortcode } from "@cubby/schemas/identifiers";
import type { SchedulerSnapshot } from "@cubby/schemas/job-scheduler";

export interface JobSchedulerRpc {
  snapshot(): Promise<SchedulerSnapshot>;
  reconcile(cause: string, job?: JobShortcode): Promise<string | null>;
  wake(cause: string): Promise<void>;
  recovered(cause: string, error: string | null): Promise<void>;
  claimBootstrap(version: string): Promise<string | null>;
  finishBootstrap(
    version: string,
    token: string,
    error: string | null,
  ): Promise<void>;
  admitDaily(date: string): Promise<string | null>;
  finishDaily(date: string, token: string, error: string | null): Promise<void>;
}
