import { formatScalingPct } from "./recipe-scaling-pct";
import {
  buildIngredientMatrix,
  firstExpansionRowIds,
  flattenComponents,
  fullBatchNeeds,
  type RecipeTreeNode,
  type RecipeTreeRow,
} from "./recipe-tree";
import { formatYield } from "./recipe-yield";

// Serialize a recipe tree to Markdown for the export route's "Copy" action.
// Pure + alias-free (no wasm): the wasm-bound quantity formatting is injected as
// `quantityText`, so this stays unit-testable and the caller (which has wasm)
// supplies each row's full-batch display string.

type RowQuantityText = (
  node: RecipeTreeNode,
  row: Extract<RecipeTreeRow, { kind: "ingredient" | "subrecipe" }>,
) => string;

type MarkdownFlavor = "prep" | "nested" | "matrix";

const rowName = (row: RecipeTreeRow): string => {
  if (row.kind === "stub") return row.name;
  return row.row.type === "ingredient"
    ? row.row.ingredient.name
    : row.row.recipe.name;
};

const modifierSuffix = (row: RecipeTreeRow): string =>
  row.kind !== "stub" && row.row.modifier ? `, ${row.row.modifier}` : "";

const yieldText = (node: RecipeTreeNode, factor: number): string | null => {
  const y = node.recipe.yield;
  if (!y?.value) return null;
  return formatYield({
    value: Math.round(y.value * factor * 100) / 100,
    unit: y.unit,
  });
};

const headnote = (node: RecipeTreeNode): string =>
  node.recipe.notes ? `\n${node.recipe.notes}\n` : "";

const prepMarkdown = (
  tree: RecipeTreeNode,
  quantityText: RowQuantityText,
): string => {
  const lines: string[] = [`# ${tree.recipe.name} — prep sheet`];
  const yld = yieldText(tree, 1);
  if (yld) lines.push(`\n_Yields ${yld}_`);
  if (tree.recipe.notes) lines.push(headnote(tree));

  const combined = fullBatchNeeds(tree);
  if (combined.length > 0) {
    const parts = combined.map(
      (n) =>
        `${n.grams != null ? `${Math.round(n.grams)} g ` : ""}${n.name}${
          n.estimated ? " (est.)" : ""
        }`,
    );
    lines.push(`\n**Shopping list (full batch):** ${parts.join(" · ")}`);
  }

  for (const node of flattenComponents(tree)) {
    const makes = yieldText(node, 1); // full batch
    lines.push(
      `\n## ${node.recipe.name}${makes ? ` — makes ${makes}` : ""}${
        node.batchEstimated ? " (batch est.)" : ""
      }`,
    );
    for (const section of node.sections) {
      for (const row of section.rows) {
        if (row.kind === "stub") {
          lines.push(`- [ ] ${rowName(row)} (${row.reason})`);
          continue;
        }
        const qty = quantityText(node, row);
        const arrow = row.kind === "subrecipe" ? "→ " : "";
        lines.push(
          `- [ ] ${qty ? `${qty} ` : ""}${arrow}${rowName(row)}${modifierSuffix(row)}`,
        );
      }
    }
    const steps = node.sections.flatMap((s) => s.steps);
    for (const step of steps) lines.push(`${step.n}. ${step.text}`);
  }

  return `${lines.join("\n")}\n`;
};

const nestedMarkdown = (
  tree: RecipeTreeNode,
  quantityText: RowQuantityText,
): string => {
  const lines: string[] = [`# ${tree.recipe.name}`];
  const yld = yieldText(tree, 1);
  if (yld) lines.push(`\n_Yields ${yld}_`);
  if (tree.recipe.notes) lines.push(headnote(tree));
  lines.push("");

  // A sub-recipe used in several places is expanded once; later references are
  // pointer bullets ("see above"). Share the nested view's "which rows expand"
  // decision so the two surfaces can't disagree on what counts as "first".
  const expandIds = firstExpansionRowIds(tree);
  const walk = (node: RecipeTreeNode, indent: string) => {
    for (const section of node.sections) {
      for (const row of section.rows) {
        if (row.kind === "stub") {
          lines.push(`${indent}- ${rowName(row)} (${row.reason})`);
          continue;
        }
        const qty = quantityText(node, row);
        const pct = row.pct != null ? ` (${formatScalingPct(row.pct)})` : "";
        if (row.kind === "subrecipe") {
          const first = expandIds.has(row.id);
          lines.push(
            `${indent}- **${rowName(row)}**${qty ? ` — ${qty}` : ""}${pct}${
              first ? "" : " — see above"
            }`,
          );
          if (first) {
            walk(row.child, `${indent}  `);
          }
        } else {
          lines.push(
            `${indent}- ${rowName(row)}${modifierSuffix(row)}${qty ? ` — ${qty}` : ""}${pct}`,
          );
        }
      }
      for (const step of section.steps) {
        lines.push(`${indent}  ${step.n}. ${step.text}`);
      }
    }
  };
  walk(tree, "");

  return `${lines.join("\n")}\n`;
};

const matrixMarkdown = (tree: RecipeTreeNode): string => {
  const rows = buildIngredientMatrix(tree);
  const components = flattenComponents(tree);
  const lines: string[] = [`# ${tree.recipe.name} — ingredient matrix`];
  const yld = yieldText(tree, 1);
  if (yld) lines.push(`\n_Yields ${yld}_`);
  lines.push("");

  const header = [
    "Ingredient",
    ...components.map((c) => c.recipe.name),
    "Total",
  ];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const row of rows) {
    const cells = components.map((c) => {
      const g = row.byComponent.get(c.recipe.id);
      return g != null ? `${Math.round(g)} g` : "";
    });
    lines.push(
      `| ${row.name} | ${cells.join(" | ")} | ${Math.round(row.total)} g${
        row.estimated ? " ~" : ""
      } |`,
    );
  }
  return `${lines.join("\n")}\n`;
};

export const recipeTreeToMarkdown = (
  tree: RecipeTreeNode,
  opts: { flavor: MarkdownFlavor; quantityText: RowQuantityText },
): string => {
  switch (opts.flavor) {
    case "prep":
      return prepMarkdown(tree, opts.quantityText);
    case "nested":
      return nestedMarkdown(tree, opts.quantityText);
    case "matrix":
      return matrixMarkdown(tree);
  }
};
