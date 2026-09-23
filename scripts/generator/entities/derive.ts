import { z } from "zod";
import {
  type CompiledEntity,
  type DeclarationObject,
  type DeclarationValue,
  EntityDeclarationError,
  objectValue,
} from "./declarations.ts";

/**
 * Relationship coverage is opt-out. Two passes close the gaps a hand-kept
 * roster drifts into (a Task page that never listed its Plantings although
 * `Planting.taskId` points at it):
 *
 * - `deriveInverseRelations` (raw declarations, before compile): every
 *   single-FK `one` relation gets a `many` inverse on its target unless the
 *   target already declares one over the same path or the relation says
 *   `inverseOmit`. A `many` relation over a single incoming FK also gets a
 *   stored id back-filter on its target when none references the source.
 * - `deriveRelationSections` (compiled entities): every `many` relation on a
 *   generic detail page renders a relation section unless one is declared or
 *   `detail.omitRelations` names it with a reason.
 */

const stepSchema = z.object({
  edge: z.string(),
  direction: z.enum(["incoming", "outgoing"]),
});
type Step = z.infer<typeof stepSchema>;

/**
 * The slice of a raw declaration the inverse pass reads. `compileEntity`
 * validates the whole declaration afterwards; a declaration this view can't
 * read is left alone for that pass to report.
 */
const relationView = z.object({
  key: z.string(),
  target: z.string(),
  cardinality: z.enum(["one", "many"]),
  provenance: z.object({
    kind: z.string(),
    steps: z.array(stepSchema).optional(),
  }),
  inverse: z.object({ steps: z.array(stepSchema) }).optional(),
  inverseOmit: z.string().optional(),
});
type RelationView = z.infer<typeof relationView>;

const declarationView = z.object({
  key: z.string(),
  names: z.object({
    singular: z.string(),
    plural: z.string().nullable().optional(),
  }),
  relations: z.array(relationView).optional().default([]),
  filters: z
    .object({
      descriptors: z
        .array(
          z.object({
            columnId: z.string(),
            brandRef: z.object({ entity: z.string() }).nullable().optional(),
          }),
        )
        .optional()
        .default([]),
    })
    .optional(),
  model: z
    .object({
      storage: z
        .array(
          z.union([
            // A bare key is a storage column with no declared options.
            z.string().transform((key) => ({ key, reference: undefined })),
            z.object({ key: z.string(), reference: z.string().optional() }),
          ]),
        )
        .optional()
        .default([]),
    })
    .optional(),
});
type DeclarationView = z.infer<typeof declarationView>;

const samePath = (left: readonly Step[], right: readonly Step[]) =>
  left.length === right.length &&
  left.every(
    (step, index) =>
      step.edge === right[index]?.edge &&
      step.direction === right[index]?.direction,
  );

const kebab = (value: string) =>
  value
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/gu, "-")
    .toLowerCase();

/** The FK column of a one-step local path, or null for anything longer. */
const singleEdgeColumn = (
  relation: Pick<RelationView, "provenance">,
  direction: Step["direction"],
): string | null => {
  const { kind, steps } = relation.provenance;
  const [step] = steps ?? [];
  if (kind !== "local-path" || steps?.length !== 1 || step === undefined)
    return null;
  if (step.direction !== direction) return null;
  return step.edge.split(".")[1] ?? null;
};

const arrayOf = (value: DeclarationValue | undefined): DeclarationValue[] =>
  Array.isArray(value) ? value : [];

type DeriveState = {
  current: Map<string, DeclarationObject>;
  views: Map<string, DeclarationView>;
  gaps: string[];
};

const addInverseRelations = ({ current, views, gaps }: DeriveState) => {
  const pushRelation = (key: string, relation: DeclarationObject) => {
    const raw = current.get(key);
    const view = views.get(key);
    if (raw === undefined || view === undefined) return;
    current.set(key, {
      ...raw,
      relations: [...arrayOf(raw.relations), relation],
    });
    const parsed = relationView.parse(relation);
    views.set(key, { ...view, relations: [...view.relations, parsed] });
  };
  for (const source of views.values()) {
    for (const relation of source.relations) {
      if (relation.cardinality !== "one") continue;
      if (singleEdgeColumn(relation, "outgoing") === null) continue;
      const target = views.get(relation.target);
      const inverse = relation.inverse?.steps;
      if (inverse === undefined || target === undefined) continue;
      const covered = target.relations.some(
        (candidate) =>
          candidate.cardinality === "many" &&
          candidate.target === source.key &&
          samePath(candidate.provenance.steps ?? [], inverse),
      );
      if (covered || relation.inverseOmit !== undefined) continue;
      const plural = source.names.plural ?? source.names.singular;
      const key = kebab(plural);
      // Sentence case, like every declared section title ("Garden entries").
      const label = plural.charAt(0) + plural.slice(1).toLowerCase();
      if (target.relations.some((candidate) => candidate.key === key)) {
        gaps.push(
          `${source.key}.relations[${relation.key}] derives the inverse ${relation.target}.${key}, which already names another relation. Declare the inverse on ${relation.target} or set inverseOmit.`,
        );
        continue;
      }
      pushRelation(relation.target, {
        key,
        label,
        target: source.key,
        cardinality: "many",
        provenance: { kind: "local-path", steps: inverse.map(stepValue) },
        inverse: {
          steps: (relation.provenance.steps ?? []).map(stepValue),
        },
        derived: true,
      });
    }
  }
};

const addBackFilters = ({ current, views, gaps }: DeriveState) => {
  // Back-filters: a `many` relation over one incoming FK is scoped on its
  // target by that FK column, which #1248's stored id filters serve without
  // repository code.
  for (const owner of views.values()) {
    for (const relation of owner.relations) {
      if (relation.cardinality !== "many") continue;
      const column = singleEdgeColumn(relation, "incoming");
      const target = views.get(relation.target);
      const raw = current.get(relation.target);
      if (column === null || target === undefined || raw === undefined)
        continue;
      const descriptors = target.filters?.descriptors ?? [];
      if (descriptors.some(({ brandRef }) => brandRef?.entity === owner.key))
        continue;
      if (descriptors.some(({ columnId }) => columnId === column)) {
        gaps.push(
          `${relation.target}.filters.${column} scopes ${owner.key}.${relation.key} but declares no brandRef ${owner.key}.`,
        );
        continue;
      }
      // Without a stored FK there is nothing to derive; the section pass
      // reports the gap if a table would need this filter.
      const storedFk = (target.model?.storage ?? []).some(
        (field) => field.key === column && field.reference === owner.key,
      );
      if (!storedFk) continue;
      const filters = objectValue(raw.filters, `${relation.target}.filters`);
      const descriptor = {
        columnId: column,
        kind: "idMulti",
        placeholder: `Filter by ${owner.names.singular.toLowerCase()}...`,
        brandRef: { entity: owner.key },
        urlOnly: true,
        deriveSchema: true,
        stored: true,
      };
      current.set(relation.target, {
        ...raw,
        filters: {
          ...filters,
          descriptors: [...arrayOf(filters.descriptors), descriptor],
        },
      });
      views.set(relation.target, {
        ...target,
        filters: { descriptors: [...descriptors, descriptor] },
      });
    }
  }
};

export const deriveInverseRelations = (
  raws: readonly DeclarationObject[],
): DeclarationObject[] => {
  const state: DeriveState = { current: new Map(), views: new Map(), gaps: [] };
  const firstIndex = new Map<string, number>();
  for (const [index, raw] of raws.entries()) {
    const view = declarationView.safeParse(raw);
    // A declaration this view can't read would silently get no inverses or
    // back-filters; fail with the path instead.
    if (!view.success)
      throw new EntityDeclarationError(
        `ENTITY_DECLARATIONS[${index}] cannot be read for relation derivation: ${view.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
      );
    // A duplicate key keeps its own declaration so the identity check still
    // sees both; only the first takes part in derivation.
    if (state.views.has(view.data.key)) continue;
    firstIndex.set(view.data.key, index);
    state.current.set(view.data.key, raw);
    state.views.set(view.data.key, view.data);
  }
  addInverseRelations(state);
  addBackFilters(state);
  if (state.gaps.length > 0)
    throw new EntityDeclarationError(state.gaps.join("\n"));
  const byIndex = new Map(
    [...firstIndex].map(([key, index]) => [index, key] as const),
  );
  return raws.map((raw, index) => {
    const key = byIndex.get(index);
    return key === undefined ? raw : (state.current.get(key) ?? raw);
  });
};

const stepValue = (step: Step): DeclarationObject => ({
  edge: step.edge,
  direction: step.direction,
});

type RelationSection = Extract<
  CompiledEntity["inspector"]["detail"]["sections"][number],
  { kind: "relation" }
>;

/** A list entity: the generic list contract the relation table renders. */
export const hasEntityList = (entity: CompiledEntity) =>
  entity.contract !== null &&
  entity.contract.create !== null &&
  entity.contract.update !== null &&
  entity.descriptor.browserRoutes !== false;

const hasGenericDetail = (entity: CompiledEntity) =>
  entity.route !== null && entity.route.detail !== null;

/**
 * The target descriptor that scopes `relation` to one source record: the
 * only id filter branded to the source, or — among several — the one over
 * the relation's own FK column. A filter another section on this page
 * already uses means that other relation, never this one. A self-relation
 * (a product's kits vs. its components) only matches by FK column: a lone
 * branded filter could as easily scope the opposite direction.
 */
const backFilter = (
  entity: CompiledEntity,
  relation: CompiledEntity["relations"][number],
  target: CompiledEntity,
  used: ReadonlySet<string>,
): { descriptor: string } | { gap: string } => {
  const candidates = target.filterDescriptors.filter(
    (descriptor) =>
      (descriptor.kind === "id" || descriptor.kind === "idMulti") &&
      descriptor.brandRef?.entity === entity.key &&
      !used.has(descriptor.columnId),
  );
  if (candidates.length === 1 && target.key !== entity.key)
    return { descriptor: candidates[0]!.columnId };
  const provenance = relationView.shape.provenance.safeParse(
    relation.provenance,
  );
  const column = provenance.success
    ? (singleEdgeColumn({ provenance: provenance.data }, "incoming") ??
      undefined)
    : undefined;
  const byColumn = candidates.filter(
    (descriptor) =>
      descriptor.columnId === column ||
      descriptor.field === column ||
      descriptor.stored?.columns.includes(column ?? "") === true,
  );
  if (byColumn.length === 1) return { descriptor: byColumn[0]!.columnId };
  const found =
    candidates.length === 0
      ? "no id filter on it references"
      : `${candidates.map(({ columnId }) => columnId).join(", ")} all reference`;
  return {
    gap: `${entity.key}.relations[${relation.key}] renders no detail table: ${found} ${entity.key} on ${target.key}. Declare a relation section naming the filter, or add it to presentation.detail.omitRelations with a reason.`,
  };
};

export const deriveRelationSections = (
  entities: readonly CompiledEntity[],
): CompiledEntity[] => {
  const byKey = new Map(entities.map((entity) => [entity.key, entity]));
  const gaps: string[] = [];
  const derivedEntities = entities.map((entity) => {
    if (!hasGenericDetail(entity)) return entity;
    const { detail } = entity.inspector;
    const declared = new Set(
      detail.sections.flatMap((section) =>
        section.kind === "relation" ? [section.relation] : [],
      ),
    );
    const sectionIds = new Set(detail.sections.map(({ id }) => id));
    const omitRelations = { ...detail.omitRelations };
    for (const [key, reason] of Object.entries(omitRelations)) {
      const relation = entity.relations.find(
        (candidate) => candidate.key === key,
      );
      if (relation?.cardinality !== "many")
        gaps.push(
          `${entity.key}.presentation.detail.omitRelations.${key} names no many relation.`,
        );
      if (declared.has(key))
        gaps.push(
          `${entity.key}.presentation.detail.omitRelations.${key} also has a declared section (${reason}).`,
        );
    }
    const derived: RelationSection[] = [];
    for (const relation of entity.relations) {
      if (relation.cardinality !== "many") continue;
      if (declared.has(relation.key) || relation.key in omitRelations) continue;
      const target = byKey.get(relation.target);
      if (target === undefined || !hasEntityList(target)) {
        omitRelations[relation.key] =
          `${relation.target} has no list page to render as a table.`;
        continue;
      }
      const id = kebab(relation.key);
      if (sectionIds.has(id)) {
        gaps.push(
          `${entity.key} derives a section ${id} for relation ${relation.key}, but a section already uses that id.`,
        );
        continue;
      }
      const used = new Set(
        [...detail.sections, ...derived].flatMap((section) =>
          section.kind === "relation" &&
          entity.relations.find(({ key }) => key === section.relation)
            ?.target === target.key
            ? [section.filter.descriptor]
            : [],
        ),
      );
      const filter = backFilter(entity, relation, target, used);
      if ("gap" in filter) {
        gaps.push(filter.gap);
        continue;
      }
      sectionIds.add(id);
      derived.push({
        kind: "relation",
        id,
        title: relation.label,
        placement: "primary",
        collapsed: false,
        relation: relation.key,
        filter,
        columns: null,
        prefill: null,
        sort: null,
        limit: null,
        hideWhenEmpty: false,
        collapseWhenEmpty: true,
        derived: true,
      });
    }
    return {
      ...entity,
      inspector: {
        ...entity.inspector,
        detail: {
          ...detail,
          sections: [...detail.sections, ...derived],
          omitRelations,
        },
      },
    };
  });
  if (gaps.length > 0) throw new EntityDeclarationError(gaps.join("\n"));
  return derivedEntities;
};
