import { beforeEach, describe, expect, it } from "vitest";
import {
  recordCommandSearch,
  recordMutation,
  recordNavigation,
  recordQueryOperation,
  reset,
  snapshot,
} from "./perf-store";

describe("interaction performance records", () => {
  beforeEach(() => reset());

  it("keeps bounded navigation and Command-K samples", () => {
    for (let index = 0; index < 60; index += 1) {
      recordNavigation({
        routeId: `/route-${index}`,
        durationMs: index,
        pendingShown: index % 2 === 0,
      });
      recordCommandSearch({
        phase: "lexical",
        durationMs: index,
        resultCount: 1,
        scoped: false,
        queryLength: 4,
      });
    }

    const current = snapshot();
    expect(current.navigation.records).toHaveLength(50);
    expect(current.navigation.records[0]?.routeId).toBe("/route-10");
    expect(current.commandSearch.records).toHaveLength(50);
    expect(current.commandSearch.records.at(-1)?.durationMs).toBe(59);
  });

  it("separates fetches, reuse, hydration, cancellation, and mutation history", () => {
    recordQueryOperation({
      operation: "entity.list",
      transport: "start",
      kind: "hydrated",
    });
    recordQueryOperation({
      operation: "entity.list",
      transport: "start",
      kind: "reuse",
    });
    recordQueryOperation({
      operation: "entity.list",
      transport: "start",
      kind: "fetch",
      durationMs: 25,
      outcome: "cancelled",
    });
    for (let index = 0; index < 60; index += 1) {
      recordMutation({
        id: `mutation-${index}`,
        operation: "entity.mutate",
        transport: "start",
        outcome: index % 2 === 0 ? "success" : "error",
        durationMs: index,
      });
    }

    const current = snapshot();
    expect(current.queries["start:entity.list"]).toMatchObject({
      fetches: 1,
      reuses: 1,
      hydrated: 1,
      cancelled: 1,
      errors: 0,
      totalMs: 25,
      maxMs: 25,
    });
    expect(current.mutations).toHaveLength(50);
    expect(current.mutations[0]?.id).toBe("mutation-59");
    expect(current.mutations.at(-1)?.id).toBe("mutation-10");
  });
});
