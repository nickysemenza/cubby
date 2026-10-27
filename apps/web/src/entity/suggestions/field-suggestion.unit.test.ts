import { fieldSuggestionResolutionContext } from "@cubby/schemas/field-suggestion";
import { describe, expect, it } from "vitest";

import { basisValueOf, suggestionRecordFieldValue } from "./field-suggestion";

it("distinguishes deferred intent-only references from loaded empty projections", () => {
  expect(
    suggestionRecordFieldValue("product", {}, "ingredientId"),
  ).toBeUndefined();
  expect(
    suggestionRecordFieldValue("product", { ingredient: null }, "ingredientId"),
  ).toBeNull();
  expect(
    suggestionRecordFieldValue(
      "product",
      { ingredient: { id: "ING-2222" } },
      "ingredientId",
    ),
  ).toBe("ING-2222");
  expect(
    suggestionRecordFieldValue(
      "product",
      { categoryId: "CAT-2222" },
      "categoryId",
    ),
  ).toBeUndefined();
});

describe("structured suggestion basis", () => {
  it("serializes owned JSON objects without losing existing picker-id semantics", () => {
    const identity = { kind: "credit_card", network: "visa" };
    expect(basisValueOf(identity)).toBe(JSON.stringify(identity));
    expect(basisValueOf({ id: "chosen", label: "Chosen" })).toBe("chosen");
    expect(basisValueOf({ invalid: undefined })).toBeNull();
    const history = [
      { validFrom: "2026-01-01", validTo: null, note: "Synthetic history" },
    ];
    expect(basisValueOf(history)).toBe(JSON.stringify(history));
    expect(basisValueOf(["one", "two"])).toBe('["one","two"]');
  });
});

it("keeps suggestion evidence stable through refresh metadata changes but detects value and intent changes", () => {
  const decision = {
    outcome: { kind: "value", value: "Synthetic brand" },
    provenance: { kind: "computed" },
  };
  const current = {
    assignment: null,
    controls: { kind: "readonly", reason: "computed" },
  };
  const before = {
    current,
    result: {
      kind: "cached",
      decision,
      computedAt: "2026-01-01T00:00:00Z",
      freshness: "fresh",
    },
    work: { kind: "idle" },
  };
  const after = {
    ...before,
    current: {
      ...current,
      controls: { kind: "readonly", reason: "not_allowed" },
    },
    result: {
      ...before.result,
      computedAt: "2026-01-02T00:00:00Z",
      freshness: "stale",
    },
    work: { kind: "failed", error: "Synthetic refresh failure", retryAt: null },
  };
  const context = <T extends object>(field: T) =>
    fieldSuggestionResolutionContext({ brandName: field }, ["brandName"]);
  expect(context(before)).not.toBeNull();
  expect(context(after)).toBe(context(before));
  expect(context({ ...after, result: { kind: "missing" } })).not.toBe(
    context(before),
  );
  expect(
    context({
      ...after,
      current: { ...current, assignment: { kind: "none" } },
    }),
  ).not.toBe(context(before));
  expect(
    context({
      ...after,
      result: {
        ...after.result,
        decision: {
          ...decision,
          outcome: { kind: "value", value: "Changed brand" },
        },
      },
    }),
  ).not.toBe(context(before));
});
