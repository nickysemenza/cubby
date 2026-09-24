import { generatedHeader } from "../artifacts.ts";
import { compileLoadedEntityDeclarations } from "./declarations.ts";
import type {
  CompiledEntity,
  DeclarationObject,
  EntityArtifacts,
} from "./declarations.ts";
import { renderRecord } from "./render/record.ts";

type Comparison = {
  path: string;
  declared: string;
  without: string | null;
  status: "changed" | "unchanged" | "invalid";
  reason: string | null;
};

const pathParts = (path: string) =>
  path.split(".").map((part) => {
    const match = /^([^[]+)(?:\[([^\]]+)\])?$/u.exec(part);
    if (match === null) throw new Error(`Invalid override path ${path}.`);
    return { property: match[1]!, itemKey: match[2] };
  });

/** Clone only the branch containing the input; Zod schemas remain live objects. */
const withoutInput = (
  raw: DeclarationObject,
  path: string,
): DeclarationObject => {
  const parts = pathParts(path);
  const omit = (
    object: DeclarationObject,
    index: number,
  ): DeclarationObject => {
    const { property, itemKey } = parts[index]!;
    const copy = { ...object };
    if (itemKey === undefined) {
      if (index === parts.length - 1) delete copy[property];
      else {
        // SAFETY: collected override paths traverse plain declaration objects.
        copy[property] = omit(copy[property] as DeclarationObject, index + 1);
      }
      return copy;
    }
    // SAFETY: bracketed path segments are collected only from declaration arrays.
    const array = copy[property] as DeclarationObject[];
    copy[property] = array.map((item) =>
      item.key === itemKey ? omit(item, index + 1) : item,
    );
    return copy;
  };
  return omit(raw, 0);
};

type ComparisonValue = string | number | boolean | null | object | undefined;

// oxlint-disable-next-line eslint/complexity -- Each branch reads one finite manifest override path.
const effectiveValue = (
  entity: CompiledEntity,
  path: string,
): ComparisonValue => {
  const fieldPath = /^model\.fields\[([^\]]+)\]\.(.*)$/u.exec(path);
  if (fieldPath !== null) {
    const field = entity.fieldModel.fields.find(
      ({ key }) => key === fieldPath[1],
    );
    if (field === undefined)
      throw new Error(`${entity.key}.${path} has no field.`);
    switch (fieldPath[2]) {
      case "readKeyOverride":
        return field.readKey;
      case "control.sectionOverride":
        return field.control?.section ?? null;
      case "labelOverride":
        return field.label;
      case "display.columnIdOverride":
        return field.display.columnId ?? field.key;
      case "display.listOrderOverride":
        return field.display.listOrder;
      case "display.detailOrderOverride":
        return field.display.detailOrder;
      default:
        throw new Error(`No effective-value reader for ${path}.`);
    }
  }
  const storagePath = /^model\.storage\[([^\]]+)\]\.(.*)$/u.exec(path);
  if (storagePath !== null) {
    const field = entity.fieldModel.storage.find(
      ({ key }) => key === storagePath[1],
    );
    if (field === undefined)
      throw new Error(`${entity.key}.${path} has no storage field.`);
    switch (storagePath[2]) {
      case "defaultOverride":
        return field.default;
      case "kindOverride":
        return field.kind;
      default:
        throw new Error(`No effective-value reader for ${path}.`);
    }
  }
  switch (path) {
    case "model.sort.defaultOverride":
      return entity.fieldModel.sort?.default ?? null;
    case "model.sort.directionOverride":
      return entity.fieldModel.sort?.direction ?? null;
    case "route.createOverride":
      return entity.route?.create ?? null;
    case "route.listOverride":
      return entity.route?.list ?? null;
    case "route.detailOverride":
      return entity.route?.detail ?? null;
    case "route.detailParamOverride":
      return entity.route?.detailParam ?? null;
    case "presentation.detail.hero.imagesOverride":
      return entity.inspector.detail.hero.images;
    case "presentation.detail.hero.actionOverrides":
      return entity.inspector.detail.hero.actions;
    case "presentation.detail.variantOverride":
      return entity.inspector.detail.variant;
    case "presentation.detail.sectionOverrides":
      return entity.inspector.detail.sections;
    case "presentation.detail.additionalSectionOverrides":
      return entity.inspector.detail.sections;
    case "presentation.detail.relationFilterOverrides":
      return Object.fromEntries(
        Object.keys(entity.inspector.detail.relationFilterOverrides).map(
          (key) => {
            const section = entity.inspector.detail.sections.find(
              (candidate) =>
                candidate.kind === "relation" && candidate.relation === key,
            );
            return [
              key,
              section?.kind === "relation"
                ? { filter: section.filter, prefill: section.prefill }
                : null,
            ];
          },
        ),
      );
    case "presentation.list.viewOverrides":
      return entity.inspector.list.views;
    case "presentation.list.actionOverrides":
      return entity.inspector.list.actions;
    case "presentation.list.shelfSubtitleOverride":
      return entity.inspector.list.shelf.subtitle;
    case "presentation.edit.sectionOverrides":
      return entity.inspector.edit.sections;
    case "search.embeddingOverride":
      return entity.descriptor.embeddable;
    case "capabilities.images.displaySourceOverrides":
      return entity.imagePolicy.displaySources;
    default:
      throw new Error(`No effective-value reader for ${path}.`);
  }
};

export const renderOverrideComparisonArtifact = (
  declarations: readonly DeclarationObject[],
  entities: readonly CompiledEntity[],
): EntityArtifacts => {
  const values: Record<string, Comparison[]> = {};
  for (const entity of entities) {
    const index = declarations.findIndex((raw) => raw.key === entity.key);
    if (index < 0) throw new Error(`Missing raw declaration ${entity.key}.`);
    const raw = declarations[index]!;
    values[entity.key] = entity.overrides.map(({ path, value }) => {
      try {
        const changed = [...declarations];
        changed[index] = withoutInput(raw, path);
        const counterfactual = compileLoadedEntityDeclarations(changed).find(
          (candidate) => candidate.key === entity.key,
        );
        if (counterfactual === undefined)
          throw new Error(`Missing ${entity.key} after compilation.`);
        const before = JSON.stringify(effectiveValue(entity, path)) ?? "null";
        const without =
          JSON.stringify(effectiveValue(counterfactual, path)) ?? "null";
        return {
          path,
          declared: value,
          without,
          status: before === without ? "unchanged" : "changed",
          reason: null,
        };
      } catch (error) {
        return {
          path,
          declared: value,
          without: null,
          status: "invalid",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }
  return {
    relativePath:
      "apps/web/src/entities/generated/entity-override-comparisons.gen.ts",
    source:
      generatedHeader +
      'import type { Entity } from "@cubby/schemas/entity";\n\n' +
      renderRecord({
        name: "entityOverrideComparisons",
        entries: values,
        satisfies:
          "Record<Entity, readonly { path: string; declared: string; without: string | null; status: 'changed' | 'unchanged' | 'invalid'; reason: string | null }[]>",
      }),
  };
};
