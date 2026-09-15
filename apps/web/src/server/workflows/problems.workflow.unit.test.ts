import { describe, expect, it } from "vitest";

import { deleteUnusedIngredientsWorkflow } from "./problems.server";

describe("problems workflow ownership", () => {
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
