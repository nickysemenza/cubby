import { describe, expect, it, vi } from "vitest";

import { streamSearchIndexRepairWorkflow } from "./search-index-repair-workflow-adapter";

type SearchIndexRepairWorkflowInstance = Parameters<
  typeof streamSearchIndexRepairWorkflow
>[0];
type SearchIndexRepairWorkflowSubscription = Awaited<
  ReturnType<SearchIndexRepairWorkflowInstance["subscribe"]>
>;

type SubscriptionResult = Awaited<
  ReturnType<SearchIndexRepairWorkflowSubscription["next"]>
>;

const counters = {
  scanned: 2,
  orphaned: 1,
  missing: 0,
  stale: 0,
  retired: 1,
  rebuilt: 0,
  published: 0,
};

const subscriptionFor = (
  events: Array<{ type: string; stepName?: string; output?: unknown }>,
  dispose = vi.fn(),
): SearchIndexRepairWorkflowSubscription & { dispose: typeof dispose } => {
  let index = 0;
  return {
    next: vi.fn(async () => {
      const value = events[index++];
      return value
        ? { done: false as const, value }
        : { done: true as const, value: undefined };
    }),
    [Symbol.dispose]: dispose,
    dispose,
  };
};

const instanceFor = (
  subscription: SearchIndexRepairWorkflowSubscription,
): SearchIndexRepairWorkflowInstance & {
  subscribe: ReturnType<typeof vi.fn>;
} => ({
  subscribe: vi.fn(async () => subscription),
});

describe("search index repair Workflow event adapter", () => {
  it("translates known progress steps and emits one validated completion", async () => {
    const subscription = subscriptionFor([
      {
        type: "step_completed",
        stepName: "search-index-repair.orphans.select.0-1",
        output: {},
      },
      {
        type: "step_completed",
        stepName: "search-index-repair.orphans.progress.0-1",
        output: {
          type: "progress",
          phase: "orphans",
          done: 2,
          total: 2,
          counters,
        },
      },
      { type: "workflow_completed", output: counters },
    ]);
    const instance = instanceFor(subscription);

    const result = [];
    for await (const event of streamSearchIndexRepairWorkflow(
      instance,
      new AbortController().signal,
    )) {
      result.push(event);
    }

    expect(result).toEqual([
      { type: "progress", phase: "orphans", done: 2, total: 2, counters },
      { type: "done", result: counters },
    ]);
    expect(instance.subscribe).toHaveBeenCalledWith({
      filter: [
        "step_completed",
        "workflow_completed",
        "workflow_errored",
        "workflow_terminated",
      ],
    });
    expect(subscription.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ["workflow_errored", "Search index repair workflow failed"],
    ["workflow_terminated", "Search index repair workflow was terminated"],
  ])("surfaces %s as a stream error", async (type, message) => {
    const subscription = subscriptionFor([{ type }]);
    const iterator = streamSearchIndexRepairWorkflow(
      instanceFor(subscription),
      new AbortController().signal,
    );

    await expect(iterator.next()).rejects.toThrow(message);
    expect(subscription.dispose).toHaveBeenCalledOnce();
  });

  it("rejects malformed completion and unexpected EOF", async () => {
    const malformed = streamSearchIndexRepairWorkflow(
      instanceFor(
        subscriptionFor([{ type: "workflow_completed", output: {} }]),
      ),
      new AbortController().signal,
    );
    await expect(malformed.next()).rejects.toThrow(
      "Malformed search index repair completion output",
    );

    const eof = streamSearchIndexRepairWorkflow(
      instanceFor(subscriptionFor([])),
      new AbortController().signal,
    );
    await expect(eof.next()).rejects.toThrow(
      "Search index repair ended unexpectedly",
    );
  });

  it("disposes when abort races subscription acquisition or next", async () => {
    let resolveSubscribe!: (
      subscription: SearchIndexRepairWorkflowSubscription,
    ) => void;
    const subscribePromise = new Promise<SearchIndexRepairWorkflowSubscription>(
      (resolve) => {
        resolveSubscribe = resolve;
      },
    );
    const lateDispose = vi.fn();
    const instance: SearchIndexRepairWorkflowInstance = {
      subscribe: vi.fn(() => subscribePromise),
    };
    const controller = new AbortController();
    const pendingSubscribe = streamSearchIndexRepairWorkflow(
      instance,
      controller.signal,
    ).next();
    controller.abort();
    resolveSubscribe(subscriptionFor([], lateDispose));
    await expect(pendingSubscribe).rejects.toThrow(
      "The operation was cancelled",
    );
    await vi.waitFor(() => expect(lateDispose).toHaveBeenCalledOnce());

    const nextDispose = vi.fn();
    let resolveNext!: (result: SubscriptionResult) => void;
    const nextPromise = new Promise<SubscriptionResult>((resolve) => {
      resolveNext = resolve;
    });
    const nextSubscription: SearchIndexRepairWorkflowSubscription & {
      dispose: typeof nextDispose;
    } = {
      next: vi.fn(() => nextPromise),
      [Symbol.dispose]: nextDispose,
      dispose: nextDispose,
    };
    const nextController = new AbortController();
    const pendingNext = streamSearchIndexRepairWorkflow(
      instanceFor(nextSubscription),
      nextController.signal,
    ).next();
    nextController.abort();
    resolveNext({ done: true, value: undefined });
    await expect(pendingNext).rejects.toThrow("The operation was cancelled");
    expect(nextDispose).toHaveBeenCalledOnce();
  });
});
