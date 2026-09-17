import { allEntities } from "@cubby/schemas/entity-manifest";
import type { Query } from "@tanstack/react-query";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import { entityRipple } from "~/integrations/tanstack-query/cache-tags";
import { matchesTags } from "~/integrations/tanstack-query/operation-cache";

import { entityMedia } from "./entity-media.functions";

describe("entityMedia.displayImages cache coverage", () => {
  const displayImagesQuery = fromPartial<Query>({
    meta: { cacheTags: entityMedia.displayImages.definition.tags },
  });

  it("refreshes after any entity image or fallback relationship changes", () => {
    for (const entity of allEntities) {
      expect(matchesTags(entityRipple(entity))(displayImagesQuery)).toBe(true);
    }
    expect(matchesTags([["relatedData"]])(displayImagesQuery)).toBe(true);
  });
});
