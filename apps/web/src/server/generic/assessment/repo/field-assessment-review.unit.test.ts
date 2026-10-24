import { expect, it } from "vitest";

import { fieldCorrectionIdentity } from "./field-assessment-review";

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
