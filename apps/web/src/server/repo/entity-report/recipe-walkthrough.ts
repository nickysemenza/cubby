import type { ReportBlock, ReportCommand } from "@cubby/schemas/entity-report";
import { recipeShortcode } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";
import { getRecipeByID } from "~/server/repo/recipe/crud";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { getRecipeFlowState } from "~/server/services/recipe-flow/recipe-flow.service";

/**
 * The AI walkthrough, read from the stored flow (a read never generates one): the overview, what
 * to do before starting, each stop with the recipe's own instructions it cites (shown unchanged),
 * and the steps as a table. The "map" layout of the same flow is a graph drawing and stays web's.
 * A missing or stale flow says so and offers the one command that generates it.
 */
export async function recipeWalkthroughReport(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  const id = await resolveOrThrow(db, "recipe", code);
  const [state, recipe] = await Promise.all([
    getRecipeFlowState(db, id),
    getRecipeByID(db, id),
  ]);
  const recipeId = recipeShortcode.parse(code);
  const generate = (force: boolean, label: string): ReportCommand => ({
    id: `generate-flow:${force ? "again" : "first"}`,
    label,
    prominent: !force,
    confirm: force
      ? "Ask the AI to arrange this recipe's steps again? It replaces the walkthrough and uses the model."
      : "Ask the AI to arrange this recipe's steps into a walkthrough? It uses the model and can take a minute.",
    request: { kind: "generate-recipe-flow", recipeId, force },
  });
  if (state.status === "missing" || !recipe)
    return [
      {
        kind: "records",
        rows: [],
        empty:
          "No walkthrough yet. The AI arranges the steps into stops with short explanations; the recipe's instructions stay unchanged.",
        commands: [generate(false, "Generate walkthrough")],
      },
    ];

  const { plan } = state.artifact;
  const sections = new Map(
    recipe.sections.map((section) => [section.id, section]),
  );
  const instructionLines = (
    refs: readonly { sectionId: string; instructionIndex: number }[],
  ) =>
    refs.flatMap((ref) => {
      const section = sections.get(ref.sectionId);
      const instruction = section?.instructions[ref.instructionIndex];
      return instruction
        ? [
            {
              text: `${section?.name ?? "Method"} · step ${ref.instructionIndex + 1}: ${instruction.instruction}`,
              tone: "muted" as const,
            },
          ]
        : [];
    });
  const annotationChips = (items: readonly { kind: string; text: string }[]) =>
    items.map((item) => ({
      label: `${item.kind}: ${item.text}`,
      tone: "muted" as const,
    }));
  const operations = new Map(plan.operations.map((op) => [op.id, op]));
  const usages = new Map(
    recipe.sections.flatMap((section) =>
      section.ingredients.map(
        (line) =>
          [
            line.id,
            line.ingredient?.name ?? line.recipe?.name ?? "Ingredient",
          ] as const,
      ),
    ),
  );
  const sourceLabel = (sourceId: string) => {
    const source = plan.sources.find((entry) => entry.id === sourceId);
    if (!source) return sourceId;
    return source.kind === "usage"
      ? (usages.get(source.usageId) ?? "Ingredient")
      : source.label;
  };
  const inputLabel = (input: { kind: "source" | "operation"; id: string }) => {
    if (input.kind === "source") return sourceLabel(input.id);
    const operation = operations.get(input.id);
    return operation?.outputLabel ?? operation?.label ?? input.id;
  };
  const walkthrough = plan.walkthrough;

  return [
    ...(state.status === "stale"
      ? [
          {
            kind: "note" as const,
            strong: true,
            tone: "warning" as const,
            text: "The recipe changed since this walkthrough was made. Generate it again to match.",
          },
        ]
      : []),
    ...(walkthrough
      ? [
          { kind: "note" as const, strong: true, text: walkthrough.overview },
          {
            kind: "note" as const,
            tone: "muted" as const,
            text: "AI arranges the steps and adds explanations. The recipe instructions are shown below unchanged. Ingredient amounts follow your selected scale; quantities written in instructions do not.",
          },
        ]
      : []),
    ...(plan.setup.length > 0
      ? [
          {
            kind: "records" as const,
            title: "Before you start",
            rows: plan.setup.map((setup) => ({
              entity: null,
              id: null,
              title: setup.label,
              subtitle: null,
              trailing: null,
              statuses: annotationChips(setup.annotations),
              lines: instructionLines(setup.instructionRefs),
            })),
            empty: "",
          },
        ]
      : []),
    ...(walkthrough
      ? [
          {
            kind: "records" as const,
            title: "Walkthrough",
            rows: walkthrough.stops.map((stop) => ({
              entity: null,
              id: null,
              title: stop.title,
              subtitle: stop.explanation,
              trailing: null,
              lines: stop.operationIds.flatMap((operationId) => {
                const operation = operations.get(operationId);
                return operation
                  ? [
                      { text: operation.label },
                      ...instructionLines(operation.instructionRefs),
                    ]
                  : [];
              }),
            })),
            empty: "",
          },
        ]
      : []),
    {
      kind: "table",
      title: "Steps",
      columns: ["Step", "Uses", "Makes", "Notes"],
      rows: plan.operations.map((operation) => ({
        id: operation.id,
        cells: [
          operation.label,
          operation.inputs.map(inputLabel).join(", "),
          operation.outputLabel ?? "",
          operation.annotations
            .map((item) => `${item.kind}: ${item.text}`)
            .join("; "),
        ],
      })),
    },
    {
      kind: "records",
      rows: [],
      empty: "",
      commands: [generate(true, "Generate again")],
    },
  ];
}
