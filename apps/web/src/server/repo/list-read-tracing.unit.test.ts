import { SpanStatusCode, trace } from "@opentelemetry/api";
import { tracing } from "@opentelemetry/sdk-node";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { executeListQueryWithCount } from "./database-helpers";
import { loadListGroup } from "./list-projection";
import { withListReadTracing, traceListCount } from "./list-read-tracing";

const exporter = new tracing.InMemorySpanExporter();
const provider = new tracing.BasicTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});
trace.setGlobalTracerProvider(provider);
beforeEach(() => exporter.reset());
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});
const recorded = () =>
  exporter
    .getFinishedSpans()
    .map(({ name, attributes }) => ({ name, attributes }));

// Parallel list reads must not borrow entity/row dimensions, omitted groups
// must not create spans, and nesting count helpers must not duplicate phases.
describe("list phase tracing", () => {
  it("isolates concurrent entities and preserves an enrichment rejection", async () => {
    const failure = new Error("Synthetic loader failure");
    const outcomes = await Promise.allSettled([
      withListReadTracing(
        { entity: "product", projection: "enrichment", rows: 2 },
        async () => {
          await Promise.resolve();
          return loadListGroup(
            { kind: "enrichment", groups: ["derived"] },
            ["relations", "derived"],
            async () => 2,
          );
        },
      ),
      withListReadTracing(
        { entity: "recipe", projection: "enrichment", rows: 7 },
        () =>
          loadListGroup(
            { kind: "enrichment", groups: ["quality"] },
            "quality",
            async () => {
              throw failure;
            },
          ),
      ),
    ]);
    expect(outcomes).toMatchObject([
      { status: "fulfilled", value: 2 },
      { status: "rejected", reason: failure },
    ]);
    expect(
      exporter
        .getFinishedSpans()
        .find((span) => span.attributes["entity.kind"] === "recipe")?.status
        .code,
    ).toBe(SpanStatusCode.ERROR);
    expect(recorded()).toEqual(
      expect.arrayContaining([
        {
          name: "entity.list.enrichment.group",
          attributes: {
            "entity.kind": "product",
            "list.projection": "enrichment",
            "list.rows": 2,
            "list.groups": "relations,derived",
          },
        },
        {
          name: "entity.list.enrichment.group",
          attributes: {
            "entity.kind": "recipe",
            "list.projection": "enrichment",
            "list.rows": 7,
            "list.groups": "quality",
            "error.type": "Error",
          },
        },
      ]),
    );
  });

  it("traces one page/count phase, without duplicated nested count spans", async () => {
    const result = await withListReadTracing(
      { entity: "product", projection: "base" },
      () =>
        executeListQueryWithCount({
          kind: "page",
          rows: async () => ["first", "second"],
          count: () => traceListCount(async () => 9),
        }),
    );
    expect(result).toEqual({ data: ["first", "second"], count: 9 });
    expect(
      recorded().filter((entry) => entry.name === "entity.list.core.page"),
    ).toEqual([
      {
        name: "entity.list.core.page",
        attributes: {
          "entity.kind": "product",
          "list.projection": "base",
          "list.rows": 2,
        },
      },
    ]);
    expect(
      recorded().filter((entry) => entry.name === "entity.list.core.count"),
    ).toEqual([
      {
        name: "entity.list.core.count",
        attributes: {
          "entity.kind": "product",
          "list.projection": "base",
          "list.count": 9,
        },
      },
    ]);
  });
});
