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
        // The Problems page's own fixes bypass runMutationSideEffects, so the
        // badge dirty-mark is an explicit post-commit effect here.
        { name: "badge", type: "committedEffect" },
        { name: "presented", type: "call" },
      ],
    });
  });
});
