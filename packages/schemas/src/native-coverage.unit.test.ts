import { describe, expect, it } from "vitest";
import {
  generatedEntityFieldModels,
  type GeneratedEntityFieldModel,
} from "./generated/entity-field-model.gen";
import { entityKeys, entitySummary } from "./generated/entity-summary.gen";
import { isSlotListView } from "./entity-definitions/definition";
import {
  NATIVE_COVERAGE_KINDS,
  NATIVE_UNSUPPORTED_CEILING,
  nativeCoverage,
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
});
