import { expect, it } from "vitest";

import { entityEditValueBagSchema } from "./value-schema";

// A registered but untouched optional text input leaves `key: undefined` inside a nested draft
// object. Rejecting it made the Edit dialog refuse a source-claim description edit with
// "Invalid input at sourceClaims" before any request was sent.
it("drops undefined keys nested in a structured draft value", () => {
  expect(
    entityEditValueBagSchema.parse({
      sourceClaims: [
        { source: "example-provider", providerId: undefined, sourceKey: "k" },
      ],
    }),
  ).toEqual({ sourceClaims: [{ source: "example-provider", sourceKey: "k" }] });
});
