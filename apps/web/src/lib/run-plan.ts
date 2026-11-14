import type { ReportBlock, ReportRowState } from "@cubby/schemas/entity-report";
import {
  RUN_KINDS,
  isStepRunPurpose,
  type RunStepDeclaration,
} from "@cubby/schemas/run-fields";
import {
  sweepRunInput,
  SWEEP_FAMILY_LABEL,
  runWorkLabel,
  type StoredSweepFamilyScope,
  RETIRED_SWEEP_FAMILY_LABEL,
  isExecutableSweepFamily,
} from "@cubby/schemas/run-fields";
import { runStepMeta } from "@cubby/schemas/run-step";
import {
  readRunWorkPhase,
  runWorkEstimate,
  formatRunWorkEstimate,
} from "@cubby/schemas/run-work-progress";

import type { RunDetailStep } from "~/contracts/run-detail.contract";
import { formatDuration } from "~/lib/format-duration";
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
> &
  Partial<{ [K in "startedAt" | "endedAt"]: RunDetailStep[K] | Date }>;

type PlanTableRow = Extract<ReportBlock, { kind: "table" }>["rows"][number];

function stepState(step: PlanStep | undefined) {
  if (step && runStepMeta.safeParse(step.meta).data?.retired)
    return {
      label: "Retired",
      state: "not_reached",
    } satisfies { label: string; state: ReportRowState };
  if (!step || step.state === "queued")
    return {
      label: step && step.pages > 0 ? "Queued to resume" : "Not started",
      state: "not_reached",
    } satisfies { label: string; state: ReportRowState };
  const states = {
    running: { label: "Running", state: "running" },
    waiting: { label: "Waiting", state: "warning" },
    paused: { label: "Paused", state: "warning" },
    failed: { label: "Failed", state: "failed" },
    done: { label: "Done", state: "done" },
  } satisfies Record<
    Exclude<PlanStep["state"], "queued">,
    { label: string; state: ReportRowState }
  >;
  return states[step.state];
}

const atMs = (at: Date | string) =>
  at instanceof Date ? at.getTime() : Date.parse(at);
function stepTiming(step: PlanStep | undefined, now: Date) {
  const start = step?.startedAt ? atMs(step.startedAt) : null;
  const end = step?.endedAt
    ? atMs(step.endedAt)
    : step && !["done", "failed"].includes(step.state)
      ? now.getTime()
      : null;
  const elapsed =
    start !== null &&
    end !== null &&
    Number.isFinite(start) &&
    Number.isFinite(end)
      ? formatDuration(Math.max(0, end - start))
      : "—";
  if (!step || (step.state === "queued" && step.pages === 0))
    return [elapsed, "Not estimated"];
  if (step.state === "done" || step.state === "failed") return [elapsed, "—"];
  if (step.state !== "running") return [elapsed, "Waiting"];
  const sample = runStepMeta.safeParse(step.meta).data?.work?.current;
  if (!sample) return [elapsed, "Collecting observations"];
  const live = readRunWorkPhase(sample, "running", now);
  if (live.estimateState !== "current" || live.state !== "running")
    return [elapsed, "Not estimated"];
  const estimate = runWorkEstimate(sample);
  return [
    elapsed,
    estimate
      ? formatRunWorkEstimate(estimate).split(" · ").slice(0, 2).join(" · ")
      : "Collecting observations",
  ];
}

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

const sweepFamilyLabel = (entry: StoredSweepFamilyScope) =>
  isExecutableSweepFamily(entry)
    ? SWEEP_FAMILY_LABEL[entry.family]
    : `${RETIRED_SWEEP_FAMILY_LABEL[entry.family]} (retired)`;

/** Scope summaries expose the extent of a selection, never private source identifiers. */
function scopeLabel(entry: StoredSweepFamilyScope) {
  if (!isExecutableSweepFamily(entry)) return "Retired, not run";
  const scope = entry.scope;
  const parts: string[] = [];
  if ("targets" in scope && scope.targets)
    parts.push(
      ...scope.targets.map(
        (target) =>
          `${target.entity}: ${target.fields.join(", ")}${Object.keys(target.filters).length ? " (filtered)" : ""}`,
      ),
    );
  return parts.join(" · ") || "All eligible inputs";
}

export function runPlanBlocks(
  run: {
    purpose: string;
    runId?: string;

    input: unknown;
    steps: readonly PlanStep[];
  },
  now = new Date(),
): ReportBlock[] {
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
      text: `${runWorkLabel(run)}${run.purpose === "sweep" ? " · Purpose: Sweep" : ""}${families ? ` · Selected families: ${families.map((entry) => sweepFamilyLabel(entry)).join(", ")}` : run.purpose === "sweep" ? " · Selected families unavailable in historical input" : ""}`,
    },
    {
      kind: "table",
      title: "Plan",
      columns: [
        "Step",
        "Purpose",
        "Scope",
        "Input",
        "State",
        "Results",
        "Elapsed (wall)",
        "Step ETA",
      ],
      rows: plan.map((declaration, index): PlanTableRow => {
        const stored = run.steps.find((step) => step.key === declaration.key);
        const family = families?.find(
          (entry) => entry.family === declaration.family,
        );
        const frozen = runStepMeta.safeParse(stored?.meta).data?.input;
        const state = stepState(stored);
        return {
          id: declaration.key,
          presentation: {
            "4": { kind: "status", state: state.state },
            "6": { kind: "figure" },
          },
          cells: [
            `${index + 1}. ${declaration.label}`,
            declaration.purpose,
            family ? scopeLabel(family) : "All eligible inputs",
            declaration.input.mode === "tally"
              ? "Tally · no fixed input count"
              : stored && (frozen || stored.pages > 0)
                ? `${declaration.input.mode === "estimate" ? "About " : ""}${formatCount(frozen?.total ?? stored.found)} ${declaration.unit}`
                : "Counted when step starts",
            state.label,
            `${resultText(stored)}${declaration.results ? ` · ${declaration.results.family.replaceAll("_", " ")} Suggestions` : ""}`,
            ...stepTiming(stored, now),
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
            columns: ["Step", "State", "Results", "Elapsed (wall)", "Step ETA"],
            rows: historical.map((step): PlanTableRow => ({
              id: step.key,
              cells: [
                step.label,
                stepState(step).label,
                resultText(step),
                ...stepTiming(step, now),
              ],
              presentation: {
                "1": { kind: "status", state: stepState(step).state },
                "3": { kind: "figure" },
              },
            })),
          },
        ]
      : []),
  ];
}
