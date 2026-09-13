import { allEntities } from "@cubby/schemas/entity-manifest";
import { describe, expect, it } from "vitest";

import { ENTITY_NATIVE_COVERAGE } from "~/lib/generated/entity-native-coverage.gen";
import { HTTP_RESOURCES } from "~/lib/generated/http-resources.gen";

/**
 * The native client is a filtered view of the web API: it can never carry a
 * resource verb the HTTP document does not expose, and image attach/reorder
 * only exist through an update route. Both artifacts are written by
 * `generate-http-openapi.ts`, so this guards that script's two emits agree.
 */
describe("native coverage", () => {
  it.each(allEntities)(
    "%s: native verbs are a subset of HTTP verbs",
    (entity) => {
      // SAFETY: `HTTP_RESOURCES` is `satisfies Partial<Record<Entity, …>>`; an
      // entity without a resource has no entry.
      const resource = (
        HTTP_RESOURCES as Partial<
          Record<typeof entity, { verbs: readonly string[] }>
        >
      )[entity];
      const exposed = new Set(resource?.verbs ?? []);
      const unexposed = ENTITY_NATIVE_COVERAGE[entity].httpActions.filter(
        (action) => !exposed.has(action),
      );
      expect(unexposed).toEqual([]);
    },
  );

  it.each(allEntities)(
    "%s: image attach/reorder need an update route",
    (entity) => {
      const coverage = ENTITY_NATIVE_COVERAGE[entity];
      const needsUpdate = coverage.imageAttach || coverage.imageOrder;
      expect(!needsUpdate || coverage.httpActions.includes("update")).toBe(
        true,
      );
    },
  );
});
