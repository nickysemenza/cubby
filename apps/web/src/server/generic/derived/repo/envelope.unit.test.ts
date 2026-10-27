import { withFieldEnvelopes } from "@cubby/schemas/field-envelope";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildFieldEnvelopeRow } from "~/server/generic/derived/repo/envelope";
import { publicFieldEnvelopeRow } from "~/server/generic/derived/repo/public-read";
import type { StoredDerivedRead } from "~/server/generic/derived/repo/read";

const assigneeRead = withFieldEnvelopes(
  z.object({ id: z.string(), assigneeId: z.string().nullable() }),
  { assigneeId: z.string().nullable() },
);

function cached(
  values: Pick<StoredDerivedRead, "value" | "decision">,
): StoredDerivedRead {
  return {
    ...values,
    resultExists: true,
    stale: true,
    retryAt: null,
    computedAt: "2026-10-25T20:00:00Z",
    error: null,
    decision: values.decision ?? {
      outcome:
        values.value == null
          ? { kind: "empty", reason: "unset" }
          : { kind: "value", value: values.value },
      provenance: { kind: "computed" },
    },
  };
}

describe("canonical field reads", () => {
  it("binds a scoped projection only to the publication it folded", () => {
    const schema = withFieldEnvelopes(
      z.object({
        id: z.string(),
        linkState: z.string().nullable(),
        storedProjectionVersions: z
          .record(z.string(), z.string().nullable())
          .optional(),
      }),
      { linkState: null },
    );
    const root = cached({
      value: { linkState: "linked", facts: [], purchaseLinks: [] },
    });
    const read = (revision: string | null) =>
      publicFieldEnvelopeRow(
        schema,
        "email",
        {
          id: "EML-EXAMPLE",
          linkState: "suggested",
          storedProjectionVersions: { linkState: revision },
        },
        {
          raw: {},
          ownership: {},
          stored: new Map([["relationshipFacts", root]]),
        },
      );
    const matching = read(root.computedAt);
    expect(matching.fields.linkState.result).toMatchObject({
      kind: "cached",
      computedAt: root.computedAt,
      decision: { outcome: { kind: "value", value: "suggested" } },
    });
    expect(matching).not.toHaveProperty("storedProjectionVersions");
    expect(read("2026-10-24T20:00:00Z").fields.linkState.result).toEqual({
      kind: "missing",
    });
    expect(read(null).fields.linkState.result).toEqual({ kind: "missing" });
  });

  it("projects one published revision without turning null, zero or missing into each other", () => {
    const schema = withFieldEnvelopes(
      z.object({
        id: z.string(),
        eventCount: z.number().nullable(),
        firstEventDate: z.string().nullable(),
      }),
      { eventCount: null, firstEventDate: null },
    );
    const published = cached({
      value: { eventCount: 0, firstEventDate: null },
    });
    const row = publicFieldEnvelopeRow(
      schema,
      "shipment",
      {
        id: "SHIP-EXAMPLE",
        eventCount: 99,
        firstEventDate: "2026-01-01",
      },
      {
        raw: {},
        stored: new Map([["eventSummary", published]]),
        ownership: {},
      },
    );
    expect(row.fields.eventCount.result).toMatchObject({
      kind: "cached",
      freshness: "stale",
      computedAt: published.computedAt,
      decision: { outcome: { kind: "value", value: 0 } },
    });
    expect(row.fields.firstEventDate.result).toMatchObject({
      kind: "cached",
      freshness: "stale",
      computedAt: published.computedAt,
      decision: { outcome: { kind: "empty", reason: "unset" } },
    });
    const missing = publicFieldEnvelopeRow(
      schema,
      "shipment",
      {
        id: "SHIP-EXAMPLE",
        eventCount: 99,
        firstEventDate: "2026-01-01",
      },
      {
        raw: {},
        stored: new Map([["eventSummary", { ...published, value: {} }]]),
        ownership: {},
      },
    );
    expect(missing.fields.eventCount.result).toEqual({ kind: "missing" });
    expect(missing.fields.firstEventDate.result).toEqual({ kind: "missing" });
  });
  it("keeps an expired publication stale while no work is queued", () => {
    const schema = withFieldEnvelopes(
      z.object({ id: z.string(), eventCount: z.number().nullable() }),
      { eventCount: null },
    );
    const row = publicFieldEnvelopeRow(
      schema,
      "shipment",
      { id: "SHIP-EXAMPLE", eventCount: null },
      {
        raw: {},
        ownership: {},
        stored: new Map([
          [
            "eventSummary",
            { ...cached({ value: { eventCount: 0 } }), pending: false },
          ],
        ]),
      },
    );
    expect(row.fields.eventCount.result).toMatchObject({
      kind: "cached",
      freshness: "stale",
    });
    expect(row.fields.eventCount.work).toEqual({ kind: "idle" });
  });

  it("uses the current classifier for action eligibility instead of the hydrated row", () => {
    const schema = withFieldEnvelopes(
      z.object({ id: z.string(), spendingCategoryId: z.string().nullable() }),
      { spendingCategoryId: z.string().nullable() },
    );
    const row = publicFieldEnvelopeRow(
      schema,
      "expense",
      {
        id: "EXP-EXAMPLE",
        lineKind: "principal",
        spendingCategoryId: "SC-OLD",
      },
      {
        raw: { lineKind: "unclassified", spendingCategoryId: null },
        stored: new Map(),
        ownership: {},
      },
    );
    expect(row.fields.spendingCategoryId.current.controls).toEqual({
      kind: "readonly",
      reason: "not_allowed",
    });
    expect(row.fields.spendingCategoryId.result).toMatchObject({
      kind: "live",
      decision: { outcome: { kind: "empty", reason: "not_applicable" } },
    });
  });

  it("uses authoritative saved scalars before a hydrated value or older resolution", () => {
    const schema = withFieldEnvelopes(
      z.object({ id: z.string(), price: z.number().nullable() }),
      { price: z.number().nullable() },
    );
    const row = publicFieldEnvelopeRow(
      schema,
      "product",
      {
        id: "PRD-EXAMPLE",
        price: 99,
        fieldResolutions: {
          price: {
            mode: "explicit",
            storedValue: 99,
            value: 99,
            fallbackValue: null,
            source: "Own",
            sourceEntity: null,
            matchesFallback: false,
            canReset: true,
          },
        },
      },
      { raw: { price: 2 }, stored: new Map(), ownership: {} },
    );
    expect(row.fields.price.current.assignment).toMatchObject({
      kind: "value",
      value: 2,
    });
    expect(row.fields.price.result).toMatchObject({
      kind: "live",
      decision: { outcome: { value: 2 } },
    });
  });

  it("uses the declared stored snapshot key with its provenance, freshness and failed work", () => {
    const schema = withFieldEnvelopes(
      z.object({ id: z.string(), valuation: z.number().nullable() }),
      { valuation: null },
    );
    const snapshot = {
      ...cached({ value: 12 }),
      error: "Synthetic valuation refresh failure",
    };
    const row = publicFieldEnvelopeRow(
      schema,
      "location",
      { id: "LOC-EXAMPLE", valuation: 99 },
      {
        raw: {},
        stored: new Map([["valuationRollup", snapshot]]),
        ownership: {},
      },
    );
    expect(row.fields.valuation.result).toEqual({
      kind: "cached",
      decision: snapshot.decision,
      computedAt: snapshot.computedAt,
      freshness: "stale",
    });
    expect(row.fields.valuation.work).toMatchObject({
      kind: "failed",
      error: snapshot.error,
    });
    expect(snapshot.value).toBe(12);
  });

  it("projects physical Cost from selected price when price is omitted, including reset and refresh failure", () => {
    const schema = withFieldEnvelopes(
      z.object({
        id: z.string(),
        cost: z
          .object({ kind: z.literal("item"), amount: z.number() })
          .nullable(),
      }),
      { cost: null },
    );
    const costOnly = (price: number | null, snapshot: StoredDerivedRead) =>
      publicFieldEnvelopeRow(
        schema,
        "product",
        {
          id: "PRD-EXAMPLE",
          price: 99,
          cost: { kind: "item", amount: 99 },
        },
        {
          raw: { price },
          stored: new Map([["price", snapshot]]),
          ownership: {},
        },
      );
    const snapshot = {
      ...cached({ value: 8 }),
      error: "Synthetic price refresh failure",
    };
    const own = costOnly(12, snapshot);
    expect(own.fields.cost.result).toMatchObject({
      kind: "live",
      decision: {
        outcome: { kind: "value", value: { kind: "item", amount: 12 } },
        provenance: { kind: "own" },
      },
    });
    expect(own.fields).not.toHaveProperty("price");
    const inherited = costOnly(null, snapshot);
    expect(inherited.fields.cost.result).toMatchObject({
      kind: "cached",
      freshness: "stale",
      computedAt: snapshot.computedAt,
      decision: {
        outcome: { kind: "value", value: { kind: "item", amount: 8 } },
        provenance: { kind: "computed" },
      },
    });
    expect(inherited.fields.cost.work).toMatchObject({
      kind: "failed",
      error: snapshot.error,
    });
    const reset = costOnly(
      null,
      cached({
        value: 99,
        decision: {
          outcome: { kind: "value", value: 99 },
          provenance: { kind: "own", ownership: { kind: "record" } },
        },
      }),
    );
    expect(reset.fields.cost.result).toEqual({ kind: "missing" });
  });

  it("withholds unknown historical provenance after reset without inventing work", () => {
    const read = {
      ...cached({
        value: "LPY-REMOVED",
        decision: {
          outcome: { kind: "value", value: "LPY-REMOVED" },
          provenance: null,
        },
      }),
      stale: false,
    };
    const row = buildFieldEnvelopeRow({
      schema: assigneeRead,
      entity: "project",
      row: { id: "PRJ-EXAMPLE", assigneeId: "LPY-REMOVED" },
      currentAssignments: { assigneeId: { kind: "inherit" } },
      stored: new Map([["assigneeId", read]]),
    });
    expect(row.fields.assigneeId.result).toEqual({ kind: "missing" });
    expect(row.fields.assigneeId.work).toEqual({ kind: "idle" });
    expect(read.value).toBe("LPY-REMOVED");
  });

  it("preserves explicit None from stored mode facts omitted by hydration", () => {
    const row = publicFieldEnvelopeRow(
      assigneeRead,
      "project",
      {
        id: "PRJ-EXAMPLE",
        assigneeId: null,
        fieldResolutions: {
          assigneeId: {
            mode: "none",
            storedValue: null,
            value: null,
            fallbackValue: "LPY-FALLBACK",
            source: "Own",
            sourceEntity: null,
            matchesFallback: false,
            canReset: true,
          },
        },
      },
      {
        raw: { assigneeMode: "explicit", assigneeId: null },
        stored: new Map(),
        ownership: {},
      },
    );
    expect(row.fields.assigneeId.current.assignment).toEqual({ kind: "none" });
    expect(row.fields.assigneeId.result).toMatchObject({
      kind: "live",
      decision: { outcome: { kind: "empty", reason: "explicit_none" } },
    });
  });

  it("removes a reset override before its cached publication is invalidated", () => {
    const read = {
      ...cached({
        value: "LPY-REMOVED",
        decision: {
          outcome: { kind: "value", value: "LPY-REMOVED" },
          provenance: { kind: "own", ownership: { kind: "record" } },
        },
      }),
      stale: false,
    };
    const row = buildFieldEnvelopeRow({
      schema: assigneeRead,
      entity: "project",
      row: { id: "PRJ-EXAMPLE", assigneeId: "LPY-REMOVED" },
      currentAssignments: { assigneeId: { kind: "inherit" } },
      stored: new Map([["assigneeId", read]]),
    });
    expect(row.fields.assigneeId.result).toEqual({ kind: "missing" });
    expect(row.fields.assigneeId.current.assignment).toEqual({
      kind: "inherit",
    });
  });

  it("shows a saved own choice immediately without relabeling a cached result", () => {
    const row = buildFieldEnvelopeRow({
      schema: assigneeRead,
      entity: "project",
      row: { id: "PRJ-EXAMPLE", assigneeId: "LPY-SAVED" },
      currentAssignments: {
        assigneeId: {
          kind: "value",
          value: "LPY-SAVED",
          ownership: { kind: "record" },
        },
      },
      stored: new Map([["assigneeId", cached({ value: "LPY-PREVIOUS" })]]),
    });
    expect(row.fields.assigneeId).toMatchObject({
      current: { assignment: { kind: "value", value: "LPY-SAVED" } },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "value", value: "LPY-SAVED" },
          provenance: { kind: "own", ownership: { kind: "record" } },
        },
      },
    });
    expect(row).not.toHaveProperty("assigneeId");
    expect(row).not.toHaveProperty("fieldResolutions");
    expect(row).not.toHaveProperty("derived");
  });

  it("keeps explicit None distinct from a missing first computation failure", () => {
    const failed: StoredDerivedRead = {
      value: null,
      resultExists: false,
      stale: true,
      retryAt: "2026-10-25T20:01:00Z",
      computedAt: null,
      error: "Synthetic computation failure",
    };
    const base = {
      schema: assigneeRead,
      entity: "project",
      row: { id: "PRJ-EXAMPLE", assigneeId: null },
      stored: new Map([["assigneeId", failed]]),
    } as const;
    const missing = buildFieldEnvelopeRow(base);
    expect(missing.fields.assigneeId.result).toEqual({ kind: "missing" });
    expect(missing.fields.assigneeId.work).toEqual({
      kind: "failed",
      error: "Synthetic computation failure",
      retryAt: "2026-10-25T20:01:00Z",
    });
    const none = buildFieldEnvelopeRow({
      ...base,
      currentAssignments: { assigneeId: { kind: "none" } },
    });
    expect(none.fields.assigneeId.result).toMatchObject({
      kind: "live",
      decision: { outcome: { kind: "empty", reason: "explicit_none" } },
    });
  });

  it("retains the saved baseline while allocation decides a mixed outcome", () => {
    const schema = withFieldEnvelopes(
      z.object({ id: z.string(), costType: z.string().nullable() }),
      { costType: z.enum(["labor", "material"]) },
    );
    const row = buildFieldEnvelopeRow({
      schema,
      entity: "expense",
      row: { id: "EXP-EXAMPLE", costType: null },
      resolutions: {
        costType: {
          mode: "allocated",
          storedValue: "labor",
          value: null,
          emptyReason: "mixed",
          fallbackValue: null,
          source: "Allocated",
          sourceEntity: null,
          matchesFallback: false,
          canReset: false,
        },
      },
    });
    expect(row.fields.costType).toMatchObject({
      current: {
        assignment: { kind: "value", value: "labor" },
        controls: { kind: "readonly", reason: "allocated" },
      },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "empty", reason: "mixed" },
          provenance: { kind: "allocated" },
        },
      },
    });
  });

  it("withholds a stale fallback without disabling an allowed reset", () => {
    const row = buildFieldEnvelopeRow({
      schema: assigneeRead,
      entity: "project",
      row: { id: "PRJ-EXAMPLE", assigneeId: "LPY-SAVED" },
      resolutions: {
        assigneeId: {
          mode: "explicit",
          storedValue: "LPY-SAVED",
          value: "LPY-SAVED",
          fallbackValue: "LPY-PREVIOUS",
          source: "Own",
          sourceEntity: null,
          matchesFallback: false,
          canReset: true,
        },
      },
      resetPreviews: {
        assigneeId: {
          kind: "cached",
          decision: {
            outcome: { kind: "value", value: "LPY-PREVIOUS" },
            provenance: { kind: "default", source: null },
          },
          computedAt: "2026-10-25T20:00:00Z",
          freshness: "stale",
        },
      },
    });
    expect(row.fields.assigneeId.current.controls).toMatchObject({
      kind: "editable",
      reset: { kind: "available", preview: { kind: "not_loaded" } },
    });
  });

  it("keeps a failed refresh's old value and historical source together", () => {
    const read = cached({
      value: "LPY-PREVIOUS",
      decision: {
        outcome: { kind: "value", value: "LPY-PREVIOUS" },
        provenance: {
          kind: "inherited",
          source: {
            entityKind: "project",
            entityId: "PRJ-PREVIOUS",
            name: "Previous source",
          },
        },
      },
    });
    const failedRead = { ...read, error: "Synthetic refresh failure" };
    const row = buildFieldEnvelopeRow({
      schema: assigneeRead,
      entity: "project",
      row: { id: "PRJ-EXAMPLE", assigneeId: "LPY-CURRENT" },
      currentAssignments: { assigneeId: { kind: "inherit" } },
      decisions: {
        assigneeId: {
          outcome: { kind: "value", value: "LPY-CURRENT" },
          provenance: {
            kind: "inherited",
            source: {
              entityKind: "project",
              entityId: "PRJ-CURRENT",
              name: "Current source",
            },
          },
        },
      },
      stored: new Map([["assigneeId", failedRead]]),
    });
    expect(row.fields.assigneeId.result).toMatchObject({
      kind: "cached",
      freshness: "stale",
      decision: {
        outcome: { value: "LPY-PREVIOUS" },
        provenance: { source: { entityId: "PRJ-PREVIOUS" } },
      },
    });
    expect(row.fields.assigneeId.work).toMatchObject({
      kind: "failed",
      error: "Synthetic refresh failure",
    });
  });
});
