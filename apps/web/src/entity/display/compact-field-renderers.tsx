import { dataQuality } from "@cubby/schemas/data-quality";
import type { Entity } from "@cubby/schemas/entity";
import { productCategoryShortcode } from "@cubby/schemas/identifiers";
import type { ProductListItem } from "@cubby/schemas/product";
import { productCategorySummary } from "@cubby/schemas/product-category-fields";
import type { ReactNode } from "react";
import { z } from "zod";

import {
  CategoryLabel,
  CategoryLabelById,
} from "~/entity/presentation/category-label";
import { NoneValue } from "~/ui/primitives/none-value";

import { EntityQualityFact } from "./data-quality-value";

/** `label`: a value's known display name, shown while its record resolves. */
type CompactFieldContext = { label?: string };
type CompactFieldRenderer = <TRecord extends object>(
  record: TRecord,
  context?: CompactFieldContext,
) => ReactNode | undefined;

function checkedRenderer<TSchema extends z.ZodType>(
  schema: TSchema,
  render: (
    record: z.output<TSchema>,
    context: CompactFieldContext,
  ) => ReactNode,
): CompactFieldRenderer {
  return <TRecord extends object>(
    record: TRecord,
    context: CompactFieldContext = {},
  ) => {
    const parsed = schema.safeParse(record);
    return parsed.success ? render(parsed.data, context) : undefined;
  };
}

const qualityRow = z.object({
  id: z.string(),
  dataQuality: dataQuality.optional(),
});

const categoryRow = z.object({ category: productCategorySummary.nullable() });
const externalIdsRow = z.object({
  externalIds: z.array(z.object({ source: z.string() })),
});

const resolvedCategory = checkedRenderer(categoryRow, (record) => (
  <CategoryLabel category={record.category} />
));
// A proposed value carries only the stored code, never the resolved path.
const categoryCodeRow = z.object({ categoryId: productCategoryShortcode });
const categoryById = checkedRenderer(categoryCodeRow, (record, context) => (
  <CategoryLabelById id={record.categoryId} name={context.label} />
));
const productCategory: CompactFieldRenderer = (record, context) =>
  resolvedCategory(record, context) ?? categoryById(record, context);

const productExternalIds = checkedRenderer(externalIdsRow, (record) => {
  const ids = record.externalIds;
  return ids.length > 0 ? (
    <span
      className="block truncate text-xs text-muted-foreground"
      title={ids.map((id) => id.source).join(", ")}
    >
      {ids.map((id) => id.source).join(", ")}
    </span>
  ) : (
    <NoneValue />
  );
});

// Both the stored category reference and the shelf's resolved projection have
// the same domain value. The row schema checks it before the renderer reads it.
const productRenderers = {
  categoryId: productCategory,
  category: productCategory,
  externalIds: productExternalIds,
} satisfies Partial<Record<keyof ProductListItem, CompactFieldRenderer>>;

/** A row-backed domain renderer shared by lists, relation tables, and shelves. */
export function compactFieldRendererFor(
  entity: Entity,
  fieldKey: string,
): CompactFieldRenderer | null {
  if (fieldKey === "dataQuality")
    return checkedRenderer(qualityRow, (record) => (
      <EntityQualityFact
        entity={entity}
        id={record.id}
        quality={record.dataQuality}
      />
    ));
  if (entity !== "product") return null;
  return (
    Object.entries(productRenderers).find(([key]) => key === fieldKey)?.[1] ??
    null
  );
}
