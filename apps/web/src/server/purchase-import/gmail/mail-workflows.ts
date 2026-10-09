import {
  BOOKKEEPING_RETRIES,
  PROVIDER_RETRIES,
  type DurableSteps,
} from "~/server/workflow-runs/step";

/*
 * The step sequence of the Gmail Workflow. Step names derive only from
 * saved state — a page number from the frozen discovery manifest, a wait
 * counter — so an execution that resumes in a new isolate or after a deploy
 * replays the same names and reuses their saved results. Each step's work
 * re-checks that its Run is still running under this attempt, so a cancel or
 * retry stops it without a failure.
 */

const MAIL_DISCOVERY_PAGES_PER_PASS = 12;
export interface MailDiscoveryWork {
  begin(): Promise<{ kind: "stopped" } | { kind: "page"; index: number }>;
  list(
    index: number,
  ): Promise<{ kind: "stopped" } | { kind: "listed"; more: boolean }>;
  batch(index: number): Promise<{ kind: "stopped" } | { kind: "done" }>;
  finish(): Promise<{ kind: "stopped" } | { kind: "done" }>;
  continue(): Promise<void>;
  fail(stepError: string): Promise<null>;
}

export async function runMailDiscovery(
  steps: DurableSteps,
  work: MailDiscoveryWork,
): Promise<void> {
  try {
    const start = await steps.do("begin", BOOKKEEPING_RETRIES, () =>
      work.begin(),
    );
    if (start.kind === "stopped") return;
    for (
      let index = start.index;
      index < start.index + MAIL_DISCOVERY_PAGES_PER_PASS;
      index += 1
    ) {
      const current = index;
      const listed = await steps.do(
        `page.${current}.list`,
        PROVIDER_RETRIES,
        () => work.list(current),
      );
      if (listed.kind === "stopped") return;
      const saved = await steps.do(
        `page.${current}.save`,
        PROVIDER_RETRIES,
        () => work.batch(current),
      );
      if (saved.kind === "stopped") return;
      if (!listed.more) break;
    }
    const finished = await steps.do("finish", BOOKKEEPING_RETRIES, () =>
      work.finish(),
    );
    if (finished.kind === "done")
      await steps.do("continue", BOOKKEEPING_RETRIES, () => work.continue());
  } catch (error) {
    const stepError = error instanceof Error ? error.message : String(error);
    await steps.do("fail", BOOKKEEPING_RETRIES, () => work.fail(stepError));
    throw error;
  }
}
