import { describe, expect, it } from "vitest";

import { workflow } from "./builder";
import { defineBulkWorkflow } from "./bulk";
import {
  definePreparedBulkWorkflow,
  executePreparedBulkWorkflow,
} from "./prepared-bulk";

type InitialContext = { readonly selected: readonly number[] };
type PreparedContext = { readonly extra: string };
type PreparedInput = { readonly items: readonly number[] };

const definition = definePreparedBulkWorkflow({
  name: "prepared-bulk-test",
  prepare: workflow<InitialContext, undefined>("prepared-bulk-test.prepare")
    .call("selected", async ({ context }) => context.selected)
    .output(({ selected }) => ({
      context: { extra: "extras survive an empty selection" },
      input: { items: selected },
    })),
  bulk: defineBulkWorkflow({
    name: "prepared-bulk-test",
    items: workflow<PreparedContext, PreparedInput>(
      "prepared-bulk-test.items",
    ).output(({ input }) => input.items),
    item: workflow<PreparedContext, number>("prepared-bulk-test.item")
      .commit("saved", async (_, { input }) => input)
      .output(({ saved }) => saved),
    finalize: workflow<
      PreparedContext,
      {
        readonly succeeded: readonly unknown[];
        readonly failed: readonly unknown[];
      }
    >("prepared-bulk-test.finalize")
      .call("summary", async ({ context }, { input }) => ({
        extra: context.extra,
        succeeded: input.succeeded.length,
      }))
      .output(({ summary }) => summary),
    initialProgress: false,
    onItemError: "stop",
    progress: () => undefined,
  }),
});

describe("prepared bulk workflow execution", () => {
  it("keeps preparation metadata available to an empty bulk finalizer", async () => {
    const events = [];
    for await (const event of executePreparedBulkWorkflow(definition, {
      context: { selected: [] },
      input: undefined,
    }))
      events.push(event);
    expect(events).toEqual([
      {
        type: "done",
        result: { extra: "extras survive an empty selection", succeeded: 0 },
      },
    ]);
  });

  it("prepares before the bounded item graph", async () => {
    const events = [];
    for await (const event of executePreparedBulkWorkflow(definition, {
      context: { selected: [1, 2] },
      input: undefined,
    }))
      events.push(event);
    expect(events).toEqual([
      { type: "progress", done: 1, total: 2 },
      { type: "progress", done: 2, total: 2 },
      {
        type: "done",
        result: { extra: "extras survive an empty selection", succeeded: 2 },
      },
    ]);
  });
});
