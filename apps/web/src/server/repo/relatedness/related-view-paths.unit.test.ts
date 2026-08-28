import { entityManifest } from "@cubby/schemas/entity-manifest";
import {
  relatedViewPath,
  relatedViewRegistry,
} from "@cubby/schemas/related-view";
import { describe, expect, it } from "vitest";

import { compileTraversal } from "./traversal";

describe("related view traversal paths", () => {
  it("compiles every curated view from its source to its declared target", () => {
    for (const view of relatedViewRegistry) {
      const path = relatedViewPath(view);
      const traversal = compileTraversal(view.source, path, "related");
      expect(traversal.rootTable, view.key).toBe(
        entityManifest[view.source].dbTable,
      );
      expect(traversal.leafTable, view.key).toBe(
        entityManifest[view.target].dbTable,
      );
      expect(traversal.hops).toHaveLength(path.length);
    }
  });
});
