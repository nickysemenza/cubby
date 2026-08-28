import type { RecipeOut } from "@cubby/schemas/recipe";
import type {
  RecipeFlowInstructionRef,
  RecipeFlowPlan,
  RecipeFlowWarning,
} from "@cubby/schemas/recipe-flow";

export type RecipeFlowValidationResult =
  | { ok: true; warnings: RecipeFlowWarning[] }
  | { ok: false; issues: string[] };

const instructionRefKey = (ref: RecipeFlowInstructionRef): string =>
  `${ref.sectionId}:${ref.instructionIndex}`;

type RecipeSections = Map<string, RecipeOut["sections"][number]>;

const validateInstructionRef = (
  ref: RecipeFlowInstructionRef,
  owner: string,
  sections: RecipeSections,
  issues: string[],
) => {
  const section = sections.get(ref.sectionId);
  if (!section) {
    issues.push(`${owner} references unknown section ${ref.sectionId}`);
  } else if (ref.instructionIndex >= section.instructions.length) {
    issues.push(
      `${owner} references missing instruction ${ref.sectionId}[${ref.instructionIndex}]`,
    );
  }
};

const validateNodeIds = (plan: RecipeFlowPlan, issues: string[]) => {
  const allIds = new Set<string>();
  for (const node of [...plan.setup, ...plan.sources, ...plan.operations]) {
    if (allIds.has(node.id)) issues.push(`duplicate node id ${node.id}`);
    allIds.add(node.id);
  }
};

const validateSetup = (
  plan: RecipeFlowPlan,
  sections: RecipeSections,
  issues: string[],
) => {
  for (const setup of plan.setup) {
    for (const ref of setup.instructionRefs) {
      validateInstructionRef(ref, `setup ${setup.id}`, sections, issues);
    }
  }
};

const validateSources = (
  recipe: RecipeOut,
  plan: RecipeFlowPlan,
  sections: RecipeSections,
  issues: string[],
  warnings: RecipeFlowWarning[],
) => {
  const usages = new Map(
    recipe.sections.flatMap((section) =>
      section.ingredients.map((usage) => [usage.id, usage] as const),
    ),
  );
  const sourcesByUsage = new Map<string, string[]>();
  for (const source of plan.sources) {
    if (source.kind === "unlisted") {
      for (const ref of source.instructionRefs) {
        validateInstructionRef(ref, `source ${source.id}`, sections, issues);
      }
      warnings.push({
        code: "unlisted-input",
        message: `${source.label} appears in the instructions but is not listed as an ingredient.`,
        nodeIds: [source.id],
      });
      continue;
    }
    if (!usages.has(source.usageId)) {
      issues.push(
        `source ${source.id} references unknown ingredient usage ${source.usageId}`,
      );
      continue;
    }
    const existing = sourcesByUsage.get(source.usageId) ?? [];
    existing.push(source.id);
    sourcesByUsage.set(source.usageId, existing);
  }
  for (const [usageId] of usages) {
    if (!sourcesByUsage.has(usageId)) {
      issues.push(`ingredient usage ${usageId} is missing from the flow`);
    }
  }
  for (const [usageId, ids] of sourcesByUsage) {
    if (ids.length <= 1) continue;
    const sources = plan.sources.flatMap((source) =>
      source.kind === "usage" && source.usageId === usageId ? [source] : [],
    );
    const roles = sources.map((source) => source.role);
    if (
      roles.some((role) => role == null) ||
      new Set(roles).size !== roles.length
    ) {
      issues.push(
        `divided ingredient usage ${usageId} needs a distinct role on every source`,
      );
      continue;
    }
    warnings.push({
      code: "divided-usage",
      message: "This ingredient is divided between multiple operations.",
      nodeIds: ids,
    });
  }
};

const validateOperations = (
  plan: RecipeFlowPlan,
  sections: RecipeSections,
  issues: string[],
): Map<string, Set<string>> => {
  const sourceIds = new Set(plan.sources.map((source) => source.id));
  const operationIds = new Set(
    plan.operations.map((operation) => operation.id),
  );
  const outgoing = new Map<string, Set<string>>();
  const addOutgoing = (from: string, to: string) => {
    const targets = outgoing.get(from) ?? new Set<string>();
    targets.add(to);
    outgoing.set(from, targets);
  };

  for (const operation of plan.operations) {
    for (const ref of operation.instructionRefs) {
      validateInstructionRef(
        ref,
        `operation ${operation.id}`,
        sections,
        issues,
      );
    }
    const seenInputs = new Set<string>();
    for (const input of operation.inputs) {
      const typedSet = input.kind === "source" ? sourceIds : operationIds;
      if (!typedSet.has(input.id)) {
        issues.push(
          `operation ${operation.id} references unknown ${input.kind} ${input.id}`,
        );
        continue;
      }
      const inputKey = `${input.kind}:${input.id}`;
      if (seenInputs.has(inputKey)) {
        issues.push(`operation ${operation.id} repeats input ${input.id}`);
        continue;
      }
      seenInputs.add(inputKey);
      addOutgoing(input.id, operation.id);
    }
  }
  return outgoing;
};

const validateOutputs = (
  plan: RecipeFlowPlan,
  outgoing: Map<string, Set<string>>,
  issues: string[],
): Set<string> => {
  const operationIds = new Set(
    plan.operations.map((operation) => operation.id),
  );
  const outputIds = new Set<string>();
  for (const outputId of plan.outputOperationIds) {
    if (outputIds.has(outputId)) {
      issues.push(`output operation ${outputId} is listed more than once`);
    }
    outputIds.add(outputId);
    if (!operationIds.has(outputId)) {
      issues.push(`unknown output operation ${outputId}`);
    } else if ((outgoing.get(outputId)?.size ?? 0) > 0) {
      issues.push(`output operation ${outputId} is not terminal`);
    }
  }
  return outputIds;
};

const validateOperationCycles = (plan: RecipeFlowPlan, issues: string[]) => {
  const visitState = new Map<string, "visiting" | "visited">();
  const visitOperation = (id: string) => {
    const state = visitState.get(id);
    if (state === "visiting") {
      issues.push(`operation dependency cycle includes ${id}`);
      return;
    }
    if (state === "visited") return;
    visitState.set(id, "visiting");
    const operation = plan.operations.find((candidate) => candidate.id === id);
    for (const input of operation?.inputs ?? []) {
      if (input.kind === "operation") visitOperation(input.id);
    }
    visitState.set(id, "visited");
  };
  for (const operation of plan.operations) visitOperation(operation.id);
};

const reachesOutput = (
  start: string,
  outputIds: Set<string>,
  outgoing: Map<string, Set<string>>,
): boolean => {
  const pending = [start];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || seen.has(id)) continue;
    if (outputIds.has(id)) return true;
    seen.add(id);
    pending.push(...(outgoing.get(id) ?? []));
  }
  return false;
};

const validateReachability = (
  plan: RecipeFlowPlan,
  outputIds: Set<string>,
  outgoing: Map<string, Set<string>>,
  issues: string[],
) => {
  for (const source of plan.sources) {
    if (!reachesOutput(source.id, outputIds, outgoing)) {
      issues.push(`source ${source.id} does not reach an output`);
    }
  }
  for (const operation of plan.operations) {
    if (!reachesOutput(operation.id, outputIds, outgoing)) {
      issues.push(`operation ${operation.id} does not reach an output`);
    }
  }
};

const appendCoverageWarnings = (
  recipe: RecipeOut,
  plan: RecipeFlowPlan,
  warnings: RecipeFlowWarning[],
) => {
  const coveredInstructions = new Set<string>();
  for (const node of [...plan.setup, ...plan.operations]) {
    for (const ref of node.instructionRefs) {
      coveredInstructions.add(instructionRefKey(ref));
    }
  }
  for (const source of plan.sources) {
    if (source.kind !== "unlisted") continue;
    for (const ref of source.instructionRefs) {
      coveredInstructions.add(instructionRefKey(ref));
    }
  }
  for (const section of recipe.sections) {
    section.instructions.forEach((_instruction, instructionIndex) => {
      const ref = { sectionId: section.id, instructionIndex };
      if (coveredInstructions.has(instructionRefKey(ref))) return;
      warnings.push({
        code: "unreferenced-instruction",
        message: `Instruction ${instructionIndex + 1} in ${section.name ?? "the recipe"} is not represented in the flow.`,
        nodeIds: [],
      });
    });
  }
};

export function validateRecipeFlowPlan(
  recipe: RecipeOut,
  plan: RecipeFlowPlan,
): RecipeFlowValidationResult {
  const issues: string[] = [];
  const warnings: RecipeFlowWarning[] = [];
  const sections = new Map(
    recipe.sections.map((section) => [section.id, section]),
  );

  validateNodeIds(plan, issues);
  validateSetup(plan, sections, issues);
  validateSources(recipe, plan, sections, issues, warnings);
  const outgoing = validateOperations(plan, sections, issues);
  const outputIds = validateOutputs(plan, outgoing, issues);
  validateOperationCycles(plan, issues);
  validateReachability(plan, outputIds, outgoing, issues);
  appendCoverageWarnings(recipe, plan, warnings);
  if (plan.outputOperationIds.length > 1) {
    warnings.push({
      code: "multiple-outputs",
      message: "This recipe finishes with multiple independent outputs.",
      nodeIds: plan.outputOperationIds,
    });
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, warnings };
}
