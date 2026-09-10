import { describe, expect, it } from "vitest";

import {
  cleanupOrphanedEmbeddingsWorkflow,
  deleteUnusedIngredientsWorkflow,
} from "./problems.server";

describe("problems workflow ownership", () => {
  it("declares cleanup as a committed maintenance operation", () => {
    expect(cleanupOrphanedEmbeddingsWorkflow.definition).toMatchObject({
      name: "problems.cleanupOrphanedEmbeddings",
      steps: [{ name: "cleaned", type: "committedCall" }],
    });
  });

  it("keeps delete resolution and presentation around the committed service", () => {
    expect(deleteUnusedIngredientsWorkflow.definition).toMatchObject({
      name: "problems.deleteUnused",
      steps: [
        { name: "shortcodes", type: "call" },
        { name: "entityIds", type: "call" },
        { name: "deleted", type: "committedCall" },
        { name: "presented", type: "call" },
      ],
    });
  });
});
