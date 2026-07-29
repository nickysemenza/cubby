import type { RecipeOut } from "@cubby/schemas/recipe";
import type {
  RecipeFlowOperation,
  RecipeFlowPlan,
  RecipeFlowSource,
} from "@cubby/schemas/recipe-flow";

interface RecipeFlowOperationPlacement {
  operation: RecipeFlowOperation;
  column: number;
  rowStart: number;
  rowEnd: number;
  rowCenter: number;
}

export interface RecipeFlowLayout {
  sources: RecipeFlowSource[];
  operations: RecipeFlowOperationPlacement[];
  columnCount: number;
}

function instructionOrder(
  recipe: RecipeOut,
  operation: RecipeFlowOperation,
): number {
  const sectionOrder = new Map(
    recipe.sections.map((section, index) => [section.id, index]),
  );
  return Math.min(
    ...operation.instructionRefs.map(
      (ref) =>
        (sectionOrder.get(ref.sectionId) ?? recipe.sections.length) * 100_000 +
        ref.instructionIndex,
    ),
  );
}

function orderedSources(
  recipe: RecipeOut,
  plan: RecipeFlowPlan,
): RecipeFlowSource[] {
  const usageOrder = new Map(
    recipe.sections
      .flatMap((section) => section.ingredients)
      .map((usage, index) => [usage.id, index]),
  );
  return [...plan.sources].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "usage" ? -1 : 1;
    if (a.kind === "usage" && b.kind === "usage") {
      const order =
        (usageOrder.get(a.usageId) ?? Number.MAX_SAFE_INTEGER) -
        (usageOrder.get(b.usageId) ?? Number.MAX_SAFE_INTEGER);
      if (order !== 0) return order;
      const roleOrder = (a.role ?? "").localeCompare(b.role ?? "");
      return roleOrder !== 0 ? roleOrder : a.id.localeCompare(b.id);
    }
    return a.id.localeCompare(b.id);
  });
}

function topologicalOperations(
  recipe: RecipeOut,
  plan: RecipeFlowPlan,
): RecipeFlowOperation[] {
  const byId = new Map(
    plan.operations.map((operation) => [operation.id, operation]),
  );
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: RecipeFlowOperation[] = [];

  const visit = (operation: RecipeFlowOperation) => {
    if (visited.has(operation.id) || visiting.has(operation.id)) return;
    visiting.add(operation.id);
    const dependencies = operation.inputs
      .flatMap((input) =>
        input.kind === "operation" ? [byId.get(input.id)] : [],
      )
      .filter(
        (candidate): candidate is RecipeFlowOperation => candidate != null,
      )
      .sort(
        (a, b) =>
          instructionOrder(recipe, a) - instructionOrder(recipe, b) ||
          a.id.localeCompare(b.id),
      );
    for (const dependency of dependencies) visit(dependency);
    visiting.delete(operation.id);
    visited.add(operation.id);
    ordered.push(operation);
  };

  for (const operation of [...plan.operations].sort(
    (a, b) =>
      instructionOrder(recipe, a) - instructionOrder(recipe, b) ||
      a.id.localeCompare(b.id),
  )) {
    visit(operation);
  }
  return ordered;
}

export function buildRecipeFlowLayout(
  recipe: RecipeOut,
  plan: RecipeFlowPlan,
): RecipeFlowLayout {
  const sources = orderedSources(recipe, plan);
  const sourceRows = new Map(sources.map((source, row) => [source.id, row]));
  const operationById = new Map(
    plan.operations.map((operation) => [operation.id, operation]),
  );
  const sourceDescendants = new Map<string, Set<string>>();

  const descendantsFor = (
    operation: RecipeFlowOperation,
    visiting = new Set<string>(),
  ): Set<string> => {
    const cached = sourceDescendants.get(operation.id);
    if (cached) return cached;
    if (visiting.has(operation.id)) return new Set();
    const nextVisiting = new Set(visiting).add(operation.id);
    const descendants = new Set<string>();
    for (const input of operation.inputs) {
      if (input.kind === "source") {
        descendants.add(input.id);
        continue;
      }
      const dependency = operationById.get(input.id);
      if (!dependency) continue;
      for (const sourceId of descendantsFor(dependency, nextVisiting)) {
        descendants.add(sourceId);
      }
    }
    sourceDescendants.set(operation.id, descendants);
    return descendants;
  };

  const placements = new Map<string, RecipeFlowOperationPlacement>();
  const occupiedByColumn = new Map<
    number,
    Array<{ rowStart: number; rowEnd: number }>
  >();

  for (const operation of topologicalOperations(recipe, plan)) {
    const rows = [...descendantsFor(operation)]
      .map((sourceId) => sourceRows.get(sourceId))
      .filter((row): row is number => row != null);
    const rowStart = rows.length > 0 ? Math.min(...rows) : 0;
    const rowEnd = rows.length > 0 ? Math.max(...rows) : rowStart;
    const inputColumns = operation.inputs.flatMap((input) => {
      if (input.kind === "source") return [0];
      const placement = placements.get(input.id);
      return placement ? [placement.column] : [];
    });
    let column = Math.max(0, ...inputColumns) + 1;
    while (
      (occupiedByColumn.get(column) ?? []).some(
        (occupied) =>
          occupied.rowStart <= rowEnd && rowStart <= occupied.rowEnd,
      )
    ) {
      column++;
    }
    const placement = {
      operation,
      column,
      rowStart,
      rowEnd,
      rowCenter: (rowStart + rowEnd) / 2,
    };
    placements.set(operation.id, placement);
    const occupied = occupiedByColumn.get(column) ?? [];
    occupied.push({ rowStart, rowEnd });
    occupiedByColumn.set(column, occupied);
  }

  const operations = [...placements.values()].sort(
    (a, b) =>
      a.column - b.column ||
      a.rowStart - b.rowStart ||
      a.operation.id.localeCompare(b.operation.id),
  );
  return {
    sources,
    operations,
    columnCount:
      Math.max(0, ...operations.map((placement) => placement.column)) + 1,
  };
}
