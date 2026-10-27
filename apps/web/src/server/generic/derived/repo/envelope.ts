/** Public reads keep present assignment authority separate from cached decisions. */
import { classificationFieldRefusal } from "@cubby/schemas/classification-field-policy";
import type { Entity } from "@cubby/schemas/entity";
import {
  entityFieldByKey,
  entityFieldModels,
} from "@cubby/schemas/entity-fields";
import {
  fieldAssignmentOwnership,
  fieldAssignment,
  fieldDecision,
  fieldEnvelope,
  fieldResult,
} from "@cubby/schemas/field-envelope";
import {
  fieldResolutionsSchema,
  type FieldResolution,
} from "@cubby/schemas/field-resolution";
import { z } from "zod";

import type {
  FieldReadContext,
  CurrentFieldOwnership,
  StoredDerivedRead,
} from "~/server/generic/derived/repo/read-context";

const assignmentSchema = fieldAssignment(z.unknown());
const decisionSchema = fieldDecision(z.unknown());
const resultSchema = fieldResult(z.unknown());
const envelopeSchema = fieldEnvelope(z.unknown(), z.unknown());
type Decision = z.output<typeof decisionSchema>;
type Result = z.output<typeof resultSchema>;
type Ownership = z.output<typeof fieldAssignmentOwnership>;

function resolutionDecision(
  resolution: FieldResolution,
  ownership: Ownership,
): Decision {
  const provenance: Decision["provenance"] =
    resolution.mode === "allocated"
      ? { kind: "allocated" }
      : resolution.mode === "explicit" || resolution.mode === "none"
        ? { kind: "own", ownership }
        : resolution.sourceEntity
          ? { kind: "inherited", source: resolution.sourceEntity }
          : resolution.value === null
            ? null
            : { kind: "default", source: null };
  if (
    resolution.mode === "allocated" &&
    resolution.value === null &&
    !resolution.emptyReason
  )
    throw new Error(
      "Empty allocated field requires an authoritative resolver decision",
    );
  return {
    outcome:
      resolution.value === null
        ? {
            kind: "empty",
            reason:
              resolution.emptyReason ??
              (resolution.mode === "none" ? "explicit_none" : "unset"),
          }
        : { kind: "value", value: resolution.value },
    provenance,
  };
}

type Assignment = z.output<typeof assignmentSchema>;
type Envelope = z.output<typeof envelopeSchema>;
type Field = ReturnType<typeof entityFieldByKey>;
type InputRow = FieldReadContext["raw"];

function currentAssignment({
  key,
  field,
  computed,
  assignments,
  currentAssignments,
  resolution,
  row,
  owner,
}: {
  key: string;
  field: Field;
  computed: boolean;
  assignments: InputRow;
  currentAssignments: Readonly<Record<string, Assignment>>;
  resolution: FieldResolution | undefined;
  row: InputRow;
  owner: Ownership;
}): Assignment | null {
  const storedValue = Object.hasOwn(assignments, key)
    ? assignments[key]
    : resolution
      ? resolution.storedValue
      : row[key];
  const nonePatch = field?.resolution?.none;
  const explicitNone =
    nonePatch != null &&
    Object.keys(nonePatch).length > 0 &&
    Object.entries(nonePatch).every(
      ([name, value]) =>
        JSON.stringify(
          Object.hasOwn(assignments, name) ? assignments[name] : row[name],
        ) === JSON.stringify(value),
    );
  const savedAssignment = computed
    ? null
    : (currentAssignments[key] ??
      (explicitNone
        ? ({ kind: "none" } as const)
        : (resolution?.mode === "inherit" &&
              !Object.hasOwn(assignments, key)) ||
            storedValue === null ||
            storedValue === undefined
          ? ({ kind: "inherit" } as const)
          : ({
              kind: "value",
              value: storedValue,
              ownership: owner,
            } as const)));
  return savedAssignment?.kind === "value"
    ? { ...savedAssignment, ownership: owner }
    : savedAssignment;
}

function currentControls({
  preview,
  allocated,
  refused,
  computed,
  mutable,
  field,
  key,
  resolution,
}: {
  preview: Result | undefined;
  allocated: boolean;
  refused: boolean;
  computed: boolean;
  mutable: ReadonlySet<string>;
  field: Field;
  key: string;
  resolution: FieldResolution | undefined;
}): Envelope["current"]["controls"] {
  // A fetched but stale counterfactual cannot be presented as a reset result.
  const validPreview =
    preview?.kind === "live"
      ? preview
      : preview?.kind === "cached" && preview.freshness === "fresh"
        ? { ...preview, freshness: "fresh" as const }
        : null;
  return allocated || refused || computed || !mutable.has(field?.key ?? key)
    ? {
        kind: "readonly",
        reason: allocated ? "allocated" : refused ? "not_allowed" : "computed",
      }
    : {
        kind: "editable",
        canSetNone: field?.resolution?.none != null,
        canConfirm: field?.resolution?.confirm != null,
        reset:
          resolution?.canReset &&
          field?.resolution?.reset &&
          Object.keys(field.resolution.reset).length > 0
            ? {
                kind: "available",
                preview: validPreview
                  ? { kind: "ready", result: validPreview }
                  : { kind: "not_loaded" },
              }
            : { kind: "unavailable" },
      };
}

function ownValueResult({
  decision,
  owner,
  entity,
  key,
  fieldSchema,
  assignment,
  controls,
  resolution,
  row,
}: {
  decision: Decision | undefined;
  owner: Ownership;
  entity: Entity;
  key: string;
  fieldSchema: z.ZodType;
  assignment: Extract<Assignment, { kind: "value" }>;
  controls: Envelope["current"]["controls"];
  resolution: FieldResolution | undefined;
  row: InputRow;
}): Result {
  const authoritative = decision;
  if (authoritative) {
    const decision = decisionSchema.parse(authoritative);
    if (decision.provenance?.kind !== "own")
      throw new Error(
        `Own ${entity}.${key} requires matching own decision provenance`,
      );
    return {
      kind: "live",
      decision: {
        ...decision,
        provenance: { kind: "own", ownership: owner },
      },
    };
  } else {
    const immediate = fieldSchema.safeParse({
      current: { assignment, controls },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "value", value: assignment.value },
          provenance: { kind: "own", ownership: owner },
        },
      },
      work: { kind: "idle" },
    });
    if (immediate.success) {
      return envelopeSchema.parse(immediate.data).result;
    } else {
      if (
        resolution &&
        (resolution.mode !== "explicit" ||
          JSON.stringify(resolution.storedValue) !==
            JSON.stringify(assignment.value))
      )
        throw new Error(
          `Own ${entity}.${key} requires an authoritative effective decision`,
        );
      const effective = resolution ? resolution.value : row[key];
      if (effective === null || effective === undefined)
        throw new Error(
          `Own ${entity}.${key} requires an authoritative effective value`,
        );
      return {
        kind: "live",
        decision: {
          outcome: { kind: "value", value: effective },
          provenance: { kind: "own", ownership: owner },
        },
      };
    }
  }
}

function effectiveResult({
  key,
  entity,
  resolution,
  owner,
  refused,
  assignment,
  controls,
  fieldSchema,
  row,
  read,
  decisions,
  results,
}: {
  key: string;
  entity: Entity;
  resolution: FieldResolution | undefined;
  owner: Ownership;
  refused: boolean;
  assignment: Assignment | null;
  controls: Envelope["current"]["controls"];
  fieldSchema: z.ZodType;
  row: InputRow;
  read: StoredDerivedRead | undefined;
  decisions: Readonly<Record<string, Decision>>;
  results: Readonly<Record<string, Result>>;
}): Result {
  // Own intent is decisive immediately; an old inherited cache cannot mask it.
  if (resolution?.mode === "allocated")
    return (
      results[key] ?? {
        kind: "live",
        decision: decisions[key]
          ? decisionSchema.parse(decisions[key])
          : resolutionDecision(resolution, owner),
      }
    );
  else if (refused)
    return {
      kind: "live",
      decision: {
        outcome: { kind: "empty", reason: "not_applicable" },
        provenance: null,
      },
    };
  else if (assignment?.kind === "none")
    return {
      kind: "live",
      decision: {
        outcome: { kind: "empty", reason: "explicit_none" },
        provenance: { kind: "own", ownership: owner },
      },
    };
  else if (
    assignment?.kind === "value" &&
    resolution?.mode === "inherit" &&
    JSON.stringify(resolution.storedValue) === JSON.stringify(assignment.value)
  )
    // Retain saved intent when the resolver cannot use its referenced source.
    return {
      kind: "live",
      decision: resolutionDecision(resolution, owner),
    };
  else if (assignment?.kind === "value") {
    return ownValueResult({
      decision: decisions[key],
      owner,
      entity,
      key,
      fieldSchema,
      assignment,
      controls,
      resolution,
      row,
    });
  } else if (read) {
    // Reset removes the old own decision immediately, even before invalidation arrives.
    const removedOverride =
      assignment?.kind === "inherit" &&
      (read.decision?.provenance?.kind === "own" ||
        read.decision?.provenance === null);
    return removedOverride
      ? decisions[key]
        ? { kind: "live", decision: decisionSchema.parse(decisions[key]) }
        : { kind: "missing" }
      : read.resultExists && read.computedAt && read.decision
        ? {
            kind: "cached",
            decision: decisionSchema.parse(read.decision),
            computedAt: read.computedAt,
            freshness: read.stale ? "stale" : "fresh",
          }
        : { kind: "missing" };
  } else if (decisions[key])
    return { kind: "live", decision: decisionSchema.parse(decisions[key]) };
  else if (resolution)
    return {
      kind: "live",
      decision: resolutionDecision(
        {
          ...resolution,
          mode: resolution.mode === "none" ? "inherit" : resolution.mode,
        },
        owner,
      ),
    };
  else
    return {
      kind: "live",
      decision: {
        outcome:
          row[key] === null || row[key] === undefined
            ? { kind: "empty", reason: "unset" }
            : { kind: "value", value: row[key] },
        provenance: { kind: "computed" },
      },
    };
}

/**
 * All database inputs are page-batched by the caller. Reset previews are exact,
 * separately requested resolver results, never guesses from cached fallbacks.
 */
export function buildFieldEnvelopeRow<S extends z.ZodObject>({
  schema,
  entity,
  row,
  resolutions: suppliedResolutions,
  stored = new Map(),
  ownership = {},
  assignments = {},
  currentAssignments = {},
  decisions = {},
  results = {},
  resetPreviews = {},
}: {
  schema: S;
  entity: Entity;
  row: FieldReadContext["raw"];
  resolutions?: Readonly<Record<string, FieldResolution>>;
  stored?: ReadonlyMap<string, StoredDerivedRead>;
  ownership?: CurrentFieldOwnership;
  /** Current public stored values when hydration replaced the ordinary slot. */
  assignments?: FieldReadContext["raw"];
  currentAssignments?: Readonly<
    Record<string, z.output<typeof assignmentSchema>>
  >;
  /** Authoritative resolver outcomes for blocked/unset/mixed distinctions. */
  decisions?: Readonly<Record<string, Decision>>;
  /** A draft may expose an allocation rule before it has an evaluated result. */
  results?: Readonly<Record<string, Result>>;
  resetPreviews?: Readonly<Record<string, Result>>;
}): z.output<S> {
  const fieldSchemas = schema.shape.fields;
  if (!(fieldSchemas instanceof z.ZodObject))
    throw new Error(
      "Field envelope projection requires an object fields schema",
    );
  const resolutions =
    suppliedResolutions ??
    fieldResolutionsSchema.parse(row.fieldResolutions ?? {});
  const fields: Record<string, z.output<typeof envelopeSchema>> = {};
  const mutable = new Set<string>(entityFieldModels[entity].update);
  const currentPolicyRow = { ...row, ...assignments };
  for (const key of Object.keys(fieldSchemas.shape)) {
    const field = entityFieldByKey(entity, key);
    const resolution = resolutions[key];
    const owner: Ownership = ownership[key] ?? { kind: "record" };
    const read = stored.get(key);
    const allocated = resolution?.mode === "allocated";
    const refused =
      resolution?.assignmentAllowed === false ||
      classificationFieldRefusal(entity, currentPolicyRow, key) !== null;
    const fieldSchema = fieldSchemas.shape[key];
    const computed =
      fieldSchema instanceof z.ZodObject &&
      fieldSchema.shape.current instanceof z.ZodObject &&
      fieldSchema.shape.current.shape.assignment instanceof z.ZodNull;
    const assignment = currentAssignment({
      key,
      field,
      computed,
      assignments,
      currentAssignments,
      resolution,
      row,
      owner,
    });
    const controls = currentControls({
      preview: resetPreviews[key],
      allocated,
      refused,
      computed,
      mutable,
      field,
      key,
      resolution,
    });
    const result = effectiveResult({
      key,
      entity,
      resolution,
      owner,
      refused,
      assignment,
      controls,
      fieldSchema,
      row,
      read,
      decisions,
      results,
    });
    fields[key] = {
      current: { assignment, controls },
      result,
      work: read?.error
        ? { kind: "failed", error: read.error, retryAt: read.retryAt }
        : (read?.pending ?? read?.stale)
          ? { kind: "pending" }
          : { kind: "idle" },
    };
  }
  const ordinary = Object.fromEntries(
    Object.entries(row).filter(
      ([key]) =>
        key !== "fieldResolutions" &&
        key !== "storedProjectionVersions" &&
        key !== "derived" &&
        key !== "fields" &&
        !Object.hasOwn(fields, key),
    ),
  );
  return schema.parse({ ...ordinary, fields });
}

/** A declared domain projection may use only the facts supplied to the constructor. */
export type FieldEnvelopeProjector = (
  input: Parameters<typeof buildFieldEnvelopeRow>[0] & {
    built: ReturnType<typeof buildFieldEnvelopeRow>;
  },
) => ReturnType<typeof buildFieldEnvelopeRow>;
