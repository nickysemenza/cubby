import { describe, expect, it } from "vitest";

import { workflow } from "./builder";
import { defineEventStream, executeEventStream } from "./event-stream";

type Context = {
  calls: string[];
  fail?: "source" | "event" | "complete";
  acquired?: () => void;
};
type Resource = { closed: boolean };
type ResourceInput = { input: number[]; resource: Resource };

const definition = defineEventStream({
  name: "test.events",
  acquire: workflow<Context, number[]>("test.events.acquire")
    .call("resource", async ({ context }) => {
      context.calls.push("acquire");
      context.acquired?.();
      return { closed: false };
    })
    .output(({ resource }) => resource),
  source: workflow<Context, ResourceInput>("test.events.source")
    .call("source", async ({ context }, { input }) =>
      (async function* () {
        try {
          for (const value of input.input) {
            context.calls.push(`source:${value}`);
            if (context.fail === "source") throw new Error("source failed");
            yield value;
          }
        } finally {
          context.calls.push("source closed");
        }
      })(),
    )
    .output(({ source }) => source),
  event: workflow<Context, ResourceInput & { event: number }>(
    "test.events.event",
  )
    .call("public", async ({ context }, { input }) => {
      if (context.fail === "event") throw new Error("event failed");
      return input.event === 0 ? [] : [String(input.event)];
    })
    .output(({ public: output }) => output),
  complete: workflow<Context, ResourceInput>("test.events.complete")
    .call("done", async ({ context }) => {
      context.calls.push("complete");
      if (context.fail === "complete") throw new Error("complete failed");
      return ["done"];
    })
    .output(({ done }) => done),
  release: workflow<Context, ResourceInput>("test.events.release")
    .call("close", async ({ context }, { input }) => {
      if (input.resource.closed) throw new Error("Resource already released");
      input.resource.closed = true;
      context.calls.push("release");
    })
    .output(({ close }) => close),
});

const collect = async <Value>(events: AsyncIterable<Value>) => {
  const values: Value[] = [];
  for await (const value of events) values.push(value);
  return values;
};

describe("resource event workflows", () => {
  it("rejects domain writes that belong to commit-aware workflow runtimes", () => {
    expect(() =>
      defineEventStream({
        ...definition,
        acquire: workflow<Context, number[]>("test.write")
          .commit("write", async () => ({ closed: false }))
          .output(({ write }) => write),
      }),
    ).toThrow("Event source workflows cannot contain committedCall");
  });
  it("maps and filters ordered events, completes, and releases once", async () => {
    const context: Context = { calls: [] };
    expect(
      await collect(
        executeEventStream(definition, { context, input: [0, 1, 2] }),
      ),
    ).toEqual(["1", "2", "done"]);
    expect(context.calls).toEqual([
      "acquire",
      "source:0",
      "source:1",
      "source:2",
      "source closed",
      "complete",
      "release",
    ]);
  });

  it("closes the source and releases on early return without reading ahead or completing", async () => {
    const context: Context = { calls: [] };
    const events = executeEventStream(definition, { context, input: [1, 2] });
    expect((await events.next()).value).toBe("1");
    await events.return();
    expect(context.calls).toEqual([
      "acquire",
      "source:1",
      "source closed",
      "release",
    ]);
  });

  it.each(["source", "event", "complete"] as const)(
    "releases after %s failure",
    async (fail) => {
      const context: Context = { calls: [], fail };
      await expect(
        collect(executeEventStream(definition, { context, input: [1] })),
      ).rejects.toThrow(`${fail} failed`);
      expect(context.calls.at(-1)).toBe("release");
      expect(context.calls.filter((call) => call === "release")).toHaveLength(
        1,
      );
    },
  );

  it("does not acquire for an already cancelled consumer", async () => {
    const context: Context = { calls: [] };
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(
        executeEventStream(definition, {
          context,
          input: [1],
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow("Workflow cancelled before commit");
    expect(context.calls).toEqual([]);
  });

  it("releases when cancellation arrives during acquisition", async () => {
    const controller = new AbortController();
    const context: Context = { calls: [], acquired: () => controller.abort() };
    await expect(
      collect(
        executeEventStream(definition, {
          context,
          input: [1],
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow("Workflow cancelled before commit");
    expect(context.calls).toEqual(["acquire", "release"]);
  });
});
