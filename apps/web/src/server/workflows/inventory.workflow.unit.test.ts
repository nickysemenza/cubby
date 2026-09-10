import { describe, expect, it } from "vitest";

import { startOperationDefinitionFor } from "~/lib/start-operation-observability";

import * as inventory from "./inventory.server";

describe("inventory workflow ownership", () => {
  it("exposes every inventory operation under its public identity", () => {
    for (const operation of Object.values(inventory)) {
      expect(
        startOperationDefinitionFor(operation.definition.name),
      ).toBeDefined();
    }
  });
});
