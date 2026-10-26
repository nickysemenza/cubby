import { describe, expect, it } from "vitest";
import {
  generatedEntityFieldModels,
  type GeneratedEntityFieldModel,
} from "./generated/entity-field-model.gen";
import { entityKeys, entitySummary } from "./generated/entity-summary.gen";
import { isSlotListView } from "./entity-definitions/definition";
import {
  EXPENSE_DISPOSITION_COST_TYPE,
  EXPENSE_DISPOSITION_EDITOR,
} from "./expense-fields";
import {
  COLLECTION_ACTION_SCOPES,
  COLLECTION_ACTIONS,
} from "./entity-definitions/collection-actions";
import { SECTION_ACTION_IDS } from "./entity-section-actions";
import {
  NATIVE_COVERAGE_KINDS,
  nativeCollectionActionPlans,
  nativeCoverage,
  nativeHeroActionPlans,
  type NativeCoverageEntry,
  type NativeCoverageKind,
} from "./native-coverage";

const used = (ids: readonly string[]) => [...new Set(ids)].sort();

type Field = GeneratedEntityFieldModel["fields"][number];
const fieldModels: readonly GeneratedEntityFieldModel[] = Object.values(
  generatedEntityFieldModels,
);
const fieldRenderers = (pick: (field: Field) => string | null | undefined) =>
  used(
    fieldModels.flatMap((model) =>
      model.fields.flatMap((field) => pick(field) ?? []),
    ),
  );

/** The ids the manifest declares today, per kind, spelled as the Swift enums spell them. */
const vocabulary = {
  control: fieldRenderers((field) => field.control?.renderer),
  list: fieldRenderers((field) => field.display.renderer?.list),
  detail: fieldRenderers((field) => field.display.renderer?.detail),
  heroAction: used(
    entityKeys.flatMap((key) => entitySummary[key].detail.hero.actions),
  ),
  detailSlot: used(
    entityKeys.flatMap((key) =>
      entitySummary[key].detail.sections.flatMap((section) =>
        section.kind === "slot" ? [`${key}.${section.id}`] : [],
      ),
    ),
  ),
  listSlot: used(
    entityKeys.flatMap((key) =>
      entitySummary[key].list.views.flatMap((view) =>
        isSlotListView(view) ? [`${key}.${view.id}`] : [],
      ),
    ),
  ),
  structuredField: used(
    Object.entries(generatedEntityFieldModels).flatMap(([entity, model]) =>
      model.fields.flatMap((field) =>
        field.control?.renderer === "structured-field"
          ? [`${entity}.${field.key}`]
          : [],
      ),
    ),
  ),
  sectionAction: [...SECTION_ACTION_IDS].sort(),
} satisfies Record<NativeCoverageKind, readonly string[]>;

const entries = (kind: NativeCoverageKind): [string, NativeCoverageEntry][] =>
  Object.entries<NativeCoverageEntry>(nativeCoverage[kind]);

describe("native presentation coverage", () => {
  it.each(NATIVE_COVERAGE_KINDS)(
    "classifies every declared %s id exactly once",
    (kind) => {
      expect(vocabulary[kind].length).toBeGreaterThan(0);
      expect(used(Object.keys(nativeCoverage[kind]))).toEqual(vocabulary[kind]);
    },
  );

  it("hands off exactly the reviewed ids", () => {
    // Adding a handoff moves a surface to web for native members: review it here.
    const handoffs = NATIVE_COVERAGE_KINDS.flatMap((kind) =>
      entries(kind).flatMap(([id, entry]) =>
        entry.status === "handoff" ? [`${kind} ${id}`] : [],
      ),
    );
    expect(handoffs.sort()).toEqual([
      "detailSlot expense.settlement",
      "detailSlot productCategory.spending-classification",
      "detailSlot purchase.reconciliation",
      "detailSlot run.import-agent-live",
      "detailSlot run.import-agent-stopped",
      "detailSlot vendor.spending-classification",
      "sectionAction linkExpenses",
      "sectionAction linkProducts",
      "sectionAction matchStatement",
      "sectionAction splitExpense",
    ]);
  });

  it("names a declared web section or a route query for every handoff", () => {
    const sectionIds = new Map<string, readonly string[]>(
      entityKeys.map((key) => [
        key,
        entitySummary[key].detail.sections.map((section) => section.id),
      ]),
    );
    const anySection = new Set([...sectionIds.values()].flat());
    const problems = NATIVE_COVERAGE_KINDS.flatMap((kind) =>
      entries(kind).flatMap(([id, entry]) => {
        if (entry.status !== "handoff") return [];
        const { section, query, label } = entry.web;
        const qualified =
          kind === "detailSlot" ||
          kind === "listSlot" ||
          kind === "structuredField";
        const sections = qualified
          ? new Set(sectionIds.get(id.split(".")[0] ?? "") ?? [])
          : anySection;
        const target =
          section === undefined
            ? Object.keys(query ?? {}).length > 0
            : sections.has(section);
        return target && label.trim() !== "" && entry.reason.trim() !== ""
          ? []
          : [`${kind} ${id}`];
      }),
    );
    expect(problems).toEqual([]);
  });

  it("gives exactly the implemented hero actions a runner plan", () => {
    const implemented = entries("heroAction")
      .filter(([, entry]) => entry.status === "implemented")
      .map(([id]) => id);
    expect(used(Object.keys(nativeHeroActionPlans))).toEqual(used(implemented));
  });

  it("requires explicit confirmation for the destructive verbs", () => {
    // Deleting a record and discarding stock must never run on one tap.
    expect(nativeHeroActionPlans.delete.confirmation).toBe("destructive");
    expect(nativeHeroActionPlans.discard.confirmation).toBe("destructive");
  });

  it("runs the quick-action verbs with the shape each needs", () => {
    // Done is one tap with a preset option; Adjust amount asks for the one
    // field; Move to asks for a location and moves the whole entry.
    expect(nativeHeroActionPlans.complete).toMatchObject({
      kind: "setField",
      field: "status",
      value: "done",
    });
    expect(nativeHeroActionPlans.adjustAmount).toMatchObject({
      kind: "editField",
      field: "amount",
    });
    expect(nativeHeroActionPlans.moveTo).toMatchObject({
      kind: "operation",
      operation: "inventory.moveEntries",
      confirmation: "none",
    });
  });

  it("opens Record sale in the same disposition editor web shows", () => {
    // Web's expense capture dialog titles and describes itself from the
    // disposition context; the native editor takes the same copy and costType
    // from this plan, so the two cannot drift.
    const plan = nativeHeroActionPlans.recordSale;
    expect(plan.editor).toEqual(EXPENSE_DISPOSITION_EDITOR);
    expect(plan.seed.costType).toBe(EXPENSE_DISPOSITION_COST_TYPE);
    expect(plan.seed.projectId).toBeNull();
  });
});

describe("native collection verbs", () => {
  it("gives every verb a runner plan, and only the verbs", () => {
    expect(used(Object.keys(nativeCollectionActionPlans))).toEqual(
      used([...COLLECTION_ACTIONS]),
    );
  });

  it("reads a row's id only for a row-scoped verb", () => {
    for (const action of COLLECTION_ACTIONS) {
      const usesItem = JSON.stringify(
        nativeCollectionActionPlans[action].body,
      ).includes("$item.");
      expect({ action, usesItem }).toEqual({
        action,
        usesItem: COLLECTION_ACTION_SCOPES[action] === "row",
      });
    }
  });
});
