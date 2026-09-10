import { describe, expect, it } from "vitest";

import { startOperationDefinitionFor } from "~/lib/start-operation-observability";

import * as recipes from "./recipe.server";

describe("recipe workflow ownership", () => {
  it("registers each non-streaming export under its public operation identity", () => {
    for (const [name, operation] of Object.entries(recipes)) {
      if (!("definition" in operation))
        throw new Error(`${name} has no executable definition`);
      expect(
        startOperationDefinitionFor(operation.definition.name),
      ).toBeDefined();
    }
  });
});
