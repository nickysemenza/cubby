import { expect, it } from "vitest";

import {
  fieldCorrectionIdentity,
  proveFieldCorrectionIdentity,
} from "./field-assessment-review";

it("keys corrections by complete ordered decision inputs, not subject or proposed answer", async () => {
  const input = {
    entity: "product",
    field: "categoryId",
    basis: { name: "Synthetic grain" },
    inputs: [
      {
        feature: "field-suggestion",
        promptVersion: "synthetic-v1",
        operation: "suggestFields.product.categoryId",
        model: "synthetic-model",
        fingerprint: "synthetic-complete-request-and-roster",
      },
    ],
    dependencies: [
      {
        feature: "field-suggestion",
        promptVersion: "synthetic-v1",
        generation: 1,
        policyFingerprint: "synthetic-policy",
      },
    ],
  };
  const key = await fieldCorrectionIdentity(input);
  expect(key).not.toBeNull();
  expect(await fieldCorrectionIdentity(structuredClone(input))).toBe(key);
  expect(
    await fieldCorrectionIdentity({ ...input, incomplete: true }),
  ).toBeNull();
  expect(await fieldCorrectionIdentity({ ...input, inputs: [] })).toBeNull();
  expect(
    await fieldCorrectionIdentity({ ...input, dependencies: [] }),
  ).toBeNull();
  expect(
    await fieldCorrectionIdentity({
      ...input,
      inputs: [{ ...input.inputs[0]!, fingerprint: "different-roster" }],
    }),
  ).not.toBe(key);
  expect(
    await fieldCorrectionIdentity({
      ...input,
      dependencies: [{ ...input.dependencies[0]!, generation: 2 }],
    }),
  ).not.toBe(key);
  expect(
    await fieldCorrectionIdentity({
      ...input,
      basis: { name: "Synthetic grain with a different untruncated tail" },
    }),
  ).not.toBe(key);
});

it("normalizes retained raw-v1 evidence only after reproducing its immutable hash", async () => {
  const { sha256Hex } = await import("@cubby/shared/sha256");
  const { canonicalJson } = await import("~/server/lib/canonical-json");
  const dependencies = [
    {
      feature: "field-suggestion",
      promptVersion: "frozen-v1",
      generation: 0,
      policyFingerprint: "frozen-policy",
    },
  ];
  const manifest = { "field-suggestion": dependencies[0]! };
  const inputs = ["first", "second"].map((fingerprint) => ({
    feature: "field-suggestion",
    promptVersion: "frozen-v1",
    operation: "suggestFields.product.categoryId",
    model: "frozen-model",
    fingerprint,
  }));
  const basis = { name: "Synthetic grain", __resolutionContext: "{}" };
  // Independent frozen serializer: changing production normalization must not rewrite this proof.
  const correctionKey = await sha256Hex(
    canonicalJson({
      version: "field-correction-v1",
      entity: "product",
      field: "categoryId",
      basis,
      inputs,
      dependencies,
    }),
  );
  const input = {
    entity: "product",
    field: "categoryId",
    manifest,
    evidence: { correctionKey, basis, inputs },
  };
  const canonicalKey = await fieldCorrectionIdentity({
    ...input,
    basis: { name: "Synthetic grain" },
    inputs,
    dependencies,
  });
  expect(await proveFieldCorrectionIdentity(input)).toEqual({
    storedKey: correctionKey,
    canonicalKey,
    reason: null,
  });
  expect(
    await proveFieldCorrectionIdentity({
      ...input,
      manifest: {
        "field-suggestion": { ...manifest["field-suggestion"], generation: 1 },
      },
    }),
  ).toMatchObject({ canonicalKey: null, reason: "hash_mismatch" });
  expect(
    await proveFieldCorrectionIdentity({
      ...input,
      evidence: { ...input.evidence, inputs: [...inputs].reverse() },
    }),
  ).toMatchObject({ canonicalKey: null, reason: "hash_mismatch" });
  expect(
    await proveFieldCorrectionIdentity({
      ...input,
      evidence: { correctionKey, basis },
    }),
  ).toMatchObject({
    storedKey: correctionKey,
    canonicalKey: null,
    reason: "missing_inputs",
  });
  expect(
    await proveFieldCorrectionIdentity({
      ...input,
      evidence: { ...input.evidence, dependencies },
      manifest: {},
    }),
  ).toMatchObject({ canonicalKey, reason: null });
});
