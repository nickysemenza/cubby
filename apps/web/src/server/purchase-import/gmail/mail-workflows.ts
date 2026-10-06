import {
  BOOKKEEPING_RETRIES,
  PROVIDER_RETRIES,
  type DurableSteps,
} from "~/server/workflow-runs/step";

import type { VendorMailPageResult } from "./search-job";

/*
 * The step sequences of the two Gmail Workflows. Step names derive only from
 * saved state — a page number from the Run, a batch index from the frozen
 * discovery manifest, a wait counter — so an execution that resumes in a new
 * isolate or after a deploy replays the same names and reuses their saved
 * results. Each step's work re-checks that its Run is still running under
 * this attempt, so a cancel or retry stops it without a failure.
 */

/** Consecutive AI Gateway rate limits on one page before the search fails. */
export const MAX_RATE_LIMIT_WAITS = 12;

export interface VendorMailSearchWork {
  begin(): Promise<{ kind: "stopped" } | { kind: "page"; page: number }>;
  scanPage(page: number): Promise<VendorMailPageResult>;
  fail(stepError: string): Promise<null>;
}

export async function runVendorMailSearch(
  steps: DurableSteps,
  work: VendorMailSearchWork,
): Promise<void> {
  try {
    const start = await steps.do("begin", BOOKKEEPING_RETRIES, () =>
      work.begin(),
    );
    if (start.kind === "stopped") return;
    let page = start.page;
    for (;;) {
      let result: VendorMailPageResult;
      for (let wait = 0; ; wait += 1) {
        const current = page;
        result = await steps.do(
          `page.${current}.scan.${wait}`,
          PROVIDER_RETRIES,
          () => work.scanPage(current),
        );
        if (result.kind !== "rate_limited") break;
        if (wait + 1 >= MAX_RATE_LIMIT_WAITS)
          throw new Error(
            `AI Gateway rate limited Gmail page ${page + 1} ${MAX_RATE_LIMIT_WAITS} times in a row`,
          );
        await steps.sleep(`page.${page}.wait.${wait}`, result.retryAfterMs);
      }
      if (result.kind !== "more") return;
      page = result.nextPage;
    }
  } catch (error) {
    const stepError = error instanceof Error ? error.message : String(error);
    await steps.do("fail", BOOKKEEPING_RETRIES, () => work.fail(stepError));
    throw error;
  }
}

export interface MailDiscoveryWork {
  /** Freeze the pass's messages and history events on the Run. */
  list(): Promise<{ kind: "stopped" } | { kind: "listed"; batches: number }>;
  batch(index: number): Promise<{ kind: "stopped" } | { kind: "done" }>;
  /** Save history events, advance the cursor, and complete the Run. */
  finish(): Promise<{ kind: "stopped" } | { kind: "done" }>;
  fail(stepError: string): Promise<null>;
}

export async function runMailDiscovery(
  steps: DurableSteps,
  work: MailDiscoveryWork,
): Promise<void> {
  try {
    const listed = await steps.do("list", PROVIDER_RETRIES, () => work.list());
    if (listed.kind === "stopped") return;
    for (let index = 0; index < listed.batches; index += 1) {
      const current = index;
      const saved = await steps.do(`batch.${current}`, PROVIDER_RETRIES, () =>
        work.batch(current),
      );
      if (saved.kind === "stopped") return;
    }
    await steps.do("finish", BOOKKEEPING_RETRIES, () => work.finish());
  } catch (error) {
    const stepError = error instanceof Error ? error.message : String(error);
    await steps.do("fail", BOOKKEEPING_RETRIES, () => work.fail(stepError));
    throw error;
  }
}
