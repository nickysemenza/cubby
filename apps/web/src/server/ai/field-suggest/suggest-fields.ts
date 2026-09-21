import type {
  FieldSuggestion,
  FieldSuggestionRemoval,
  FieldSuggestionsInput,
  FieldSuggestionsOut,
} from "@cubby/schemas/ai";
/**
 * `ai.suggestFields`: resolve every requested target of one entity's basis in
 * one round trip. Each target runs through {@link FIELD_SUGGEST_REGISTRY}'s
 * matching spec — enum targets classify with Jev, reference/text targets pick
 * from a roster with `runAiSelection`. In suggested-basis mode, a target
 * whose own basis names another requested target (`expense.trade`'s basis
 * includes `projectId`, itself a target when the caller asks for both) sees
 * that target's freshly resolved value when the client sent none of its own.
 * Provided-basis mode evaluates every target concurrently from supplied values.
 */
import { entityRefKey } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { resolveExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import {
  fieldResolutionsSchema,
  type FieldResolution,
  type FieldResolutions,
} from "@cubby/schemas/field-resolution";
import { z } from "zod";

import { classifyWithJev } from "~/server/ai/classify";
import { FIELD_SUGGESTION_FEATURE } from "~/server/ai/features";
import {
  FIELD_SUGGEST_REGISTRY,
  fieldSuggestSpecFor,
  type FieldSuggestSpec,
  type RawBasis,
  type ResolvedBasis,
} from "~/server/ai/field-suggest/registry";
import {
  decisionConfidence,
  runJevChoice,
  type JevPort,
} from "~/server/ai/jev";
import {
  type AiSelectionSpec,
  type AiSelectionUsage,
  runAiSelection,
} from "~/server/ai/selection";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { resolveDraftExpenseFields } from "~/server/repo/expense-inheritance";
import {
  lookupEntityLabels,
  resolveShortcodes,
} from "~/server/repo/shortcode-resolver";
import { resolveDraftTaskFields } from "~/server/repo/task-project-inheritance";

/** A client-supplied basis value beyond this length is truncated, not rejected. */
const MAX_BASIS_VALUE_LENGTH = 500;

/** Resolves reference-basis shortcodes to display names. The seam
 * `suggest-fields.unit.test.ts` fakes instead of standing up a database. */
type LabelResolverPort = (
  db: Database,
  codes: readonly string[],
) => Promise<Map<string, string>>;

const defaultResolveLabels: LabelResolverPort = async (db, codes) => {
  if (codes.length === 0) return new Map();
  const refs = await resolveShortcodes(db, codes);
  if (refs.size === 0) return new Map();
  const labels = await lookupEntityLabels(db, [...refs.values()]);
  const byCode = new Map<string, string>();
  for (const [code, ref] of refs) {
    const label = labels.get(entityRefKey(ref.entity, ref.id));
    if (label) byCode.set(code, label);
  }
  return byCode;
};

export interface SuggestFieldsPorts {
  jev?: JevPort;
  resolveLabels?: LabelResolverPort;
  force?: boolean;
  /** Test-only: overrides individual registry entries (fake rosters) without
   * a database. Keyed the same as `FIELD_SUGGEST_REGISTRY` (`"entity.field"`). */
  registry?: Partial<Record<string, FieldSuggestSpec>>;
  /** Test seam for authoritative draft inheritance. Production always uses
   * the repository resolvers below. */
  resolveInheritance?: (
    db: Database,
    input: FieldSuggestionsInput,
  ) => Promise<FieldResolutions>;
}

async function resolveSuggestionInheritance(
  db: Database,
  input: FieldSuggestionsInput,
): Promise<FieldResolutions> {
  const draft = { ...input.basis };
  const context = fieldResolutionContext(input.basis.__resolutionContext);
  for (const [field, resolution] of Object.entries(context)) {
    const stored = scalarBasisValue(resolution.storedValue);
    draft[field] = stored;
    if (input.entity === "task" && field === "projectId") {
      draft.projectMode =
        resolution.mode === "inherit" ? "inherit" : "explicit";
    }
    if (input.entity === "task" && field === "subjectProductId") {
      draft.subjectProductMode =
        resolution.mode === "inherit" ? "inherit" : "explicit";
    }
  }
  if (input.entity === "expense") {
    // SAFETY: the expense branch narrows the entity, and draft contains only
    // schema-validated suggestion basis values plus reconstructed raw intent.
    return resolveDraftExpenseFields(
      db,
      draft as Parameters<typeof resolveDraftExpenseFields>[1],
    );
  }
  if (input.entity === "task") {
    // SAFETY: the task branch narrows the entity, and draft contains only
    // schema-validated suggestion basis values plus reconstructed raw intent.
    return resolveDraftTaskFields(
      db,
      draft as Parameters<typeof resolveDraftTaskFields>[1],
    );
  }
  return {};
}

function fieldResolutionContext(
  raw: string | null | undefined,
): FieldResolutions {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return fieldResolutionsSchema.catch({}).parse(parsed);
  } catch {
    return {};
  }
}

function scalarBasisValue(value: FieldResolution["value"]): string | null {
  const scalar = z.string().safeParse(value);
  return scalar.success ? normalizeBasisValue(scalar.data) : null;
}

function normalizeBasisValue(
  raw: string | null | undefined,
  limit = MAX_BASIS_VALUE_LENGTH,
): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim().slice(0, limit);
  return trimmed === "" ? null : trimmed;
}

/**
 * Every requested target, keyed by its bare field name, resolved against
 * `ports.registry` first and {@link FIELD_SUGGEST_REGISTRY} otherwise.
 * Throws {@link createAppError} `SUGGEST_FIELD_UNKNOWN` for any target that
 * is neither — the manifest's `control.suggest` fields are the only valid
 * targets for `input.entity`.
 */
function resolveTargetSpecs(
  input: FieldSuggestionsInput,
  ports: SuggestFieldsPorts | undefined,
): Map<string, FieldSuggestSpec> {
  const targetSpecs = new Map<string, FieldSuggestSpec>();
  for (const target of input.targets) {
    const key = `${input.entity}.${target}`;
    const spec =
      ports?.registry?.[key] ??
      (Object.hasOwn(FIELD_SUGGEST_REGISTRY, key)
        ? fieldSuggestSpecFor(input.entity, target)
        : undefined);
    if (!spec) {
      throw createAppError(
        "SUGGEST_FIELD_UNKNOWN",
        `"${key}" is not a suggestible field.`,
      );
    }
    targetSpecs.set(target, spec);
  }
  return targetSpecs;
}

/** This target's raw `{key: value}` basis: the client's own value when
 * sent, else — only when the key is itself a requested target — that
 * target's just-resolved raw value. */
function effectiveRawBasis(
  basisKeys: readonly string[],
  clientBasis: ReadonlyMap<string, string | null>,
  requestedTargets: ReadonlySet<string>,
  resolvedRawByTarget: ReadonlyMap<string, string | null>,
  authoritativeKeys: ReadonlySet<string>,
): RawBasis {
  return Object.fromEntries(
    basisKeys.map((key) => {
      const clientValue = clientBasis.get(key) ?? null;
      const value = authoritativeKeys.has(key)
        ? clientValue
        : (clientValue ??
          (requestedTargets.has(key)
            ? (resolvedRawByTarget.get(key) ?? null)
            : null));
      return [key, value] as const;
    }),
  );
}

/**
 * Resolves a target's reference-typed basis keys (shortcodes) to display
 * names, leaving every other basis key's raw value untouched. `rawBasis`
 * itself is untouched — callers still need the raw shortcodes for a
 * reference roster (`inventory.locationId` needs `productId`, not its name).
 */
async function resolveDisplayBasis(
  db: Database,
  fields: readonly { key: string; reference: unknown }[],
  basisKeys: readonly string[],
  rawBasis: RawBasis,
  resolveLabels: LabelResolverPort,
): Promise<ResolvedBasis> {
  const referenceBasisKeys = basisKeys.filter((key) => {
    const field = fields.find((f) => f.key === key);
    return field?.reference != null && rawBasis[key] != null;
  });
  const codesToResolve = [
    ...new Set(referenceBasisKeys.map((key) => rawBasis[key]!)),
  ];
  const labelByCode =
    codesToResolve.length > 0
      ? await resolveLabels(db, codesToResolve)
      : new Map<string, string>();

  return Object.fromEntries(
    basisKeys.map((key) => {
      const raw = rawBasis[key] ?? null;
      const isReference = fields.find((f) => f.key === key)?.reference != null;
      const value = isReference
        ? raw != null
          ? (labelByCode.get(raw) ?? null)
          : null
        : raw;
      return [key, value];
    }),
  );
}

/** One target's resolved outcome: the suggestion to return, plus the raw
 * value (shortcode/enum member/string) a dependent sibling target chains. */
interface TargetResolution {
  suggestion: FieldSuggestion | null;
  rawValue: string | null;
}

const noSuggestion: TargetResolution = { suggestion: null, rawValue: null };

async function resolveEnumTarget(
  spec: Extract<FieldSuggestSpec, { kind: "enum" }>,
  subject: string,
  usage: AiSelectionUsage,
  jev: JevPort | undefined,
): Promise<TargetResolution> {
  const result = await classifyWithJev({
    feature: FIELD_SUGGESTION_FEATURE,
    subject,
    rules: spec.rules,
    values: spec.values,
    describe: spec.describe,
    usage,
    port: jev,
  });
  return {
    suggestion: {
      value: result.value,
      label: spec.labelOf?.(result.value) ?? result.value,
      detail: null,
      confidence: result.confidence,
      probability: result.probability,
      reasoning: result.reasoning,
      alternatives: result.alternatives.map((alternative) => ({
        value: alternative.value,
        label: spec.labelOf?.(alternative.value) ?? alternative.value,
        detail: null,
        probability: alternative.probability,
      })),
      operation: "set",
      removals: [],
    },
    rawValue: result.value,
  };
}

async function resolveReferenceTarget(
  db: Database,
  spec: Extract<FieldSuggestSpec, { kind: "reference" }>,
  subject: string,
  resolvedBasis: ResolvedBasis,
  rawBasis: RawBasis,
  usage: AiSelectionUsage,
  jev: JevPort | undefined,
): Promise<TargetResolution> {
  const candidates = await spec.roster(db, resolvedBasis, rawBasis);
  const selectionSpec: AiSelectionSpec<unknown> = {
    feature: FIELD_SUGGESTION_FEATURE,
    rules: spec.rules,
    idOf: spec.idOf,
    renderLine: spec.renderLine,
    maxCandidates: spec.maxCandidates,
  };
  const outcome = await runAiSelection(selectionSpec, {
    subject,
    candidates,
    usage,
    jev,
  });
  if (!outcome.selected) return noSuggestion;
  const value = spec.idOf(outcome.selected);
  return {
    suggestion: {
      value,
      label: spec.labelOf(outcome.selected),
      detail: spec.detailOf?.(outcome.selected) ?? null,
      confidence: outcome.confidence,
      probability: outcome.probability,
      reasoning: outcome.reasoning,
      alternatives: outcome.alternatives.map((alternative) => ({
        value: spec.idOf(alternative.candidate),
        label: spec.labelOf(alternative.candidate),
        detail: spec.detailOf?.(alternative.candidate) ?? null,
        probability: alternative.probability,
      })),
      operation: "set",
      removals: [],
    },
    rawValue: value,
  };
}

async function resolveTextTarget(
  db: Database,
  spec: Extract<FieldSuggestSpec, { kind: "text" }>,
  subject: string,
  resolvedBasis: ResolvedBasis,
  usage: AiSelectionUsage,
  jev: JevPort | undefined,
): Promise<TargetResolution> {
  const candidates = await spec.roster(db, resolvedBasis);
  const selectionSpec: AiSelectionSpec<string> = {
    feature: FIELD_SUGGESTION_FEATURE,
    rules: spec.rules,
    idOf: (value) => value,
    renderLine: (value) => value,
    maxCandidates: spec.maxCandidates,
  };
  const outcome = await runAiSelection(selectionSpec, {
    subject,
    candidates,
    usage,
    jev,
  });
  if (!outcome.selected) return noSuggestion;
  return {
    suggestion: {
      value: outcome.selected,
      label: outcome.selected,
      detail: null,
      confidence: outcome.confidence,
      probability: outcome.probability,
      reasoning: outcome.reasoning,
      alternatives: outcome.alternatives.map((alternative) => ({
        value: alternative.candidate,
        label: alternative.candidate,
        detail: null,
        probability: alternative.probability,
      })),
      operation: "set",
      removals: [],
    },
    rawValue: outcome.selected,
  };
}

/** Dispatches to `resolvePruneTarget` or `resolveOneTarget`, the one place
 * `suggestFields`'s per-target resolution branches on `spec.kind === "prune"`
 * (a prune spec's `subject` takes a per-candidate `value`, so it can't share
 * `resolveOneTarget`'s pre-computed `subject` string). */
async function resolveSpec(
  db: Database,
  spec: FieldSuggestSpec,
  resolvedBasis: ResolvedBasis,
  rawBasis: RawBasis,
  usage: AiSelectionUsage,
  jev: JevPort | undefined,
): Promise<TargetResolution> {
  if (spec.kind === "prune") {
    return resolvePruneTarget(db, spec, resolvedBasis, rawBasis, usage, jev);
  }
  return resolveOneTarget(
    db,
    spec,
    spec.subject(resolvedBasis),
    resolvedBasis,
    rawBasis,
    usage,
    jev,
  );
}

async function resolveOneTarget(
  db: Database,
  spec: Exclude<FieldSuggestSpec, { kind: "prune" }>,
  subject: string,
  resolvedBasis: ResolvedBasis,
  rawBasis: RawBasis,
  usage: AiSelectionUsage,
  jev: JevPort | undefined,
): Promise<TargetResolution> {
  if (spec.kind === "enum") {
    return resolveEnumTarget(spec, subject, usage, jev);
  }
  if (spec.kind === "reference") {
    return resolveReferenceTarget(
      db,
      spec,
      subject,
      resolvedBasis,
      rawBasis,
      usage,
      jev,
    );
  }
  return resolveTextTarget(db, spec, subject, resolvedBasis, usage, jev);
}

/** A tag's stored removal reason for a Jev-classified (not deterministic)
 * hit — deliberately terser than the Jev choice label below, which is the
 * full instruction text the model sees. */
const JEV_TAG_REMOVAL_REASON = "a sibling field";
/** `runJevChoice`'s two per-tag criteria: index 0 is "redundant", index 1 is
 * "genuine" — `resolvePruneTarget` only ever acts on index 0. */
const TAG_PRUNE_CHOICES = [
  "Restates the manufacturer, the classification, or a generic category word already recorded elsewhere on the product.",
  "A genuine compatibility or ecosystem token (a battery platform, mount, thread, or size standard) worth keeping.",
] as const;
/** A removal needs at least this calibrated probability to surface — the
 * same "high confidence" floor a `set` suggestion auto-applies at. */
const PRUNE_INCLUDE_THRESHOLD = 0.85;

/**
 * Resolves a `mode: "prune"` target: every current entry `redundantTokens`
 * already flags (probability 1, no Jev call) plus every surviving entry a
 * per-tag Jev binary call flags at `PRUNE_INCLUDE_THRESHOLD` or above. `null`
 * when nothing is removable — an empty array, or every entry survives.
 */
async function resolvePruneTarget(
  db: Database,
  spec: Extract<FieldSuggestSpec, { kind: "prune" }>,
  resolvedBasis: ResolvedBasis,
  rawBasis: RawBasis,
  usage: AiSelectionUsage,
  jev: JevPort | undefined,
): Promise<TargetResolution> {
  const candidates = spec.candidates(resolvedBasis, rawBasis);
  if (candidates.length === 0) return noSuggestion;

  const deterministic = await spec.deterministic(resolvedBasis, rawBasis, db);
  const deterministicValues = new Set(
    deterministic.map((match) => match.value),
  );
  const removals: FieldSuggestionRemoval[] = deterministic.map((match) => ({
    value: match.value,
    probability: 1,
    reason: `restates ${match.reason}`,
  }));

  const survivors = candidates
    .filter((value) => !deterministicValues.has(value))
    .slice(0, spec.maxJevCandidates);
  for (const value of survivors) {
    const result = await runJevChoice({
      feature: FIELD_SUGGESTION_FEATURE,
      subject: spec.subject(resolvedBasis, value),
      rules: spec.rules,
      choices: [...TAG_PRUNE_CHOICES],
      usage,
      allowNone: false,
      port: jev,
    });
    if (
      result.selectedIndex === 0 &&
      result.probability >= PRUNE_INCLUDE_THRESHOLD
    ) {
      removals.push({
        value,
        probability: result.probability,
        reason: `restates ${JEV_TAG_REMOVAL_REASON}`,
      });
    }
  }

  if (removals.length === 0) return noSuggestion;
  const sortedValues = [
    ...new Set(removals.map((removal) => removal.value)),
  ].sort();
  const probability = Math.min(
    ...removals.map((removal) => removal.probability),
  );
  const reasons = [
    ...new Set(
      removals.map((removal) => removal.reason.replace(/^restates /u, "")),
    ),
  ];
  return {
    suggestion: {
      value: sortedValues.join(", "),
      label: `Remove ${sortedValues.join(", ")}`,
      detail: `restates ${reasons.join(", ")}`,
      confidence: decisionConfidence(probability),
      probability,
      reasoning: "",
      alternatives: [],
      operation: "remove",
      removals,
    },
    rawValue: null,
  };
}

type SuggestFieldsModel =
  (typeof entityFieldModels)[keyof typeof entityFieldModels];

/** A target's basis keys, plus (Amendment 1) its own key when it is a prune
 * target — a prune target judges its own current entries, so it is an
 * implicit self-basis. The manifest compiler rejects naming it explicitly, so
 * this is the one place that adds it back; without it `resolvePruneTarget`
 * has nothing to parse. */
function targetBasisKeysFor(
  model: SuggestFieldsModel,
  target: string,
): readonly string[] {
  const field = model.fields.find((f) => f.key === target);
  const declaredBasis = field?.control?.suggest?.basis ?? [];
  return field?.control?.suggest?.mode === "prune"
    ? [...declaredBasis, target]
    : declaredBasis;
}

/** A JSON-encoded array basis value (a prune target's own self-basis, or a
 * sibling text-array field like `aliases`) can run well past an ordinary
 * basis string's length — the same exemption `classificationEvidence`
 * already gets. */
function basisValueLimitFor(entity: string, key: string): number {
  if (entity !== "product") return MAX_BASIS_VALUE_LENGTH;
  return key === "classificationEvidence" || key === "tags" || key === "aliases"
    ? 8000
    : MAX_BASIS_VALUE_LENGTH;
}

export async function suggestFields(
  db: Database,
  rawInput: FieldSuggestionsInput,
  ports?: SuggestFieldsPorts,
): Promise<FieldSuggestionsOut> {
  const input =
    rawInput.entity === "expense"
      ? {
          ...rawInput,
          basis: {
            ...rawInput.basis,
            lineKind: resolveExpenseLineKind(rawInput.basis),
          },
        }
      : rawInput;
  if (
    input.entity === "expense" &&
    input.targets.includes("projectId") &&
    input.basis.lineKind != null &&
    input.basis.lineKind !== "principal"
  ) {
    throw createAppError(
      "SUGGEST_FIELD_FORBIDDEN",
      "Only principal expense lines can receive project suggestions.",
    );
  }
  // SAFETY: `input.entity` is validated by `fieldSuggestionsInput`'s
  // `z.enum(shortcodeEntities)`, a subset of `entityFieldModels`'s keys.
  const model =
    entityFieldModels[input.entity as keyof typeof entityFieldModels];

  // Production calls have no injected ports. Tests inject their Jev/database
  // seams and deliberately exercise suggestion mechanics in isolation.
  const fieldResolutions = ports?.resolveInheritance
    ? await ports.resolveInheritance(db, input)
    : ports
      ? {}
      : await resolveSuggestionInheritance(db, input);
  const eligibleTargets = input.targets.filter((target) => {
    if (input.basisMode === "provided") return true;
    const resolution = fieldResolutions[target];
    return (
      resolution === undefined ||
      (resolution.mode === "inherit" && resolution.value === null)
    );
  });

  const targetSpecs = resolveTargetSpecs(
    { ...input, targets: eligibleTargets },
    ports,
  );
  const requestedTargets = new Set(targetSpecs.keys());

  const targetBasisKeys = new Map<string, readonly string[]>();
  for (const target of requestedTargets) {
    targetBasisKeys.set(target, targetBasisKeysFor(model, target));
  }

  const clientBasis = new Map<string, string | null>();
  for (const [key, value] of Object.entries(input.basis)) {
    clientBasis.set(
      key,
      normalizeBasisValue(value, basisValueLimitFor(input.entity, key)),
    );
  }
  const authoritativeKeys = new Set(
    Object.entries(fieldResolutions)
      .filter(
        ([key, resolution]) =>
          input.basisMode === "provided" ||
          !requestedTargets.has(key) ||
          resolution.mode !== "inherit" ||
          resolution.value !== null,
      )
      .map(([key]) => key),
  );
  for (const [key, resolution] of Object.entries(fieldResolutions)) {
    clientBasis.set(key, scalarBasisValue(resolution.value));
  }

  const resolveLabels = ports?.resolveLabels ?? defaultResolveLabels;
  const resolvedRawByTarget = new Map<string, string | null>();
  const suggestions: Record<string, FieldSuggestion | null> = {};

  const pending = new Map<string, Promise<void>>();
  const resolveTarget = (target: string): Promise<void> => {
    const existing = pending.get(target);
    if (existing) return existing;
    // Defer execution until registered: siblings share one dependency promise.
    const task = Promise.resolve().then(async () => {
      if (input.basisMode === "suggested") {
        await Promise.all(
          (targetBasisKeys.get(target) ?? [])
            .filter((key) => key !== target && requestedTargets.has(key))
            .map(resolveTarget),
        );
      }
      const spec = targetSpecs.get(target)!;
      const basisKeys = targetBasisKeys.get(target) ?? [];

      const rawBasis = effectiveRawBasis(
        basisKeys,
        clientBasis,
        requestedTargets,
        input.basisMode === "suggested" ? resolvedRawByTarget : new Map(),
        authoritativeKeys,
      );
      const resolvedBasis = await resolveDisplayBasis(
        db,
        model.fields,
        basisKeys,
        rawBasis,
        resolveLabels,
      );

      const hasSignal = basisKeys.some((key) => resolvedBasis[key] != null);
      if (!hasSignal) {
        suggestions[target] = null;
        resolvedRawByTarget.set(target, null);
        return;
      }

      const usage: AiSelectionUsage = {
        db,
        operation: `suggestFields.${input.entity}.${target}`,
        cacheStatus: "none",
        force: ports?.force,
      };
      const { suggestion, rawValue } = await resolveSpec(
        db,
        spec,
        resolvedBasis,
        rawBasis,
        usage,
        ports?.jev,
      );
      suggestions[target] = suggestion;
      resolvedRawByTarget.set(target, rawValue);
    });
    pending.set(target, task);
    return task;
  };
  await Promise.all([...requestedTargets].map(resolveTarget));

  return { suggestions, fieldResolutions, eligibleTargets };
}
