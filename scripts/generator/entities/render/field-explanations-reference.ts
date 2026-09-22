import { markdownGeneratedHeader } from "../../artifacts.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";

type Explanation = NonNullable<
  CompiledEntity["fieldModel"]["fields"][number]["explanation"]
>;

const resolverLabels = {
  field: "Declared field projection",
  inventoryOwnership: "Inventory ownership",
  productValuation: "Product valuation",
  imageRepresentation: "Image representation",
  imageCapture: "Image capture provenance",
  productQuantity: "Product quantity ledger",
  recipeTotals: "Recipe totals",
  locationValuation: "Location valuation",
  merchantVendorInference: "Merchant and vendor inference",
  expenseAttribution: "Expense attribution",
} as const satisfies Record<Explanation["resolver"], string>;

const actionLabels = {
  confirmOwner: "Confirm owner",
  inheritOwner: "Inherit owner",
  editSource: "Edit source",
} as const satisfies Record<
  NonNullable<Explanation["actions"]>[number],
  string
>;

const surfaceLabels = {
  list: "List",
  detail: "Detail",
  summary: "Summary",
} as const;
const surfaces = ["list", "detail", "summary"] as const;

const renderExplanation = (
  field: CompiledEntity["fieldModel"]["fields"][number],
  explanation: Explanation,
): string => {
  const valuePaths = surfaces.flatMap((surface) => {
    const path = explanation.projections?.[surface];
    return path === undefined ? [] : [`${surfaceLabels[surface]} \`${path}\``];
  });
  if (explanation.readPath !== undefined)
    valuePaths.push(`Default \`${explanation.readPath}\``);

  const sources = (explanation.sourceDependencies ?? []).map(
    ({ label, path }) => `${label} (\`${path}\`)`,
  );
  const actions = (explanation.actions ?? []).map(
    (action) => actionLabels[action],
  );

  return [
    `### ${field.label} (\`${field.key}\`)`,
    "",
    explanation.description,
    "",
    `- Rule: \`${explanation.ruleId}\`, version ${explanation.version}`,
    `- Resolver: ${resolverLabels[explanation.resolver]}`,
    ...(valuePaths.length > 0
      ? [`- Value paths: ${valuePaths.join("; ")}`]
      : []),
    ...(sources.length > 0
      ? [`- Source dependencies: ${sources.join("; ")}`]
      : []),
    ...(actions.length > 0
      ? [`- Available actions: ${actions.join("; ")}`]
      : []),
    "",
  ].join("\n");
};

export const renderFieldExplanationReference = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const sections = entities.flatMap((entity) => {
    const explainedFields = entity.fieldModel.fields.flatMap((field) =>
      field.explanation === null
        ? []
        : [renderExplanation(field, field.explanation)],
    );
    if (explainedFields.length === 0) return [];
    const title = entity.inspector.plural ?? entity.inspector.singular;
    return [
      [`## ${title} (\`${entity.key}\`)`, "", ...explainedFields].join("\n"),
    ];
  });

  return [
    {
      relativePath: "docs/how-values-are-determined.md",
      source:
        markdownGeneratedHeader +
        [
          "# How values are determined",
          "",
          "This reference lists every field with declaration-owned explanation metadata. The web and Apple explanation views use the same rules, value paths, source dependencies, and correction actions.",
          "",
          ...sections,
        ].join("\n"),
    },
  ];
};
