import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { describe, expect, it } from "vitest";

import { actionVerbs } from "~/app/_components/actions/action-verbs";
import { entityActionCatalogDescriptors } from "~/app/_components/actions/entity-actions";
import type { GenericDetailEntity } from "~/app/_components/entity-detail/detail-record";
import { detailEntities } from "~/entities/generated/entity-details.gen";

import { detailFieldRenderersFor } from "./detail-field-renderers";

// SAFETY: `entitySummary` is the closed per-entity roster; its keys are
// entity keys.
const entities = Object.keys(entitySummary) as Array<
  keyof typeof entitySummary
>;

/**
 * `edit` is the detail page's own affordance (the hero button and the
 * generic dialog), and a list's `delete` comes from the list contract's own
 * bulk action — neither is a registry verb.
 */
const PAGE_OWNED_DETAIL_VERBS = new Set(["edit"]);
const LIST_CONTRACT_VERBS = new Set(["delete"]);

const covers = (verb: string, entity: string, surfaces: readonly string[]) =>
  entityActionCatalogDescriptors.some(
    (definition) =>
      definition.verb === verb &&
      definition.entities.some((candidate) => candidate === entity) &&
      surfaces.some((surface) =>
        definition.surfaces.some((candidate) => candidate === surface),
      ),
  );

describe("manifest registries", () => {
  it("preserves explicit sentence-case labels for derived garden windows", () => {
    const labels = Object.fromEntries(
      entityFieldModels.ingredient.fields.map((field) => [
        field.key,
        field.label,
      ]),
    );
    expect(labels.guideSowWindow).toBe("Guide sow window");
    expect(labels.guideTransplantWindow).toBe("Guide transplant window");
  });

  it("names only registered verbs in every detail hero and list action roster", () => {
    const unknown = entities.flatMap((entity) => {
      const { detail, list } = entitySummary[entity];
      return [...detail.hero.actions, ...list.actions]
        .filter(
          (verb) =>
            !PAGE_OWNED_DETAIL_VERBS.has(verb) && !(verb in actionVerbs),
        )
        .map((verb) => `${entity}.${verb}`);
    });
    expect(unknown).toEqual([]);
  });

  it("has a registry definition for every declared hero verb on the detail surface", () => {
    const uncovered = entities.flatMap((entity) =>
      entitySummary[entity].detail.hero.actions
        .filter(
          (verb) =>
            !PAGE_OWNED_DETAIL_VERBS.has(verb) &&
            !covers(verb, entity, ["detail"]),
        )
        .map((verb) => `${entity}.${verb}`),
    );
    expect(uncovered).toEqual([]);
  });

  it("has a registry definition for every declared list verb on a list surface", () => {
    const uncovered = entities.flatMap((entity) =>
      entitySummary[entity].list.actions
        .filter(
          (verb) =>
            !LIST_CONTRACT_VERBS.has(verb) &&
            !covers(verb, entity, ["row", "selection"]),
        )
        .map((verb) => `${entity}.${verb}`),
    );
    expect(uncovered).toEqual([]);
  });

  // A structured detail field with no domain renderer falls back to readable
  // JSON. That never crashes, but it is a page showing a raw payload — so a
  // new json field has to be claimed here (by a renderer, a reference or a
  // declared format) rather than land on the page unnoticed.
  it("renders every structured detail field through a renderer, a reference or a declared format", () => {
    const generic: readonly GenericDetailEntity[] = [
      ...detailEntities,
      "image",
      "cookbook",
    ];
    const unclaimed = generic.flatMap((entity) => {
      const placed = new Set<string>(
        entitySummary[entity].detail.sections.flatMap((section) =>
          section.kind === "fields" ? section.fields : [],
        ),
      );
      return entityFieldModels[entity].fields
        .filter(
          (field) =>
            placed.has(field.key) &&
            field.kind === "json" &&
            field.reference === null &&
            field.display.format === null &&
            detailFieldRenderersFor(entity)?.[field.key] === undefined,
        )
        .map((field) => `${entity}.${field.key}`);
    });
    expect(unclaimed).toEqual([]);
  });
});
