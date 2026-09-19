import type {
  FieldSuggestion,
  FieldSuggestionsInput,
  FieldSuggestionsOut,
} from "@cubby/schemas/ai";
/**
 * `ai.suggestFields`: resolve every requested target of one entity's basis in
 * one round trip. Each target runs through {@link FIELD_SUGGEST_REGISTRY}'s
 * matching spec — enum targets classify with Jev, reference/text targets pick
 * from a roster with `runAiSelection` — in dependency order, so a target
 * whose own basis names another requested target (`expense.trade`'s basis
 * includes `projectId`, itself a target when the caller asks for both) sees
 * that target's freshly resolved value when the client sent none of its own.
 */
import { entityRefKey } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";

import { classifyWithJev } from "~/server/ai/classify";
import { FIELD_SUGGESTION_FEATURE } from "~/server/ai/features";
import {
  FIELD_SUGGEST_REGISTRY,
  fieldSuggestSpecFor,
  type FieldSuggestSpec,
  type RawBasis,
  type ResolvedBasis,
} from "~/server/ai/field-suggest/registry";
import type { JevPort } from "~/server/ai/jev";
import {
  type AiSelectionSpec,
  type AiSelectionUsage,
  runAiSelection,
} from "~/server/ai/selection";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import {
  lookupEntityLabels,
  resolveShortcodes,
} from "~/server/repo/shortcode-resolver";

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
}

function normalizeBasisValue(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim().slice(0, MAX_BASIS_VALUE_LENGTH);
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

/**
 * DFS topological order over the requested targets: a target whose basis
 * names another requested target visits that target first. The manifest
 * compiler (step 1) rejects a cyclic `control.suggest.basis`, so the
 * `visiting` guard below is a defensive backstop, never expected to fire.
 */
function orderTargetsByDependency(
  targets: ReadonlySet<string>,
  basisOf: ReadonlyMap<string, readonly string[]>,
): string[] {
  const order: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (target: string): void => {
    if (visited.has(target) || visiting.has(target)) return;
    visiting.add(target);
    for (const basisKey of basisOf.get(target) ?? []) {
      if (basisKey !== target && targets.has(basisKey)) visit(basisKey);
    }
    visiting.delete(target);
    visited.add(target);
    order.push(target);
  };
  for (const target of targets) visit(target);
  return order;
}

/** This target's raw `{key: value}` basis: the client's own value when
 * sent, else — only when the key is itself a requested target — that
 * target's just-resolved raw value. */
function effectiveRawBasis(
  basisKeys: readonly string[],
  clientBasis: ReadonlyMap<string, string | null>,
  requestedTargets: ReadonlySet<string>,
  resolvedRawByTarget: ReadonlyMap<string, string | null>,
): RawBasis {
  return Object.fromEntries(
    basisKeys.map((key) => {
      const clientValue = clientBasis.get(key) ?? null;
      const value =
        clientValue ??
        (requestedTargets.has(key)
          ? (resolvedRawByTarget.get(key) ?? null)
          : null);
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
      reasoning: result.reasoning,
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
      reasoning: outcome.reasoning,
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
      reasoning: outcome.reasoning,
    },
    rawValue: outcome.selected,
  };
}

async function resolveOneTarget(
  db: Database,
  spec: FieldSuggestSpec,
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

export async function suggestFields(
  db: Database,
  input: FieldSuggestionsInput,
  ports?: SuggestFieldsPorts,
): Promise<FieldSuggestionsOut> {
  // SAFETY: `input.entity` is validated by `fieldSuggestionsInput`'s
  // `z.enum(shortcodeEntities)`, a subset of `entityFieldModels`'s keys.
  const model =
    entityFieldModels[input.entity as keyof typeof entityFieldModels];

  const targetSpecs = resolveTargetSpecs(input, ports);
  const requestedTargets = new Set(targetSpecs.keys());

  const targetBasisKeys = new Map<string, readonly string[]>();
  for (const target of requestedTargets) {
    const field = model.fields.find((f) => f.key === target);
    targetBasisKeys.set(target, field?.control?.suggest?.basis ?? []);
  }

  const clientBasis = new Map<string, string | null>();
  for (const [key, value] of Object.entries(input.basis)) {
    clientBasis.set(key, normalizeBasisValue(value));
  }

  const resolveLabels = ports?.resolveLabels ?? defaultResolveLabels;
  const resolvedRawByTarget = new Map<string, string | null>();
  const suggestions: Record<string, FieldSuggestion | null> = {};

  for (const target of orderTargetsByDependency(
    requestedTargets,
    targetBasisKeys,
  )) {
    const spec = targetSpecs.get(target)!;
    const basisKeys = targetBasisKeys.get(target) ?? [];

    const rawBasis = effectiveRawBasis(
      basisKeys,
      clientBasis,
      requestedTargets,
      resolvedRawByTarget,
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
      continue;
    }

    const usage: AiSelectionUsage = {
      db,
      operation: `suggestFields.${input.entity}.${target}`,
      cacheStatus: "none",
      force: ports?.force,
    };
    const { suggestion, rawValue } = await resolveOneTarget(
      db,
      spec,
      spec.subject(resolvedBasis),
      resolvedBasis,
      rawBasis,
      usage,
      ports?.jev,
    );
    suggestions[target] = suggestion;
    resolvedRawByTarget.set(target, rawValue);
  }

  return { suggestions };
}
