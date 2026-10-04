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
  NATIVE_UNSUPPORTED_CEILING,
  nativeCollectionActionPlans,
  nativeCoverage,
  nativeHeroActionPlans,
  type NativeCoverageEntry,
  type NativeCoverageKind,
  type NativeHeroActionPlan,
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

  it("explains every unsupported id", () => {
    const unexplained = NATIVE_COVERAGE_KINDS.flatMap((kind) =>
      entries(kind).flatMap(([id, entry]) =>
        entry.status === "unsupported" && entry.reason.trim() === ""
          ? [`${kind} ${id}`]
          : [],
      ),
    );
    expect(unexplained).toEqual([]);
  });

  it.each(NATIVE_COVERAGE_KINDS)(
    "keeps the %s unsupported set at its reviewed ceiling",
    (kind) => {
      const actual = entries(kind).filter(
        ([, entry]) => entry.status === "unsupported",
      ).length;
      const ceiling = NATIVE_UNSUPPORTED_CEILING[kind];
      const verdict =
        actual === ceiling
          ? "within ceiling"
          : `${actual} native-unsupported ${kind} ids, ceiling ${ceiling}. The unsupported ` +
            `set only shrinks: implement the id natively in apps/apple, flip its status in ` +
            `packages/schemas/src/native-coverage.ts, and lower ` +
            `NATIVE_UNSUPPORTED_CEILING.${kind}. Raising the ceiling needs a reviewed ` +
            `justification.`;
      expect(verdict).toBe("within ceiling");
    },
  );

  it("keeps the Run agent and prepared-order slots explained as web-only", () => {
    // The agent conversation is a Flue stream and prepared orders need per-line pickers; each
    // reason names why, so a future reader does not mistake them for an oversight.
    for (const id of [
      "run.import-agent-live",
      "run.import-agent-stopped",
      "run.import-prepared-orders",
    ] as const) {
      const entry = nativeCoverage.detailSlot[id];
      expect(entry.status).toBe("unsupported");
      expect("reason" in entry && entry.reason).not.toBe(
        "This detail is available on web.",
      );
    }
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

  it("classifies the multi-select verb as owned elsewhere, not faked", () => {
    expect(nativeCoverage.heroAction.bulkEdit.status).toBe("ownedElsewhere");
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

  it("names the entities each verb may be offered on", () => {
    const plans: Record<string, NativeHeroActionPlan> =
      nativeCollectionActionPlans;
    const entitiesOf = Object.fromEntries(
      COLLECTION_ACTIONS.map((action) => {
        const plan = plans[action];
        return [action, plan?.kind === "operation" ? plan.entities : []];
      }),
    );
    expect(entitiesOf).toEqual({
      analyzeLocation: ["location"],
      attachImage: ["image"],
      reviewLabelNutrition: ["product"],
      validatePurchase: ["purchase"],
    });
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

  it("starts from a form or an explicit tap, never a silent write", () => {
    // Analysis, attaching and launching are named verbs the person chose; none removes a
    // record, so none asks for the destructive confirmation.
    for (const plan of Object.values(nativeCollectionActionPlans))
      expect(plan.confirmation).toBe("none");
  });
});
