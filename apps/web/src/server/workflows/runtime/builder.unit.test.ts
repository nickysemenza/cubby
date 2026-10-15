import { describe, expect, expectTypeOf, it } from "vitest";

import { workflow } from "./builder";
import { inspectWorkflow } from "./definition";
import {
  executeWorkflow,
  WorkflowCancelledError,
  WorkflowEffectError,
} from "./execute";

describe("workflow authoring", () => {
  it("keeps mapped child branches visible to inspection and execution observers", async () => {
    const child = workflow<undefined, number>("quantity")
      .branch("known", {
        when: async (_, { input }) => input > 0,
        whenTrue: (branch) =>
          branch
            .call("scale", async (_, { input }) => input.input * 2)
            .output(({ scale }) => scale),
        whenFalse: (branch) => branch.output(() => null),
      })
      .output(({ known }) => known);
    const definition = workflow<undefined, number[]>("requirements")
      .mapWorkflow("quantities", {
        items: ({ input }) => input,
        concurrency: 1,
        workflow: child,
      })
      .output(({ quantities }) => quantities);
    const steps: string[] = [];
    const result = await executeWorkflow(definition, {
      context: undefined,
      input: [2, 0, 3],
      observer: (event) => {
        if (event.step) steps.push(event.step);
      },
    });
    expectTypeOf(result).toEqualTypeOf<(number | null)[]>();
    expect(result).toEqual([4, null, 6]);
    expect(steps).toContain("scale");
    expect(inspectWorkflow(definition).steps[0]).toMatchObject({
      type: "map",
      concurrency: 1,
      branches: {
        item: { steps: [{ type: "branch", name: "known" }] },
      },
    });
  });
  it("maps selected items with prior outputs, bounded concurrency, and input ordering", async () => {
    let active = 0;
    let maximum = 0;
    const definition = workflow<undefined, number[]>("mapped-reads")
      .call("offset", async () => 10)
      .map("results", {
        items: ({ input }) => input,
        concurrency: 2,
        run: async (_, { item, index, values }) => {
          active++;
          maximum = Math.max(maximum, active);
          await Promise.resolve();
          active--;
          return { index, value: item + values.offset };
        },
      })
      .output(({ results }) => results);
    const result = await executeWorkflow(definition, {
      context: undefined,
      input: [3, 1, 2],
    });
    expectTypeOf(result).toEqualTypeOf<{ index: number; value: number }[]>();
    expect(result).toEqual([
      { index: 0, value: 13 },
      { index: 1, value: 11 },
      { index: 2, value: 12 },
    ]);
    expect(maximum).toBeLessThanOrEqual(2);
    expect(active).toBe(0);
    expect(inspectWorkflow(definition).steps[1]).toMatchObject({
      name: "results",
      type: "map",
      concurrency: 2,
    });
  });

  it("passes prior outputs into typed parallel branches and skips the unselected branch", async () => {
    const calls: string[] = [];
    const definition = workflow<{ factor: number }, number>("selected-reads")
      .call("scaled", async ({ context }, { input }) => input * context.factor)
      .branch("selected", {
        when: async (_, { scaled }) => scaled > 0,
        whenTrue: (branch) =>
          branch
            .parallel("reads", 2, {
              number: async (_, { input: { scaled } }) => {
                calls.push("number");
                return scaled + 1;
              },
              label: async (_, { input: { scaled } }) => {
                calls.push("label");
                return `Scaled ${scaled}`;
              },
            })
            .output(({ reads }) => reads),
        whenFalse: (branch) => branch.output(() => null),
      })
      .output(({ selected }) => selected);
    const result = await executeWorkflow(definition, {
      context: { factor: 3 },
      input: 2,
    });
    expectTypeOf(result).toEqualTypeOf<{
      number: number;
      label: string;
    } | null>();
    expect(result).toEqual({ number: 7, label: "Scaled 6" });
    expect(calls).toEqual(["number", "label"]);
    expect(
      await executeWorkflow(definition, { context: { factor: 3 }, input: -1 }),
    ).toBeNull();
    expect(calls).toEqual(["number", "label"]);
    const selected = inspectWorkflow(definition).steps[1];
    expect(selected?.dependencies).toEqual(["$input", "scaled"]);
    expect(selected?.branches?.whenTrue?.steps[0]).toMatchObject({
      type: "parallel",
      concurrency: 2,
      dependencies: ["$input"],
      branches: {
        number: {
          steps: [{ function: "selected-reads.selected.then.reads.number" }],
        },
        label: {
          steps: [{ function: "selected-reads.selected.then.reads.label" }],
        },
      },
    });
  });

  it("does not run effects when cancellation or failure prevents commit", async () => {
    const events: string[] = [];
    const failure = new Error("write rejected");
    const definition = workflow<undefined, void>("uncommitted-effects")
      .commit("saved", async () => {
        events.push("write");
        throw failure;
      })
      .effect("dispatch", async () => {
        events.push("effect");
      })
      .output(() => undefined);
    await expect(
      executeWorkflow(definition, {
        context: undefined,
        input: undefined,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ committed: false, effectsPending: false });
    expect(events).toEqual([]);
    await expect(
      executeWorkflow(definition, {
        context: undefined,
        input: undefined,
      }),
    ).rejects.toBe(failure);
    expect(events).toEqual(["write"]);
  });

  it("finishes required effects after a committed cancellation before reporting it", async () => {
    const controller = new AbortController();
    const effects: string[] = [];
    const definition = workflow<undefined, void>("committed-effects")
      .commit("saved", async () => {
        controller.abort();
        return 7;
      })
      .effect("resolve", async ({ signal, scope }, { saved }) => {
        expect(signal.aborted).toBe(false);
        expect(scope).toBe("afterCommit");
        effects.push(`resolved:${saved}`);
        return `record:${saved}`;
      })
      .effect("dispatch", async (_, { resolve }) => {
        effects.push(`dispatched:${resolve}`);
      })
      .call("optional", async () => {
        effects.push("optional");
      })
      .output(({ saved }) => saved);
    await expect(
      executeWorkflow(definition, {
        context: undefined,
        input: undefined,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      name: WorkflowCancelledError.name,
      committed: true,
      effectsPending: false,
    });
    expect(effects).toEqual(["resolved:7", "dispatched:record:7"]);
  });

  it("reports failed and pending effects without rerunning a committed write", async () => {
    let writes = 0;
    const effects: string[] = [];
    const failure = new Error("dispatch unavailable");
    const definition = workflow<undefined, void>("failed-effects")
      .commit("saved", async () => ++writes)
      .effect("first", async () => {
        effects.push("first");
      })
      .effect("failed", async () => {
        throw failure;
      })
      .effect("pending", async () => {
        effects.push("pending");
      })
      .output(({ saved }) => saved);
    await expect(
      executeWorkflow(definition, {
        context: undefined,
        input: undefined,
      }),
    ).rejects.toMatchObject({
      name: WorkflowEffectError.name,
      committed: true,
      effect: "failed",
      pendingEffects: ["failed", "pending"],
      cause: failure,
    });
    expect(writes).toBe(1);
    expect(effects).toEqual(["first"]);
  });

  it("rejects effects without an immediately preceding commit or effect", () => {
    expect(() =>
      workflow<undefined, void>("uncommitted")
        .effect("effect", async () => 1)
        .output(({ effect }) => effect),
    ).toThrow("must immediately follow");
    expect(() =>
      workflow<undefined, void>("separated")
        .commit("saved", async () => 1)
        .call("read", async () => 2)
        .effect("effect", async () => 3)
        .output(({ effect }) => effect),
    ).toThrow("must immediately follow");
  });

  it("infers prior outputs and lowers registered functions to an inspectable graph", async () => {
    const definition = workflow<{ factor: number }, number>("multiply")
      .call("value", async ({ context }, { input }) => input * context.factor)
      .call("label", async (_, { value }) => `Result: ${value}`)
      .output(({ value, label }) => ({ value, label }));
    const result = await executeWorkflow(definition, {
      context: { factor: 3 },
      input: 4,
    });
    expectTypeOf(result).toEqualTypeOf<{ value: number; label: string }>();
    expect(result).toEqual({ value: 12, label: "Result: 12" });
    expect(inspectWorkflow(definition).steps).toEqual([
      expect.objectContaining({ name: "value", function: "multiply.value" }),
      expect.objectContaining({ name: "label", function: "multiply.label" }),
    ]);
  });

  it("keeps composed declarations independent", async () => {
    const base = workflow<undefined, number>("branch").call(
      "value",
      async (_, { input }) => input + 1,
    );
    const left = base
      .call("extra", async (_, { value }) => value + 10)
      .output(({ extra }) => extra);
    const right = base.output(({ value }) => value);
    expect(await executeWorkflow(left, { context: undefined, input: 2 })).toBe(
      13,
    );
    expect(await executeWorkflow(right, { context: undefined, input: 2 })).toBe(
      3,
    );
    expect(inspectWorkflow(right).steps).toHaveLength(1);
  });

  it("preserves committed cancellation evidence", async () => {
    const controller = new AbortController();
    const definition = workflow<undefined, void>("write")
      .commit("saved", async () => {
        controller.abort();
        return 1;
      })
      .output(({ saved }) => saved);
    await expect(
      executeWorkflow(definition, {
        context: undefined,
        input: undefined,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      name: WorkflowCancelledError.name,
      committed: true,
    });
  });

  it("recovers an uncommitted attempt after an inherited lease commit", async () => {
    const events: string[] = [];
    const definition = workflow<undefined, string>("leased")
      .commit("lease", async () => "claimed")
      .attempt("provider", {
        attempt: (branch) =>
          branch
            .call("fetch", async () => {
              throw new Error("offline");
            })
            .output(({ fetch }) => fetch),
        recover: (branch) =>
          branch
            .commit("settle", async (_, { input }) => {
              events.push(`recovered:${String(input.error)}`);
              return input.input.lease;
            })
            .effect("notify", async (_, { settle }) => {
              events.push(`notified:${settle}`);
            })
            .output(({ settle }) => settle),
      })
      .output(({ provider }) => provider);
    const observed: string[] = [];
    await expect(
      executeWorkflow(definition, {
        context: undefined,
        input: "job",
        observer: (event) => observed.push(`${event.step}:${event.state}`),
      }),
    ).resolves.toBe("claimed");
    expect(events).toEqual(["recovered:Error: offline", "notified:claimed"]);
    expect(observed).toContain("settle:succeeded");
    expect(inspectWorkflow(definition).steps[1]).toMatchObject({
      type: "attempt",
      branches: {
        attempt: { name: "leased.provider.attempt" },
        recover: { name: "leased.provider.recover" },
      },
    });
  });

  it("does not recover cancellation, effects, or a new attempted commit", async () => {
    const cancelled = workflow<undefined, void>("cancelled")
      .attempt("work", {
        attempt: (branch) =>
          branch
            .call("read", async ({ signal }) => {
              if (signal.aborted) throw new Error("unreachable");
              throw new Error("provider");
            })
            .output(({ read }) => read),
        recover: (branch) => branch.output(() => "recovered"),
      })
      .output(({ work }) => work);
    await expect(
      executeWorkflow(cancelled, {
        context: undefined,
        input: undefined,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toBeInstanceOf(WorkflowCancelledError);

    const committed = workflow<undefined, void>("committed-attempt")
      .attempt("write", {
        attempt: (branch) =>
          branch
            .commit("saved", async () => 1)
            .effect("broken", async () => {
              throw new Error("effect failed");
            })
            .output(({ saved }) => saved),
        recover: (branch) => branch.output(() => 2),
      })
      .output(({ write }) => write);
    await expect(
      executeWorkflow(committed, { context: undefined, input: undefined }),
    ).rejects.toBeInstanceOf(WorkflowEffectError);

    let recovered = false;
    const failedCommit = workflow<undefined, void>("failed-commit")
      .attempt("write", {
        attempt: (branch) =>
          branch
            .commit("saved", async () => 1)
            .call("provider", async () => {
              throw new Error("provider failed after write");
            })
            .output(({ provider }) => provider),
        recover: (branch) =>
          branch
            .call("recovered", async () => {
              recovered = true;
              return 2;
            })
            .output(({ recovered }) => recovered),
      })
      .output(({ write }) => write);
    await expect(
      executeWorkflow(failedCommit, { context: undefined, input: undefined }),
    ).rejects.toThrow("provider failed after write");
    expect(recovered).toBe(false);

    let recoveredAfterLostAck = false;
    let writeLanded = false;
    const lostAcknowledgement = workflow<undefined, void>("lost-ack")
      .attempt("write", {
        attempt: (branch) =>
          branch
            .commit("saved", async () => {
              writeLanded = true;
              throw new Error("write acknowledgement lost");
            })
            .output(({ saved }) => saved),
        recover: (branch) =>
          branch
            .call("recovered", async () => {
              recoveredAfterLostAck = true;
              return 2;
            })
            .output(({ recovered }) => recovered),
      })
      .output(({ write }) => write);
    await expect(
      executeWorkflow(lostAcknowledgement, {
        context: undefined,
        input: undefined,
      }),
    ).rejects.toThrow("write acknowledgement lost");
    expect(writeLanded).toBe(true);
    expect(recoveredAfterLostAck).toBe(false);
  });

  it("does not recover when cancellation arrives during a provider call", async () => {
    const controller = new AbortController();
    let recovered = false;
    const definition = workflow<undefined, void>("cancel-during-provider")
      .attempt("provider", {
        attempt: (branch) =>
          branch
            .call("read", async () => {
              controller.abort();
              return "late";
            })
            .output(({ read }) => read),
        recover: (branch) =>
          branch
            .call("recover", async () => {
              recovered = true;
              return "recovered";
            })
            .output(({ recover }) => recover),
      })
      .output(({ provider }) => provider);
    await expect(
      executeWorkflow(definition, {
        context: undefined,
        input: undefined,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(WorkflowCancelledError);
    expect(recovered).toBe(false);
  });
});
