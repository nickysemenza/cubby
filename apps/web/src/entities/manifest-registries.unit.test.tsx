import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { describe, expect, it } from "vitest";

import { actionVerbs } from "~/app/_components/actions/action-verbs";
import { entityActionCatalogDescriptors } from "~/app/_components/actions/entity-actions";
import type { GenericDetailEntity } from "~/app/_components/entity-detail/detail-record";
import { detailSlots } from "~/app/_components/entity-detail/detail-slots";
import { listSlotCoverage } from "~/app/_components/entity-list/list-slots";
import { detailEntities } from "~/entities/generated/entity-details.gen";
import { entityOverrideComparisons } from "~/entities/generated/entity-override-comparisons.gen";

import {
  detailFieldRenderersFor,
  detailRendererCoverage,
} from "./detail-field-renderers";
import { controlRendererCoverage } from "./editing/entity-primitive-fields";
import { listRendererCoverage } from "./list-field-renderers";

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
  it("covers every declared renderer and slot with an explicit platform disposition", () => {
    type Disposition = { kind: string; reason?: string };
    type NestedDispositionRegistry = Readonly<
      Record<string, Readonly<Record<string, Disposition>> | undefined>
    >;
    const controls: Readonly<Record<string, Disposition>> =
      controlRendererCoverage;
    const nested = (
      registry: NestedDispositionRegistry,
      entity: string,
      id: string,
    ) => registry[entity]?.[id];
    const missing: string[] = [];
    const unsupportedWithoutReason: string[] = [];
    const inspect = (label: string, disposition: Disposition | undefined) => {
      if (!disposition) missing.push(label);
      if (disposition?.kind === "unsupported" && !disposition.reason?.trim()) {
        unsupportedWithoutReason.push(label);
      }
    };

    for (const entity of entities) {
      for (const field of entityFieldModels[entity].fields) {
        const control = field.control?.renderer;
        if (control) {
          inspect(`control:${control}`, controls[control]);
        }
        const list = field.display.renderer?.list;
        if (list) {
          inspect(
            `list:${entity}.${field.key}:${list}`,
            nested(listRendererCoverage, entity, list),
          );
        }
        const detail = field.display.renderer?.detail;
        if (detail) {
          inspect(
            `detail:${entity}.${field.key}:${detail}`,
            nested(detailRendererCoverage, entity, detail),
          );
        }
      }
      for (const section of entitySummary[entity].detail.sections) {
        if (section.kind === "slot") {
          inspect(
            `detail-slot:${entity}.${section.id}`,
            nested(detailSlots, entity, section.id),
          );
        }
      }
      for (const view of entitySummary[entity].list.views) {
        if (view !== "table" && view !== "shelf" && view !== "timeline") {
          inspect(
            `list-slot:${entity}.${view.id}`,
            nested(listSlotCoverage, entity, view.id),
          );
        }
      }
    }

    expect(missing).toEqual([]);
    expect(unsupportedWithoutReason).toEqual([]);
  });

  it("preserves explicit sentence-case labels for derived garden windows", () => {
    const labels = Object.fromEntries(
      entityFieldModels.plant.fields.map((field) => [field.key, field.label]),
    );
    expect(labels.guideSowWindow).toBe("Guide sow window");
    expect(labels.guideTransplantWindow).toBe("Guide transplant window");
  });

  it("infers shared identifier labels and explains invalid relation defaults", () => {
    const labelsFor = (entity: "product" | "usda-food") =>
      Object.fromEntries(
        entityFieldModels[entity].fields.map((field) => [
          field.key,
          field.label,
        ]),
      );
    expect(labelsFor("product").fdc_id).toBe("FDC ID");
    expect(labelsFor("usda-food").fdc_id).toBe("FDC ID");
    expect(labelsFor("product").isbn).toBe("ISBN");

    const comparison = entityOverrideComparisons.product.find(
      (item) => item.path === "presentation.detail.relationFilterOverrides",
    );
    expect(comparison).toMatchObject({ status: "invalid", without: null });
    expect(comparison?.reason).toContain("renders no detail table");
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
      "run",
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
