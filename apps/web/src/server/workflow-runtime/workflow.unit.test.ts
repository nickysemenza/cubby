import { describe, expect, it } from "vitest";

import {
  bindWorkflow,
  executeWorkflow,
  inspectWorkflow,
  workflow,
  WorkflowCancelledError,
  WorkflowEffectError,
} from "./index";

const flow = workflow<undefined, number>("arithmetic")
  .call("doubled", async (_, { input }) => input * 2)
  .output(({ doubled }) => doubled);

describe("workflow execution", () => {
  it("keeps bound operation inspection separate from execution", async () => {
    const bound = bindWorkflow(flow, (value: number) => ({
      context: undefined,
      input: value,
    }));
    expect(inspectWorkflow(bound.definition).name).toBe("arithmetic");
    expect(await bound(4)).toBe(8);
    expect(await bindWorkflow(flow)(undefined, 4)).toBe(8);
  });

  it("translates application failures while preserving runtime cancellation and effect evidence", async () => {
    const failures: unknown[] = [];
    const definition = workflow<undefined, Error>("translated")
      .call("reject", async (_, { input }) => {
        throw input;
      })
      .output(
        ({ input }) => input,
        async (_, { error }) => {
          failures.push(error);
          throw new Error("public failure", { cause: error });
        },
      );
    await expect(
      executeWorkflow(definition, {
        context: undefined,
        input: new Error("source failure"),
      }),
    ).rejects.toMatchObject({
      message: "public failure",
      cause: { message: "source failure" },
    });
    const cancellation = new WorkflowCancelledError({
      committed: true,
      effectsPending: false,
    });
    const effect = new WorkflowEffectError(
      "dispatch",
      ["dispatch"],
      new Error("provider failure"),
    );
    for (const input of [cancellation, effect]) {
      await expect(
        executeWorkflow(definition, { context: undefined, input }),
      ).rejects.toBe(input);
    }
    expect(failures).toHaveLength(1);
  });

  it("does not start cancelled workflows or let observers change execution", async () => {
    await expect(
      executeWorkflow(flow, {
        context: undefined,
        input: 1,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toBeInstanceOf(WorkflowCancelledError);
    expect(
      await executeWorkflow(flow, {
        context: undefined,
        input: 3,
        observer: () => {
          throw new Error("observer failure");
        },
      }),
    ).toBe(6);
  });

  it("settles in-flight siblings and stops scheduling after a parallel failure", async () => {
    const events: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const definition = workflow<undefined, number>("siblings")
      .parallel("branches", 2, {
        first: async () => {
          events.push("failed");
          throw new Error("failed branch");
        },
        second: async (_, { input }) => {
          await gate;
          events.push("settled");
          return input;
        },
        third: async (_, { input }) => {
          events.push("unexpected");
          return input;
        },
      })
      .output(({ input }) => input);
    const result = executeWorkflow(definition, {
      context: undefined,
      input: 2,
    }).catch((error) => {
      events.push("returned");
      return error;
    });
    await Promise.resolve();
    release();
    expect(await result).toMatchObject({ message: "failed branch" });
    expect(events).toEqual(["failed", "settled", "returned"]);
  });
});
