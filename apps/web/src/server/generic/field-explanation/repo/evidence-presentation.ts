import { type Entity } from "@cubby/schemas/entity";
import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";
import type { ReportRecordRow } from "@cubby/schemas/entity-report";
import { entitySummary } from "@cubby/schemas/entity-summary";
import type {
  FieldDecisionStep,
  FieldExplanationOutput,
} from "@cubby/schemas/field-explanation";
import { type FieldResolution } from "@cubby/schemas/field-resolution";
import { humanize, parseShortcode } from "@cubby/shared";
import { z } from "zod";

import type { Database } from "~/server/db";
import { shortcodeLabels } from "~/server/generic/shortcode/repo/shortcode-labels";

export type Evidence = NonNullable<
  FieldExplanationOutput["resolutionEvidence"]
>;
export type Json = z.infer<ReturnType<typeof z.json>>;
type Ref = Pick<
  NonNullable<Evidence["fallbackSource"]>,
  "entityKind" | "entityId"
>;

/** One place a value could come from, before its role in the chain is known. */
export type Step = {
  title: string;
  ref: Ref | null;
  value: Json;
  assigned: boolean;
  /** Supplies the value when no source entity identifies the winner. */
  self?: boolean;
  /** What an assigned null means at this step, over the field's None label. */
  nullLabel?: string;
  unavailableReason?: string;
  decision?: Pick<
    FieldDecisionStep,
    "source" | "reason" | "effect" | "observed"
  >;
  branch?: FieldDecisionStep["branch"];
  lines?: ReportRecordRow["lines"];
};

export const thisRecord = (entity: Entity) =>
  `This ${entitySummary[entity].singular.toLowerCase()}`;

/** The subject's own stored intent, first in every chain it is not part of. */
export const selfStep = (
  entity: Entity,
  resolution: FieldResolution,
): Step => ({
  title: thisRecord(entity),
  ref: null,
  value: resolution.storedValue,
  assigned:
    resolution.mode === "explicit" ||
    (resolution.mode === "none" && resolution.canReset) ||
    (resolution.mode === "allocated" && resolution.storedValue !== null),
  self: true,
});

const DECISION_REASONS = {
  assigned: "A value is assigned at this source.",
  not_set: "No value is assigned at this source; continue to the next source.",
  explicit:
    "The individual owner is set on this inventory entry and overrides acquisition defaults.",
  household:
    "This inventory entry explicitly records Household stock, with no individual owner.",
  inherit:
    "This inventory entry inherits its owner from current acquisition evidence.",
  acquisition_absent:
    "No applicable acquisition is recorded. Inherited ownership is unknown.",
  acquisition_multiple:
    "Multiple distinct acquisitions are recorded. They cannot supply one inherited owner.",
  acquisition_single:
    "Exactly one applicable acquisition supplies the ownership context. Only acquisition lines count; funders and purchasers do not establish ownership.",
  beneficiary_absent:
    "No beneficiary attribution is recorded on the applicable acquisition lines; account defaults may apply.",
  beneficiary_unknown:
    "All beneficiary shares have unknown parties; no ownership decision is recorded, so account defaults may apply.",
  beneficiary_incomplete:
    "Some applicable acquisition lines lack beneficiary attribution. Incomplete coverage blocks account defaults.",
  beneficiary_split:
    "An applicable acquisition line has split beneficiary attribution. It cannot establish a single owner and blocks account defaults.",
  beneficiary_unresolved:
    "Some beneficiary attribution names an individual while another share has no resolved party. Partial attribution blocks account defaults.",
  beneficiary_not_individual:
    "A beneficiary party is unavailable or is not a live member or guest. It cannot establish an individual owner and blocks account defaults.",
  beneficiary_conflict:
    "The applicable acquisition lines name different beneficiaries. Conflicting evidence blocks account defaults.",
  beneficiary_agreement:
    "Every applicable acquisition line wholly names the same live member or guest as beneficiary.",
  vendor_absent:
    "No live vendor account default is available; payment account defaults may apply.",
  vendor_disabled:
    "The vendor account's inventory owner default is off. Its associated party does not supply an owner; payment defaults may apply.",
  vendor_unusable:
    "The vendor account's inventory owner default is on, but its associated party is not a live member or guest. This blocks payment account fallback.",
  vendor_enabled:
    "The vendor account's inventory owner default is on and its associated party is a live member or guest.",
  payment_absent:
    "No qualifying positive payment allocation from a live account is recorded. Inherited ownership remains unknown.",
  payment_disabled:
    "At least one qualifying payment account has its inventory owner default off. Every payment must be enabled and agree on an individual party.",
  payment_unresolved:
    "At least one qualifying payment account has no resolved party. Account holders alone do not establish ownership.",
  payment_not_individual:
    "At least one qualifying payment account's party is unavailable or is not a live member or guest.",
  payment_conflict:
    "The qualifying payment accounts name different individual parties. They cannot establish a single owner.",
  payment_agreement:
    "Every qualifying payment account has its inventory owner default on and all name the same live member or guest.",
} satisfies Record<FieldDecisionStep["reason"], string>;

/** The step that supplies the value: the subject's own for explicit/none,
 * otherwise the resolution's source record, else the first assigned step
 * after the subject (sources outside the ladder are appended). */
export function winnerIndex(
  steps: readonly Step[],
  resolution: FieldResolution,
): number {
  if (
    resolution.mode === "explicit" ||
    (resolution.mode === "none" && resolution.canReset)
  )
    return steps.findIndex((step) => step.self);
  const id = resolution.sourceEntity?.entityId;
  const byRef = id
    ? steps.findIndex(
        (step) =>
          step.ref?.entityId === id && step.assigned && !step.unavailableReason,
      )
    : -1;
  if (byRef >= 0) return byRef;
  if (resolution.value === null)
    return steps.findIndex(
      (step) =>
        !step.self &&
        step.assigned &&
        !step.unavailableReason &&
        step.nullLabel !== undefined,
    );
  return steps.findIndex(
    (step) => !step.self && step.assigned && !step.unavailableReason,
  );
}

const SPENDING_BINDING = z.object({
  mode: z.string(),
  category: z.string().nullable(),
});

/** A stored value as words: record codes become their labels, enums their
 * option labels, spending bindings their category (or "Blocked"). */
export function valueText(
  value: Json,
  entity: Entity,
  field: string,
  labels: Map<string, string>,
  noneLabel: string | undefined,
): string {
  if (value === null) return noneLabel ?? "Not set";
  const binding = SPENDING_BINDING.safeParse(value);
  if (binding.success)
    return binding.data.mode === "blocked"
      ? "Blocked"
      : valueText(binding.data.category, entity, field, labels, noneLabel);
  if (Array.isArray(value))
    return value.length === 0
      ? (noneLabel ?? "None")
      : value
          .map((item) => valueText(item, entity, field, labels, noneLabel))
          .join(", ");
  if (typeof value === "string") {
    const code = parseShortcode(value);
    if (code) return labels.get(code.shortcode) ?? code.shortcode;
    const model = entityFieldModels[entity].fields.find(
      (candidate) => candidate.key === field,
    );
    const option = (
      model?.control?.options ??
      model?.display.valueOptions ??
      []
    ).find((candidate) => candidate.value === value);
    return option?.label ?? humanize(value);
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

export const collectCodes = (value: Json, into: Set<string>) => {
  if (typeof value === "string") {
    const code = parseShortcode(value);
    if (code) into.add(code.shortcode);
  } else if (Array.isArray(value))
    for (const item of value) collectCodes(item, into);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) collectCodes(item ?? null, into);
};

export async function labelsForSteps(db: Database, steps: readonly Step[]) {
  const codes = new Set<string>();
  for (const step of steps) {
    collectCodes(step.value, codes);
    for (const observation of step.decision?.observed ?? []) {
      if (observation.entity) codes.add(observation.entity.entityId);
      collectCodes(observation.value, codes);
    }
  }
  return shortcodeLabels(db, [...codes]);
}

export async function chainBlock(
  db: Database,
  entity: Entity,
  field: string,
  steps: Step[],
  winner: number,
  loadedLabels?: Map<string, string>,
): Promise<Evidence["chain"]> {
  const labels = loadedLabels ?? (await labelsForSteps(db, steps));
  const model = entityFieldModels[entity].fields.find(
    (candidate) => candidate.key === field,
  );
  const resolution:
    | EntityFieldModel["fields"][number]["resolution"]
    | undefined = model?.resolution;
  const noneLabel = resolution?.labels?.none;
  const rows: ReportRecordRow[] = steps
    .slice(0, MAX_CHAIN_ROWS)
    .map((step, index) => {
      const effect = step.decision?.effect;
      const state: NonNullable<ReportRecordRow["state"]> =
        step.unavailableReason
          ? { kind: "skipped", label: step.unavailableReason }
          : effect === "used"
            ? { kind: "done", label: "Used" }
            : effect === "blocked"
              ? { kind: "skipped", label: "Blocks fallback" }
              : effect === "overridden"
                ? { kind: "skipped", label: "Evaluated · overridden" }
                : effect === "context"
                  ? { kind: "done", label: "Context" }
                  : effect === "fallback"
                    ? { kind: "skipped", label: "Continue" }
                    : index === winner
                      ? { kind: "done", label: "Used" }
                      : !step.assigned
                        ? { kind: "skipped", label: "Not set" }
                        : winner >= 0 && index > winner
                          ? { kind: "skipped", label: "Evaluated · overridden" }
                          : { kind: "skipped", label: "Not used" };
      return {
        entity: step.ref?.entityKind ?? null,
        id: step.ref?.entityId ?? null,
        title: step.title,
        lines: step.decision
          ? [
              { text: DECISION_REASONS[step.decision.reason], tone: "muted" },
              ...step.decision.observed.flatMap((observation) => {
                const text = observationText(observation, labels);
                return text ? [{ text, tone: "muted" as const }] : [];
              }),
            ]
          : [
              {
                text: step.assigned
                  ? DECISION_REASONS.assigned
                  : DECISION_REASONS.not_set,
                tone: "muted",
              },
            ],
        trailing:
          step.decision?.source === "acquisition"
            ? null
            : step.assigned
              ? valueText(
                  step.value,
                  entity,
                  field,
                  labels,
                  step.nullLabel ?? noneLabel,
                )
              : null,
        state,
      };
    });
  return {
    kind: "records",
    presentation: "timeline",
    rows,
    empty: "Nothing to inherit from",
  };
}

export const coverage = (total: number, shown: number) => ({
  total,
  shown,
  omitted: total - shown,
});
const MAX_CHAIN_ROWS = 50;
const MAX_OBSERVATIONS = 50;

function observationText(
  observation: FieldDecisionStep["observed"][number],
  labels: Map<string, string>,
): string | null {
  const value = observation.value;
  const record =
    value !== null && !Array.isArray(value) && typeof value === "object"
      ? value
      : null;
  const party = record?.party;
  const partyRecord =
    party !== null && !Array.isArray(party) && typeof party === "object"
      ? party
      : null;
  const ref = observation.entity
    ? ` (${labels.get(observation.entity.entityId) ?? observation.entity.entityId})`
    : "";
  if (record && typeof record.inventoryOwnerDefaultEnabled === "boolean") {
    return `${observation.label}${ref}: inventory owner default ${record.inventoryOwnerDefaultEnabled ? "on" : "off"}; associated party: ${partyRecord?.name ?? "Unresolved"}${partyRecord?.kind ? ` (${partyRecord.kind})` : ""}${record.allocationAmount !== undefined ? `; allocation ${record.allocationAmount}` : ""}`;
  }
  if (record && Array.isArray(record.beneficiaries)) {
    const beneficiaries = record.beneficiaries.map((value) => {
      if (value === null || Array.isArray(value) || typeof value !== "object")
        return "Unresolved party";
      const party = value.party;
      return `${party && !Array.isArray(party) && typeof party === "object" ? `${party.name} (${party.kind})` : "Unresolved party"}; weight ${value.weight}`;
    });
    return `${observation.label}${ref}: ${beneficiaries.length ? beneficiaries.join("; ") : "No beneficiary attribution"}`;
  }
  return null;
}

export async function evidenceBlock(
  db: Database,
  entity: Entity,
  field: string,
  allSteps: Step[],
  winner: number,
  fallbackSource: Evidence["fallbackSource"],
  loadedLabels?: Map<string, string>,
): Promise<Evidence> {
  const steps = allSteps.slice(0, MAX_CHAIN_ROWS).map((step) =>
    step.decision
      ? {
          ...step,
          decision: {
            ...step.decision,
            observed: step.decision.observed.slice(0, MAX_OBSERVATIONS),
          },
        }
      : step,
  );
  const chain = await chainBlock(
    db,
    entity,
    field,
    steps,
    winner,
    loadedLabels,
  );
  const omittedObservations = allSteps
    .slice(0, steps.length)
    .reduce(
      (count, step) =>
        count +
        Math.max(0, (step.decision?.observed.length ?? 0) - MAX_OBSERVATIONS),
      0,
    );
  if (allSteps.length > steps.length || omittedObservations > 0)
    chain.footer = `${steps.length} of ${allSteps.length} decision steps shown; ${omittedObservations} observations omitted.`;
  return {
    chain,
    fallbackSource,
    coverage: coverage(allSteps.length, steps.length),
    steps: steps.map((step, rowIndex) => ({
      ...(step.decision ?? {
        source: step.ref?.entityKind ?? "self",
        reason: step.assigned ? ("assigned" as const) : ("not_set" as const),
        effect:
          rowIndex === winner
            ? ("used" as const)
            : !step.assigned
              ? ("fallback" as const)
              : winner >= 0 && rowIndex > winner
                ? ("overridden" as const)
                : ("context" as const),
        observed: [
          {
            label: step.title,
            entity: step.ref
              ? { entityKind: step.ref.entityKind, entityId: step.ref.entityId }
              : null,
            value: step.value,
          },
        ],
      }),
      rowIndex,
      ...(step.branch ? { branch: step.branch } : {}),
      ...(step.decision
        ? {
            coverage: coverage(
              allSteps[rowIndex]!.decision!.observed.length,
              step.decision.observed.length,
            ),
          }
        : {}),
    })),
  };
}

export const isTruncated = (evidence: Evidence) =>
  (evidence.coverage?.omitted ?? 0) > 0 ||
  (evidence.branches?.omitted ?? 0) > 0 ||
  evidence.steps?.some((step) => (step.coverage?.omitted ?? 0) > 0) === true;
export function resolutionOutcome(
  steps: Step[],
  resolution: FieldResolution,
): NonNullable<Evidence["outcome"]> {
  const winner = winnerIndex(steps, resolution);
  const binding = SPENDING_BINDING.safeParse(steps[winner]?.value);
  if (binding.success && binding.data.mode === "blocked") return "blocked";
  return resolution.value !== null || winner >= 0 ? "resolved" : "unset";
}
