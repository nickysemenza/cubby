import {
  searchIndexRepairCountersSchema,
  searchIndexRepairEventSchema,
  type SearchIndexRepairEvent,
} from "@cubby/schemas/maintenance";

// Workflows retain repeated step names with an execution suffix (`-1` for the
// first run, then a higher count after a restart). Subscription events expose
// that retained name, so match the logical page plus Cloudflare's suffix.
const REPAIR_STEP =
  /^search-index-repair\.(orphans|sources)\.progress\.\d+-\d+$/;

type SearchIndexRepairWorkflowEvent = {
  readonly type: string;
  readonly stepName?: string;
  readonly output?: unknown;
  readonly error?: { readonly name: string; readonly message: string };
};

interface SearchIndexRepairWorkflowSubscription {
  next(): Promise<IteratorResult<SearchIndexRepairWorkflowEvent, void>>;
  [Symbol.dispose](): void;
}

interface SearchIndexRepairWorkflowInstance {
  subscribe(options: {
    filter: SearchIndexRepairWorkflowEventType[];
  }): Promise<SearchIndexRepairWorkflowSubscription>;
}

const SEARCH_INDEX_REPAIR_EVENT_FILTER = [
  "step_completed",
  "workflow_completed",
  "workflow_errored",
  "workflow_terminated",
] as const;
type SearchIndexRepairWorkflowEventType =
  (typeof SEARCH_INDEX_REPAIR_EVENT_FILTER)[number];

const abortError = () =>
  new DOMException("The operation was cancelled", "AbortError");

const disposeSubscription = (
  subscription: SearchIndexRepairWorkflowSubscription,
): void => subscription[Symbol.dispose]();

const raceAbort = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
};

const progressFromStep = (
  event: SearchIndexRepairWorkflowEvent,
): SearchIndexRepairEvent | undefined => {
  if (event.type !== "step_completed" || !event.stepName) return undefined;
  const match = REPAIR_STEP.exec(event.stepName);
  if (!match) return undefined;
  const parsed = searchIndexRepairEventSchema.safeParse(event.output);
  if (!parsed.success || parsed.data.type !== "progress") {
    throw new Error(`Malformed output for ${event.stepName}`);
  }
  if (parsed.data.phase !== match[1]) {
    throw new Error(`Unexpected phase output for ${event.stepName}`);
  }
  return parsed.data;
};

/**
 * Consume one retained+live Workflow instance as the existing repair stream.
 * This is deliberately a port-based adapter: no Cloudflare runtime object is
 * imported here, so the important failure and disposal paths stay unit-testable.
 */
export async function* streamSearchIndexRepairWorkflow(
  instance: SearchIndexRepairWorkflowInstance,
  signal: AbortSignal,
): AsyncGenerator<SearchIndexRepairEvent, void> {
  let subscription: SearchIndexRepairWorkflowSubscription | undefined;
  const subscriptionPromise = instance.subscribe({
    filter: [...SEARCH_INDEX_REPAIR_EVENT_FILTER],
  });
  try {
    try {
      subscription = await raceAbort(subscriptionPromise, signal);
    } catch (error) {
      // If abort wins the subscribe race, the RPC can still resolve later. It
      // owns a resource then, so dispose it as soon as it becomes available.
      void subscriptionPromise.then(disposeSubscription, () => undefined);
      throw error;
    }

    let completed = false;
    while (true) {
      const result = await raceAbort(subscription.next(), signal);
      if (result.done) {
        if (!completed)
          throw new Error("Search index repair ended unexpectedly");
        return;
      }
      const event = result.value;
      const progress = progressFromStep(event);
      if (progress) {
        yield progress;
        continue;
      }
      if (event.type === "workflow_completed") {
        if (completed) throw new Error("Search index repair completed twice");
        const result = searchIndexRepairCountersSchema.safeParse(event.output);
        if (!result.success) {
          throw new Error("Malformed search index repair completion output");
        }
        completed = true;
        yield { type: "done", result: result.data };
        continue;
      }
      if (event.type === "workflow_errored") {
        throw new Error(
          `Search index repair workflow failed: ${event.error?.message ?? "unknown error"}`,
        );
      }
      if (event.type === "workflow_terminated") {
        throw new Error("Search index repair workflow was terminated");
      }
      // Selection, mutation, and publication step outputs are intentionally
      // retained by the Workflow but are not UI progress frames.
      if (event.type === "step_completed") continue;
      throw new Error(`Unexpected search index repair event: ${event.type}`);
    }
  } finally {
    if (subscription) disposeSubscription(subscription);
  }
}
