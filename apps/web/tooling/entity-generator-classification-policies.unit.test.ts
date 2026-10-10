import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import { validateClassificationPolicies } from "../../../scripts/generator/entities/classification-policies";
import type { CompiledEntity } from "../../../scripts/generator/entities/declarations";

type Policy = CompiledEntity["classificationPolicies"][number];
type FieldPolicy = Omit<Policy["fields"][number], "relation"> & {
  relation?: boolean;
};

// The validator reads only keys, field rosters, enum options and policies.
const entities = (fields: FieldPolicy[], classifier = "kind") => [
  fromPartial<CompiledEntity>({
    key: "shelfKind",
    fieldModel: {
      fields: [
        {
          key: "kind",
          control: {
            kind: "select",
            options: [
              { value: "pantry", label: "Pantry" },
              { value: "library", label: "Library" },
            ],
          },
        },
      ],
    },
    classificationPolicies: [
      {
        classifier,
        target: { entity: "item", reference: "shelfKindId" },
        fields: fields.map((field) => ({ relation: false, ...field })),
      },
    ],
  }),
  fromPartial<CompiledEntity>({
    key: "item",
    fieldModel: {
      fields: [
        {
          key: "shelfKindId",
          reference: { entity: "shelfKind", multiple: false },
        },
        { key: "recipeId" },
        { key: "isbn" },
      ],
    },
    classificationPolicies: [],
  }),
];

// Failure modes: a policy names a field the classified entity does not have
// (the evaluator silently answers `unknown`); a value the classifier cannot
// hold (a typo never matches); a classifier that is not an enum; a target that
// does not reference the owner; a refused-by-default field two values admit
// (the implied classification becomes order-dependent) or none admits (the
// field could never be written).
describe("classification policy declarations", () => {
  it("accepts a field admitted by exactly one classifier value", () => {
    expect(() =>
      validateClassificationPolicies(
        entities([
          {
            field: "recipeId",
            byValue: { pantry: "unknown" },
            otherwise: "not_allowed",
          },
          {
            field: "isbn",
            byValue: { library: "required" },
            otherwise: "unknown",
          },
        ]),
      ),
    ).not.toThrow();
  });

  it.each([
    [
      { field: "missing", byValue: {}, otherwise: "unknown" },
      /not a field of item/,
    ],
    [
      { field: "isbn", byValue: { garage: "required" }, otherwise: "unknown" },
      /garage is not a kind value/,
    ],
    [
      {
        field: "recipeId",
        byValue: { pantry: "unknown", library: "required" },
        otherwise: "not_allowed",
      },
      /exactly one admitting value/,
    ],
    [
      { field: "recipeId", byValue: {}, otherwise: "not_allowed" },
      /exactly one admitting value/,
    ],
  ] satisfies [FieldPolicy, RegExp][])(
    "rejects an unsound field policy",
    (policy, message) => {
      expect(() => validateClassificationPolicies(entities([policy]))).toThrow(
        message,
      );
    },
  );

  it("lets a relation entry admit several values but not name a field", () => {
    expect(() =>
      validateClassificationPolicies(
        entities([
          {
            field: "shelvedOn",
            relation: true,
            byValue: { pantry: "unknown", library: "unknown" },
            otherwise: "not_allowed",
          },
        ]),
      ),
    ).not.toThrow();
    expect(() =>
      validateClassificationPolicies(
        entities([
          { field: "isbn", relation: true, byValue: {}, otherwise: "unknown" },
        ]),
      ),
    ).toThrow(/drop `relation`/);
  });

  it("rejects a classifier without enum options", () => {
    expect(() =>
      validateClassificationPolicies(
        entities(
          [{ field: "isbn", byValue: {}, otherwise: "unknown" }],
          "missing",
        ),
      ),
    ).toThrow(/enum field/);
  });
});
