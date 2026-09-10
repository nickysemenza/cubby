import { describe, expect, it } from "vitest";

import {
  branchStep,
  callStep,
  defineWorkflow,
  defineWorkflowFunction,
  inspectWorkflow,
  mapWorkflowValue,
  mapStep,
  transactionStep,
  parallelStep,
  workflowInput,
  workflowStepOutput,
} from "./definition";
import { executeWorkflow, WorkflowCancelledError } from "./execute";
import { bindWorkflow } from "./operation";

const double = defineWorkflowFunction<undefined, number, number>(
  "double",
  async (_, value) => value * 2,
);
const input = workflowInput<number>();
const doubled = callStep({ name: "doubled", fn: double, input });
const flow = defineWorkflow({
  name: "arithmetic",
  steps: [doubled],
  output: workflowStepOutput(doubled),
});

describe("declarative workflows", () => {
  it("connects typed step outputs and describes the graph without running functions", async () => {
    const incremented = callStep({
      name: "incremented",
      fn: double,
      input: mapWorkflowValue(doubled.output, (value) => value + 1),
    });
    const composed = defineWorkflow({
      name: "composed",
      steps: [doubled, incremented],
      output: incremented.output,
    });
    expect(
      inspectWorkflow(composed).steps.map((step) => ({
        name: step.name,
        dependencies: step.dependencies,
      })),
    ).toEqual([
      { name: "doubled", dependencies: ["$input"] },
      { name: "incremented", dependencies: ["doubled"] },
    ]);
    expect(
      await executeWorkflow(composed, { context: undefined, input: 3 }),
    ).toBe(14);
  });

  it("keeps the bound operation's graph available without executing it", async () => {
    const bound = bindWorkflow(flow, (value: number) => ({
      context: undefined,
      input: value,
    }));
    expect(inspectWorkflow(bound.definition).name).toBe("arithmetic");
    expect(await bound(4)).toBe(8);

    const passthrough = bindWorkflow(flow);
    expect(inspectWorkflow(passthrough.definition).name).toBe("arithmetic");
    expect(await passthrough(undefined, 4)).toBe(8);
  });

  it("translates application failures while preserving runtime cancellation", async () => {
    const failures: unknown[] = [];
    const rejected = callStep({
      name: "reject",
      input,
      fn: defineWorkflowFunction<undefined, number, never>(
        "reject",
        async () => {
          throw new Error("source failure");
        },
      ),
    });
    const definition = defineWorkflow({
      name: "translated",
      steps: [rejected],
      output: input,
      failure: defineWorkflowFunction<
        undefined,
        { input: number; error: unknown },
        never
      >("translate", async (_, { error }) => {
        failures.push(error);
        throw new Error("public failure", { cause: error });
      }),
    });
    expect(inspectWorkflow(definition).failureFunction).toBe("translate");
    await expect(
      executeWorkflow(definition, { context: undefined, input: 1 }),
    ).rejects.toMatchObject({
      message: "public failure",
      cause: { message: "source failure" },
    });
    await expect(
      executeWorkflow(definition, {
        context: undefined,
        input: 1,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toBeInstanceOf(WorkflowCancelledError);
    expect(failures).toHaveLength(1);
  });

  it("executes only the selected branch and exposes its result", async () => {
    const events: string[] = [];
    const positive = callStep({
      name: "positive",
      input,
      fn: defineWorkflowFunction<undefined, number, string>(
        "positive",
        async () => {
          events.push("positive");
          return "positive";
        },
      ),
    });
    const negative = callStep({
      name: "negative",
      input,
      fn: defineWorkflowFunction<undefined, number, null>(
        "negative",
        async () => {
          events.push("negative");
          return null;
        },
      ),
    });
    const choice = branchStep({
      name: "choice",
      input,
      when: defineWorkflowFunction<undefined, number, boolean>(
        "isPositive",
        async (_, value) => value > 0,
      ),
      whenTrue: defineWorkflow({
        name: "positive",
        steps: [positive],
        output: positive.output,
      }),
      whenFalse: defineWorkflow({
        name: "negative",
        steps: [negative],
        output: negative.output,
      }),
    });
    const definition = defineWorkflow({
      name: "choose",
      steps: [choice],
      output: choice.output,
    });
    expect(
      await executeWorkflow(definition, { context: undefined, input: -1 }),
    ).toBeNull();
    expect(events).toEqual(["negative"]);
    expect(
      await executeWorkflow(definition, { context: undefined, input: 1 }),
    ).toBe("positive");
    expect(events).toEqual(["negative", "positive"]);
  });

  it("returns typed map results in input order", async () => {
    const mapped = mapStep({
      name: "doubles",
      items: workflowInput<readonly number[]>(),
      concurrency: 2,
      workflow: flow,
    });
    const total = callStep({
      name: "total",
      input: mapWorkflowValue(mapped.output, (values) =>
        values.reduce((sum, value) => sum + value, 0),
      ),
      fn: double,
    });
    const definition = defineWorkflow({
      name: "mapThenSum",
      steps: [mapped, total],
      output: total.output,
    });
    expect(
      await executeWorkflow(definition, {
        context: undefined,
        input: [3, 1, 2],
      }),
    ).toBe(24);
  });

  it("rejects transactions nested through child workflows before execution", () => {
    const child = defineWorkflow({
      name: "childTransaction",
      steps: [transactionStep({ name: "child", steps: [doubled] })],
      output: doubled.output,
    });
    expect(() =>
      defineWorkflow({
        name: "nested",
        steps: [
          transactionStep({
            name: "outer",
            steps: [
              mapStep({
                name: "children",
                concurrency: 1,
                items: workflowInput<readonly number[]>(),
                workflow: child,
              }),
            ],
          }),
        ],
        output: workflowInput<readonly number[]>(),
      }),
    ).toThrow("Nested workflow transactions are not supported");
  });

  it("rejects unavailable outputs and duplicate names before execution", () => {
    expect(() =>
      defineWorkflow({ name: "missing", steps: [], output: doubled.output }),
    ).toThrow("unavailable output doubled");
    expect(() =>
      defineWorkflow({
        name: "duplicate",
        steps: [doubled, doubled],
        output: doubled.output,
      }),
    ).toThrow("duplicate or empty step doubled");
  });

  it("does not start cancelled workflows", async () => {
    await expect(
      executeWorkflow(flow, {
        context: undefined,
        input: 1,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toBeInstanceOf(WorkflowCancelledError);
  });

  it("settles in-flight siblings and stops scheduling after a parallel failure", async () => {
    const events: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fail = callStep({
      name: "fail",
      input,
      fn: defineWorkflowFunction<undefined, number, number>(
        "fail",
        async () => {
          events.push("failed");
          throw new Error("failed branch");
        },
      ),
    });
    const slow = callStep({
      name: "slow",
      input,
      fn: defineWorkflowFunction<undefined, number, number>(
        "slow",
        async (_, value) => {
          await gate;
          events.push("settled");
          return value;
        },
      ),
    });
    const later = callStep({
      name: "later",
      input,
      fn: defineWorkflowFunction<undefined, number, number>(
        "later",
        async (_, value) => {
          events.push("unexpected");
          return value;
        },
      ),
    });
    const definition = defineWorkflow({
      name: "siblings",
      steps: [
        parallelStep({
          name: "branches",
          input,
          concurrency: 2,
          branches: {
            first: defineWorkflow({
              name: "first",
              steps: [fail],
              output: fail.output,
            }),
            second: defineWorkflow({
              name: "second",
              steps: [slow],
              output: slow.output,
            }),
            third: defineWorkflow({
              name: "third",
              steps: [later],
              output: later.output,
            }),
          },
        }),
      ],
      output: input,
    });
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
