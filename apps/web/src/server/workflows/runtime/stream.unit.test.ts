import { describe, expect, it } from "vitest";

import { workflow } from "./builder";
import { defineCoordinatorStream, executeCoordinatorStream } from "./stream";

type State = {
  selections: number;
  commits: number[][];
  effects: number[][];
};
type EnqueueInput = { readonly input: undefined; readonly selection: number[] };

const state = (): State => ({ selections: 0, commits: [], effects: [] });
const definition = defineCoordinatorStream({
  name: "coordinator-test",
  select: workflow<State, undefined>("coordinator-test.select")
    .call("selected", async ({ context }) => {
      context.selections++;
      return [1, 2];
    })
    .output(({ selected }) => selected),
  commit: workflow<State, EnqueueInput>("coordinator-test.enqueue")
    .commit("queued", async ({ context }, { input: { selection } }) => {
      context.commits.push(selection);
      return { enqueued: selection.length, total: selection.length };
    })
    .effect("dispatched", async ({ context }, { queued }) => {
      context.effects.push([queued.enqueued]);
    })
    .output(({ queued }) => queued),
  total: (selected) => selected.length,
});

describe("coordinator stream execution", () => {
  it("keeps named selection and enqueue definitions inspectable", () => {
    expect(definition).toMatchObject({
      kind: "coordinator",
      name: "coordinator-test",
    });
    expect(definition.select.name).toBe("coordinator-test.select");
    expect(definition.commit.name).toBe("coordinator-test.enqueue");
    expect(definition.commit.steps).toMatchObject([
      { type: "committedCall", name: "queued" },
      { type: "committedEffect", name: "dispatched" },
    ]);
  });

  it("emits the stable two-phase progress transport and final result", async () => {
    const context = state();
    const events = [];
    for await (const event of executeCoordinatorStream(definition, {
      context,
      input: undefined,
    }))
      events.push(event);

    expect(events).toEqual([
      { type: "progress", done: 0, total: 2 },
      { type: "progress", done: 2, total: 2 },
      { type: "done", result: { enqueued: 2, total: 2 } },
    ]);
    expect(context).toEqual({
      selections: 1,
      commits: [[1, 2]],
      effects: [[2]],
    });
  });

  it("allows durable coordinators to report an explicit empty or partial completion", async () => {
    const customProgress = (
      selected: number[],
      enqueued: { enqueued: number; total: number },
    ) => ({ done: enqueued.enqueued, total: selected.length });
    const empty = defineCoordinatorStream({
      ...definition,
      name: "coordinator-empty",
      select: workflow<State, undefined>("coordinator-empty.select")
        .call("selected", async () => [])
        .output(({ selected }) => selected),
      completionProgress: customProgress,
    });
    const partial = defineCoordinatorStream({
      ...definition,
      name: "coordinator-partial",
      commit: workflow<State, EnqueueInput>("coordinator-partial.enqueue")
        .commit("queued", async () => ({ enqueued: 1, total: 2 }))
        .output(({ queued }) => queued),
      completionProgress: customProgress,
    });

    const emptyEvents = [];
    for await (const event of executeCoordinatorStream(empty, {
      context: state(),
      input: undefined,
    }))
      emptyEvents.push(event);
    expect(emptyEvents).toEqual([
      { type: "progress", done: 0, total: 0 },
      { type: "progress", done: 0, total: 0 },
      { type: "done", result: { enqueued: 0, total: 0 } },
    ]);

    const partialEvents = [];
    for await (const event of executeCoordinatorStream(partial, {
      context: state(),
      input: undefined,
    }))
      partialEvents.push(event);
    expect(partialEvents).toEqual([
      { type: "progress", done: 0, total: 2 },
      { type: "progress", done: 1, total: 2 },
      { type: "done", result: { enqueued: 1, total: 2 } },
    ]);

    const suppressed = defineCoordinatorStream({
      ...definition,
      name: "coordinator-suppressed",
      completionProgress: () => null,
    });
    const suppressedEvents = [];
    for await (const event of executeCoordinatorStream(suppressed, {
      context: state(),
      input: undefined,
    }))
      suppressedEvents.push(event);
    expect(suppressedEvents).toEqual([
      { type: "progress", done: 0, total: 2 },
      { type: "done", result: { enqueued: 2, total: 2 } },
    ]);
  });

  it("does not enqueue after a consumer closes at the selection phase", async () => {
    const context = state();
    const stream = executeCoordinatorStream(definition, {
      context,
      input: undefined,
    });
    expect((await stream.next()).value).toEqual({
      type: "progress",
      done: 0,
      total: 2,
    });
    await stream.return();
    expect(context).toEqual({ selections: 1, commits: [], effects: [] });
  });

  it("rejects cancellation before any selection or enqueue work", async () => {
    const context = state();
    const stream = executeCoordinatorStream(definition, {
      context,
      input: undefined,
      signal: AbortSignal.abort(),
    });
    await expect(stream.next()).rejects.toMatchObject({
      name: "WorkflowCancelledError",
      committed: false,
    });
    expect(context).toEqual(state());
  });

  it("settles required effects and preserves committed cancellation metadata", async () => {
    const context = state();
    const controller = new AbortController();
    const stream = executeCoordinatorStream(definition, {
      context,
      input: undefined,
      signal: controller.signal,
      observer: (event) => {
        if (event.step === "queued" && event.state === "succeeded")
          controller.abort();
      },
    });
    await stream.next();
    await expect(stream.next()).rejects.toMatchObject({
      name: "WorkflowCancelledError",
      committed: true,
      effectsPending: false,
    });
    expect(context).toEqual({
      selections: 1,
      commits: [[1, 2]],
      effects: [[2]],
    });
  });
});
