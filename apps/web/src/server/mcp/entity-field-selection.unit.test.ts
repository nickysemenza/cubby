import { describe, expect, it } from "vitest";

import {
  projectSelection,
  readSelection,
  selectionListFields,
} from "./entity-field-selection";

describe("compact media contract", () => {
  it.each([
    { entity: "product", fields: ["itemImageCount", "labelImageCount"] },
    { entity: "vendor", fields: ["logo"] },
    { entity: "purchase", fields: ["vendorLogo"] },
  ])(
    "omits $entity media while retaining explicit field selection",
    ({ entity, fields }) => {
      const compact = readSelection({
        action: "list",
        entity,
        resultDetail: "compact",
      });
      expect(compact?.kind).toBe("compact");
      if (compact?.kind !== "compact")
        throw new Error("Expected compact selection");
      for (const field of fields) expect(compact.keys).not.toContain(field);
      expect(readSelection({ action: "list", entity, fields })).toEqual({
        kind: "fields",
        paths: fields.map((field) => [field]),
      });
    },
  );
});

const locationType = {
  current: {
    assignment: { kind: "value", value: "room", ownership: { kind: "record" } },
    controls: {
      kind: "editable",
      canSetNone: false,
      canConfirm: false,
      reset: { kind: "unavailable" },
    },
  },
  result: {
    kind: "live",
    decision: {
      outcome: { kind: "value", value: "room" },
      provenance: { kind: "own", ownership: { kind: "record" } },
    },
  },
  work: { kind: "idle" },
};

describe("canonical governed-field selection", () => {
  it("allows a Location name-only selected row with an empty governed roster", () => {
    const selection = readSelection({
      action: "list",
      entity: "location",
      fields: ["name"],
    });
    if (!selection) throw new Error("Expected explicit selection");
    expect(selectionListFields("location", selection)).toEqual(["name"]);
    expect(
      projectSelection(
        {
          action: "list",
          entity: "location",
          items: [{ id: "LOC-ABCD", name: "Synthetic cupboard", fields: {} }],
        },
        selection,
      ),
    ).toMatchObject({
      items: [{ id: "LOC-ABCD", name: "Synthetic cupboard" }],
    });
  });

  it("loads a canonical governed key through its flat repository key and validates its complete envelope", () => {
    const selection = readSelection({
      action: "list",
      entity: "location",
      fields: ["fields.type"],
    });
    if (!selection) throw new Error("Expected explicit selection");
    expect(selectionListFields("location", selection)).toEqual(["type"]);
    const result = {
      action: "list",
      entity: "location",
      items: [{ id: "LOC-ABCD", fields: { type: locationType } }],
    };
    expect(projectSelection(result, selection)).toMatchObject({
      items: [{ id: "LOC-ABCD", fields: { type: locationType } }],
    });
    expect(() =>
      projectSelection(
        {
          ...result,
          items: [
            {
              id: "LOC-ABCD",
              fields: { type: { result: locationType.result } },
            },
          ],
        },
        selection,
      ),
    ).toThrow(/current/);
  });

  it("retains complete scalar and structured Cost envelopes in compact reads", () => {
    const productPrice = {
      ...locationType,
      current: {
        ...locationType.current,
        assignment: { kind: "value", value: 12, ownership: { kind: "record" } },
      },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "value", value: 12 },
          provenance: { kind: "own", ownership: { kind: "record" } },
        },
      },
    };
    const productCost = {
      current: {
        assignment: null,
        controls: { kind: "readonly", reason: "computed" },
      },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "value", value: { kind: "item", amount: 12 } },
          provenance: { kind: "own", ownership: { kind: "record" } },
        },
      },
      work: { kind: "idle" },
    };
    for (const [entity, id, fields, expectedKeys] of [
      ["location", "LOC-ABCD", { type: locationType }, ["type"]],
      [
        "product",
        "PRD-ABCD",
        { price: productPrice, cost: productCost },
        ["price", "cost"],
      ],
    ] as const) {
      const selection = readSelection({
        action: "list",
        entity,
        resultDetail: "compact",
      });
      if (selection?.kind !== "compact")
        throw new Error("Expected compact selection");
      for (const key of expectedKeys)
        expect(selection.keys).toContain(`fields.${key}`);
      expect(selectionListFields(entity, selection)).toEqual(
        expect.arrayContaining([...expectedKeys]),
      );
      expect(
        projectSelection(
          { action: "list", entity, items: [{ id, fields }] },
          selection,
        ),
      ).toMatchObject({ items: [{ id, fields }] });
    }
  });
});
