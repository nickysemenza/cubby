import { describe, expect, it } from "vitest";

import { workflow } from "./builder";
import {
  defineBulkWorkflow,
  executeBulkWorkflow,
  type BulkWorkflowSummary,
} from "./bulk";

type State = { writes: number[]; effects: number[]; finalized: number[][] };
const definition = defineBulkWorkflow({
  name: "bulk-test",
  items: workflow<State, number[]>("bulk-test.items").output(
    ({ input }) => input,
  ),
  item: workflow<State, number>("bulk-test.item")
    .call("validated", async (_, { input }) => {
      if (input < 0) throw new Error("Negative item");
      return input;
    })
    .commit("saved", async ({ context }, { validated }) => {
      context.writes.push(validated);
      return validated;
    })
    .effect("indexed", async ({ context }, { saved }) => {
      context.effects.push(saved);
    })
    .output(({ saved }) => saved),
  finalize: workflow<State, BulkWorkflowSummary<number, number>>(
    "bulk-test.finalize",
  )
    .call("summary", async ({ context }, { input }) => {
      context.finalized.push(input.succeeded.map(({ result }) => result));
      return { succeeded: input.succeeded.length, failed: input.failed.length };
    })
    .output(({ summary }) => summary),
  onItemError: "continue",
  progress: (result: number) => result,
});
const state = (): State => ({ writes: [], effects: [], finalized: [] });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

describe("bulk workflow execution", () => {
  it("bounds concurrent windows and finalizes every started item on early close", async () => {
    const context = state();
    const started: number[] = [];
    const bothStarted = deferred();
    const release = deferred();
    const stream = executeBulkWorkflow(
      {
        ...definition,
        concurrency: 2,
        item: workflow<State, number>("concurrent-item")
          .call("ready", async (_, { input }) => {
            started.push(input);
            if (started.length === 2) bothStarted.resolve();
            await release.promise;
            return input;
          })
          .commit("saved", async ({ context }, { ready }) => {
            context.writes.push(ready);
            return ready;
          })
          .output(({ saved }) => saved),
      },
      { context, input: [1, 2, 3] },
    );
    await stream.next();
    const firstTick = stream.next();
    await bothStarted.promise;
    expect(started).toEqual([1, 2]);
    expect(context.writes).toEqual([]);
    release.resolve();
    expect((await firstTick).value).toMatchObject({ done: 1, item: 1 });
    await stream.return();
    expect(started).toEqual([1, 2]);
    expect(context.writes).toEqual([1, 2]);
    expect(context.finalized).toEqual([[1, 2]]);
  });

  it("can preserve batch progress cadence while retaining bounded settlement", async () => {
    const context = state();
    const events = [];
    for await (const event of executeBulkWorkflow(
      { ...definition, concurrency: 10, progressCadence: "window" },
      { context, input: Array.from({ length: 12 }, (_, index) => index + 1) },
    ))
      events.push(event);
    expect(
      events.map((event) => event.type === "progress" && event.done),
    ).toEqual([0, 10, 12, false]);
    expect(context.writes).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );

    const closed = state();
    const stream = executeBulkWorkflow(
      { ...definition, concurrency: 10, progressCadence: "window" },
      {
        context: closed,
        input: Array.from({ length: 12 }, (_, index) => index + 1),
      },
    );
    await stream.next();
    await stream.next();
    await stream.return();
    expect(closed.writes).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 1),
    );
    expect(closed.finalized).toEqual([
      Array.from({ length: 10 }, (_, index) => index + 1),
    ]);
  });

  it("can omit the initial tick when a source only reports completed items", async () => {
    const stream = executeBulkWorkflow(
      { ...definition, initialProgress: false },
      { context: state(), input: [1, 2] },
    );
    expect((await stream.next()).value).toMatchObject({
      type: "progress",
      done: 1,
      total: 2,
      item: 1,
    });
  });

  it("settles concurrent committed work before propagating another item's failure", async () => {
    const context = state();
    const stream = executeBulkWorkflow(
      { ...definition, concurrency: 2, onItemError: "stop" },
      {
        context,
        input: [-1, 2, 3],
      },
    );
    await stream.next();
    await expect(stream.next()).rejects.toThrow("Negative item");
    expect(context).toEqual({ writes: [2], effects: [2], finalized: [[2]] });
  });

  it("emits fallback events in input order for failed items in a window", async () => {
    const events = [];
    for await (const event of executeBulkWorkflow(
      {
        ...definition,
        concurrency: 2,
        errorProgress: (_error, item) => item * 10,
      },
      { context: state(), input: [-1, 2] },
    ))
      events.push(event);
    expect(events).toEqual([
      { type: "progress", done: 0, total: 2 },
      { type: "progress", done: 1, total: 2, item: -10 },
      { type: "progress", done: 2, total: 2, item: 2 },
      { type: "done", result: { succeeded: 1, failed: 1 } },
    ]);
  });

  it("drains a started window and finalizes it before cancellation", async () => {
    const context = state();
    const controller = new AbortController();
    const stream = executeBulkWorkflow(
      { ...definition, concurrency: 2 },
      {
        context,
        input: [1, 2, 3],
        signal: controller.signal,
        observer: (event) => {
          if (event.type === "committedCall" && event.state === "succeeded")
            controller.abort();
        },
      },
    );
    await stream.next();
    await expect(stream.next()).rejects.toMatchObject({
      name: "WorkflowCancelledError",
      committed: true,
      effectsPending: false,
    });
    expect(context).toEqual({
      writes: [1, 2],
      effects: [1, 2],
      finalized: [[1, 2]],
    });
  });

  it("rejects invalid concurrency declarations", () => {
    for (const concurrency of [0, -1, 1.5, Infinity, NaN]) {
      expect(() => defineBulkWorkflow({ ...definition, concurrency })).toThrow(
        "positive integer",
      );
    }
  });

  it("executes only as pulled, isolates uncommitted item failures, and finalizes once", async () => {
    const context = state();
    const stream = executeBulkWorkflow(definition, {
      context,
      input: [1, -1, 2],
    });
    expect(context.writes).toEqual([]);
    expect((await stream.next()).value).toEqual({
      type: "progress",
      done: 0,
      total: 3,
    });
    expect(context.writes).toEqual([]);
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events).toEqual([
      { type: "progress", done: 1, total: 3, item: 1 },
      { type: "progress", done: 2, total: 3 },
      { type: "progress", done: 3, total: 3, item: 2 },
      { type: "done", result: { succeeded: 2, failed: 1 } },
    ]);
    expect(context).toEqual({
      writes: [1, 2],
      effects: [1, 2],
      finalized: [[1, 2]],
    });
  });

  it("finalizes the committed subset when a consumer closes early", async () => {
    const context = state();
    const stream = executeBulkWorkflow(definition, { context, input: [1, 2] });
    await stream.next();
    await stream.next();
    await stream.return();
    expect(context).toEqual({ writes: [1], effects: [1], finalized: [[1]] });
    expect(await stream.next()).toMatchObject({ done: true });
  });

  it("does not start items or finalization when closed at the initial tick", async () => {
    const context = state();
    const stream = executeBulkWorkflow(definition, { context, input: [1] });
    await stream.next();
    await stream.return();
    expect(context).toEqual(state());
  });

  it("settles a started item and finalizes committed results before cancellation", async () => {
    const context = state();
    const controller = new AbortController();
    const stream = executeBulkWorkflow(definition, {
      context,
      input: [1, 2],
      signal: controller.signal,
      observer: (event) => {
        if (event.type === "committedCall" && event.state === "succeeded")
          controller.abort();
      },
    });
    await stream.next();
    await expect(stream.next()).rejects.toMatchObject({
      name: "WorkflowCancelledError",
      committed: true,
      effectsPending: false,
    });
    expect(context).toEqual({ writes: [1], effects: [1], finalized: [[1]] });
  });

  it("rejects cancellation before any work", async () => {
    const context = state();
    const stream = executeBulkWorkflow(definition, {
      context,
      input: [1],
      signal: AbortSignal.abort(),
    });
    await expect(stream.next()).rejects.toMatchObject({
      name: "WorkflowCancelledError",
      committed: false,
    });
    expect(context).toEqual(state());
  });

  it("does not replay a failed finalizer or report its committed work as an item failure", async () => {
    let attempts = 0;
    const context = state();
    const failure = new Error("Finalization unavailable");
    const stream = executeBulkWorkflow(
      {
        ...definition,
        finalize: workflow<State, BulkWorkflowSummary<number, number>>(
          "failing-finalizer",
        )
          .call("attempt", async () => {
            attempts++;
            throw failure;
          })
          .output(({ attempt }) => attempt),
      },
      { context, input: [1] },
    );
    await stream.next();
    await stream.next();
    await expect(stream.next()).rejects.toMatchObject({
      name: "WorkflowEffectError",
      committed: true,
      cause: failure,
    });
    expect(attempts).toBe(1);
    expect(context.writes).toEqual([1]);
  });
  it("does not isolate committed effect failures or start the next item", async () => {
    const context = state();
    const stream = executeBulkWorkflow(
      {
        ...definition,
        item: workflow<State, number>("effect-failure")
          .commit("saved", async ({ context }, { input }) => {
            context.writes.push(input);
            return input;
          })
          .effect("dispatch", async () => {
            throw new Error("Dispatch unavailable");
          })
          .output(({ saved }) => saved),
      },
      { context, input: [1, 2] },
    );
    await stream.next();
    await expect(stream.next()).rejects.toMatchObject({
      name: "WorkflowEffectError",
      committed: true,
      effect: "dispatch",
    });
    expect(context.writes).toEqual([1]);
    expect(context.finalized).toEqual([[]]);
  });

  it("surfaces finalization failure to a consumer closing a committed stream", async () => {
    let attempts = 0;
    const stream = executeBulkWorkflow(
      {
        ...definition,
        finalize: workflow<State, BulkWorkflowSummary<number, number>>(
          "close-finalizer",
        )
          .call("attempt", async () => {
            attempts++;
            throw new Error("Close failed");
          })
          .output(({ attempt }) => attempt),
      },
      { context: state(), input: [1, 2] },
    );
    await stream.next();
    await stream.next();
    await expect(stream.return()).rejects.toMatchObject({
      name: "WorkflowEffectError",
      committed: true,
      effect: "close-finalizer",
    });
    expect(attempts).toBe(1);
  });
});
