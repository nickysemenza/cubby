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
  type SweepFamilyScope,
} from "@cubby/schemas/run-fields";
import { runStepMeta } from "@cubby/schemas/run-step";
import {
  readRunWorkPhase,
  runWorkEstimate,
  formatRunWorkEstimate,
} from "@cubby/schemas/run-work-progress";

import type { RunDetailStep } from "~/contracts/run-detail.contract";
import { formatCalendarDay } from "~/lib/date-format";
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
type InputListHref = (
  entity: "financialTransaction" | "sourceTransactionRecord",
  token: string,
) => string;
type PlanTableRow = Extract<ReportBlock, { kind: "table" }>["rows"][number];

function stepState(step: PlanStep | undefined) {
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

/** These are current selector views; counted membership was not retained as a snapshot. */
function inputInspection(
  runId: string | undefined,
  key: string,
  counted: boolean,
  inputHref: InputListHref | undefined,
) {
  if (!runId) return null;
  const list = (
    entity: "financialTransaction" | "sourceTransactionRecord",
    label: string,
  ) => ({
    label,
    href: inputHref ? inputHref(entity, `${runId}:${key}`) : "",
  });
  const current = counted
    ? "Current eligibility under the Run scope and recorded cutoff; original membership was not saved."
    : "Input inspection becomes available when this step records its count and selection boundary.";
  switch (key) {
    case "transfer_pair_scan":
      return {
        kind: "links",
        links:
          counted && inputHref
            ? [
                list("financialTransaction", "Transactions"),
                list("sourceTransactionRecord", "Source records"),
              ]
            : [],
        note: `Live categorized source charge keys, plus dated observed/pending/posted transactions without a transfer that have a movement kind or category. Date/cutoff apply; accounts are checked later. Source rows include every live observation for selected keys, so row counts differ. ${current}`,
      } satisfies NonNullable<PlanTableRow["presentation"]>[string];
    case "statement_generate":
      return {
        kind: "links",
        links:
          counted && inputHref
            ? [
                list(
                  "sourceTransactionRecord",
                  "Source records for eligible charges",
                ),
              ]
            : [],
        note: `Non-ignored, non-superseded charges needing a match, lifecycle correction or spending booking. Import/date scope selects charge keys; account admission happens later. All live observations for selected keys are shown, so row counts differ. ${current}`,
      } satisfies NonNullable<PlanTableRow["presentation"]>[string];
    case "statement_holds":
      return {
        kind: "links",
        links:
          counted && inputHref
            ? [list("financialTransaction", "Pending transactions to inspect")]
            : [],
        note: `Live pending transactions in selected accounts whose settlement references all have provider-pending evidence. Import/date restrictions do not apply. Inspection does not imply a hold can be voided. ${current}`,
      } satisfies NonNullable<PlanTableRow["presentation"]>[string];
    case "transfer_pair_retire":
    case "transfer_pair_label":
    case "statement_label":
      return {
        kind: "links",
        links: [
          {
            label: "View this Run’s decisions",
            href: `/runs/${encodeURIComponent(runId)}#decisions`,
          },
        ],
        note:
          key === "transfer_pair_retire"
            ? "Stored transfer-pair assessments in account/date/cutoff scope, including inactive or reviewed ones. Related decisions are not an exact input list."
            : key === "transfer_pair_label"
              ? "This Run’s pending pairs needing labels, or pairs awaiting statement refresh. Related decisions are not an exact input list."
              : "Current pending statement advice needing a label or application, optionally restricted by import. This population can span Runs; the link shows only this Run’s decisions.",
      } satisfies NonNullable<PlanTableRow["presentation"]>[string];
    default:
      return null;
  }
}

/** Both clients render this declared plan through the generic report/StaticTable path. */
export function runPlanBlocks(
  run: {
    purpose: string;
    runId?: string;
    inputHref?: InputListHref;
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
      text: `${runWorkLabel(run)}${run.purpose === "sweep" ? " · Purpose: Sweep" : ""}${families ? ` · Selected families: ${families.map((entry) => SWEEP_FAMILY_LABEL[entry.family]).join(", ")}` : run.purpose === "sweep" ? " · Selected families unavailable in historical input" : ""}`,
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
        const inspection = inputInspection(
          run.runId,
          declaration.key,
          frozen?.mode === "count",
          run.inputHref,
        );
        return {
          id: declaration.key,
          presentation: {
            "4": { kind: "status", state: state.state },
            "6": { kind: "figure" },
            ...(inspection ? { "3": inspection } : {}),
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
