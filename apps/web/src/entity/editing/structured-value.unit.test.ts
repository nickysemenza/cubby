import { structuredValueSchemas } from "@cubby/schemas/structured-value-schemas";
import vectorFile from "@cubby/shared/golden-vectors/structured-roundtrip.json";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  blank,
  blankCase,
  isDrawn,
  project,
  wireValue,
} from "./structured-value";

const vectors = z
  .array(
    z.object({
      entity: z.string(),
      field: z.string(),
      read: z.json(),
      input: z.json(),
    }),
  )
  .parse(vectorFile.vectors);

const schemaFor = (id: string) => {
  const schema = Object.entries(structuredValueSchemas).find(
    ([key]) => key === id,
  )?.[1];
  if (schema === undefined) throw new Error(`no schema for ${id}`);
  return schema;
};

describe("structured value", () => {
  it.each(vectors.map((vector) => `${vector.entity}.${vector.field}`))(
    "%s: an untouched read goes back as exactly the vector input",
    (id) => {
      const vector = vectors.find(
        (candidate) => `${candidate.entity}.${candidate.field}` === id,
      );
      const schema = schemaFor(id);
      expect(wireValue(project(vector?.read ?? null, schema), schema)).toEqual(
        vector?.input,
      );
    },
  );

  it("keeps a claim's identity key through the round trip and never draws it", () => {
    const schema = schemaFor("expense.sourceClaims");
    const [claim] = z.array(z.record(z.string(), z.json())).parse(
      project(
        [
          {
            source: "synthetic-provider",
            sourceKey: "v1:abc",
            sourceKeyVersion: 1,
            targetAmountAtClaim: 10,
            normalizedEvidence: { amount: 10 },
            reconciliation: { decision: "amounts_match" },
          },
        ],
        schema,
      ),
    );
    expect(claim).toMatchObject({
      source: "synthetic-provider",
      sourceKey: "v1:abc",
    });
    expect(claim).not.toHaveProperty("sourceKeyVersion");
    expect(
      isDrawn({ nullable: false, node: { text: { format: "opaque" } } }),
    ).toBe(false);
  });

  it("starts an account identity with no case chosen instead of a default kind", () => {
    const identity = schemaFor("financialAccount.identity");
    expect(blank(identity)).toBeNull();
    // Required, so an unchosen identity is still sent as `null` for the server to reject.
    expect(wireValue(blank(identity), identity)).toBeNull();
    const node = identity.node;
    if (!("variant" in node)) throw new Error("identity is not a variant");
    const cash = node.variant.cases.find(
      (candidate) => candidate.value === "cash",
    );
    expect(
      blankCase(node.variant.discriminator, cash ?? { value: "", fields: [] }),
    ).toEqual({
      kind: "cash",
    });
  });

  it("leaves an unfilled optional claim field out and clears a range end", () => {
    const schema = schemaFor("recipe.yield");
    expect(
      wireValue({ value: 2, unit: "cups", upperValue: null }, schema),
    ).toEqual({
      value: 2,
      unit: "cups",
    });
    expect(wireValue({ value: null, unit: "" }, schema)).toBeNull();
  });
});
