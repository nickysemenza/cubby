import type { ReportBlock } from "@cubby/schemas/entity-report";
import {
  RUN_KINDS,
  isStepRunPurpose,
  type RunStepDeclaration,
} from "@cubby/schemas/run-fields";
import {
  sweepRunInput,
  SWEEP_FAMILY_LABEL,
  runWorkLabel,
  type SweepFamilyScope,
} from "@cubby/schemas/run-fields";
import { runStepMeta } from "@cubby/schemas/run-step";

import type { RunDetailStep } from "~/contracts/run-detail.contract";
import { formatCalendarDay } from "~/lib/date-format";
import { formatCount } from "~/lib/number-format";

type PlanStep = Pick<
  RunDetailStep,
  | "key"
  | "label"
  | "state"
  | "found"
  | "done"
  | "failed"
  | "skipped"
  | "pages"
  | "meta"
>;

export function declaredRunSteps(
  purpose: string,
  input: unknown,
): readonly RunStepDeclaration[] {
  if (!isStepRunPurpose(purpose)) return [];
  const families =
    purpose === "sweep"
      ? sweepRunInput.safeParse(input).data?.families
      : undefined;
  const declarations: readonly RunStepDeclaration[] = RUN_KINDS[purpose].steps;
  return declarations.filter(
    (step) =>
      purpose !== "sweep" ||
      !step.family ||
      families?.some((entry) => entry.family === step.family),
  );
}

/** Scope summaries expose the extent of a selection, never private source identifiers. */
function scopeLabel(entry: SweepFamilyScope) {
  const scope = entry.scope;
  const parts: string[] = [];
  if ("accountIds" in scope && scope.accountIds)
    parts.push(`${scope.accountIds.length} selected accounts`);
  if ("importId" in scope && scope.importId) parts.push("Selected import");
  if ("since" in scope && scope.since)
    parts.push(`Since ${formatCalendarDay(scope.since, "dateShort")}`);
  if ("entityKinds" in scope && scope.entityKinds)
    parts.push(scope.entityKinds.join(", "));
  if ("targets" in scope && scope.targets)
    parts.push(
      ...scope.targets.map(
        (target) =>
          `${target.entity}: ${target.fields.join(", ")}${Object.keys(target.filters).length ? " (filtered)" : ""}`,
      ),
    );
  return parts.join(" · ") || "All eligible inputs";
}

/** Both clients render this declared plan through the generic report/StaticTable path. */
export function runPlanBlocks(run: {
  purpose: string;
  input: unknown;
  steps: readonly PlanStep[];
}): ReportBlock[] {
  if (!isStepRunPurpose(run.purpose)) return [];
  const families =
    run.purpose === "sweep"
      ? sweepRunInput.safeParse(run.input).data?.families
      : undefined;
  // Unreadable historical input cannot establish which families were selected.
  const plan = declaredRunSteps(run.purpose, run.input);
  const selected = new Set(plan.map((step) => step.key));
  const historical = run.steps.filter((step) => !selected.has(step.key));
  const resultText = (step: PlanStep | undefined) => {
    if (!step || (step.state === "queued" && step.pages === 0))
      return "No results yet";
    const tallies = runStepMeta.safeParse(step.meta).data?.tallies;
    const outcomes = Object.entries(tallies ?? {}).map(
      ([key, value]) => `${formatCount(value)} ${key.replaceAll("_", " ")}`,
    );
    return [
      ...outcomes,
      `${formatCount(step.done)} processed`,
      `${formatCount(step.failed)} failed`,
      `${formatCount(step.skipped)} skipped`,
    ].join(" · ");
  };
  return [
    {
      kind: "note",
      text: `${runWorkLabel(run)}${run.purpose === "sweep" ? " · Purpose: Sweep" : ""}${families ? ` · Selected families: ${families.map((entry) => SWEEP_FAMILY_LABEL[entry.family]).join(", ")}` : run.purpose === "sweep" ? " · Selected families unavailable in historical input" : ""}`,
    },
    {
      kind: "table",
      title: "Plan",
      columns: ["Step", "Purpose", "Scope", "Input", "State", "Results"],
      rows: plan.map((declaration, index) => {
        const stored = run.steps.find((step) => step.key === declaration.key);
        const family = families?.find(
          (entry) => entry.family === declaration.family,
        );
        const frozen = runStepMeta.safeParse(stored?.meta).data?.input;
        return {
          id: declaration.key,
          cells: [
            `${index + 1}. ${declaration.label}`,
            declaration.purpose,
            family ? scopeLabel(family) : "All eligible inputs",
            declaration.input.mode === "tally"
              ? "Tally · no fixed input count"
              : stored && (frozen || stored.pages > 0)
                ? `${declaration.input.mode === "estimate" ? "About " : ""}${formatCount(frozen?.total ?? stored.found)} ${declaration.unit}`
                : "Counted when step starts",
            stored
              ? stored.state === "queued"
                ? stored.pages > 0
                  ? "Queued to resume"
                  : "Not started"
                : stored.state
              : "Not started",
            `${resultText(stored)}${declaration.results ? ` · ${declaration.results.family.replaceAll("_", " ")} Suggestions` : ""}`,
          ],
        };
      }),
      empty: "No active declared steps can be established for this Run.",
    },
    ...(historical.length
      ? [
          {
            kind: "note" as const,
            text: "Historical steps below are stored execution history outside the current declared plan; they are not additional planned work.",
          },
          {
            kind: "table" as const,
            title: "Historical steps",
            columns: ["Step", "State", "Results"],
            rows: historical.map((step) => ({
              id: step.key,
              cells: [step.label, step.state, resultText(step)],
            })),
          },
        ]
      : []),
  ];
}
