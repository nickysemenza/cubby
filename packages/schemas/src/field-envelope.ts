import { z } from "zod";

import { entitySchema } from "./entity-core";
import { fieldEmptyReason } from "./field-outcome";
export { fieldEmptyReason } from "./field-outcome";

/** Null/absence is represented by an intent or outcome, never a value arm. */
function fieldValueSchema<S extends z.ZodType>(
  schema: S,
): z.ZodType<NonNullable<z.output<S>>>;
function fieldValueSchema(schema: z.ZodType): z.ZodType {
  if (
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodNonOptional ||
    schema instanceof z.ZodReadonly
  ) {
    const inner = schema.unwrap();
    if (!(inner instanceof z.ZodType))
      throw new Error("A field value must use a Zod schema");
    return fieldValueSchema(inner);
  }
  if (schema instanceof z.ZodUnion) {
    const options = schema.options
      .map((option) => {
        if (!(option instanceof z.ZodType))
          throw new Error("A field value must use a Zod schema");
        return fieldValueSchema(option);
      })
      .filter((option) => !(option instanceof z.ZodNever));
    const first = options[0];
    if (first === undefined) return z.never();
    return options.length === 1 ? first : z.union(options);
  }
  if (
    schema instanceof z.ZodNull ||
    schema instanceof z.ZodUndefined ||
    schema instanceof z.ZodVoid
  )
    return z.never();
  return schema.refine((value) => value !== null && value !== undefined, {
    error: "A field value must use an explicit empty outcome instead of null",
  });
}

/** Public sources retain their label without importing the generated manifest. */
export const fieldSource = z.object({
  entityKind: entitySchema,
  entityId: z.string(),
  name: z.string().nullable(),
});

/** Ownership is current receipt-backed authority, not cached AI confidence. */
export const fieldAssignmentOwnership = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("record") }),
  z.object({
    kind: z.literal("automatic"),
    receiptId: z.string(),
    confidence: z.number().min(0).max(1),
  }),
]);

export const fieldProvenance = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("own"),
    ownership: fieldAssignmentOwnership,
  }),
  z.object({ kind: z.literal("inherited"), source: fieldSource }),
  z.object({ kind: z.literal("default"), source: fieldSource.nullable() }),
  z.object({ kind: z.literal("allocated") }),
  z.object({ kind: z.literal("computed") }),
]);

/** Declarations specialize permitted intents; allocation is never an intent. */
export const fieldAssignment = <S extends z.ZodType>(stored: S) =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("inherit") }),
    z.object({ kind: z.literal("none") }),
    z.object({
      kind: z.literal("value"),
      value: fieldValueSchema(stored),
      ownership: fieldAssignmentOwnership,
    }),
  ]);

/** The outcome and its provenance always describe the same computation. */
export const fieldDecision = <V extends z.ZodType>(value: V) =>
  z.object({
    outcome: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("value"), value: fieldValueSchema(value) }),
      z.object({
        kind: z.literal("empty"),
        reason: fieldEmptyReason,
      }),
    ]),
    provenance: fieldProvenance.nullable(),
  });

export const fieldResult = <V extends z.ZodType>(value: V) =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("missing") }),
    z.object({ kind: z.literal("live"), decision: fieldDecision(value) }),
    z.object({
      kind: z.literal("cached"),
      decision: fieldDecision(value),
      computedAt: z.iso.datetime(),
      freshness: z.enum(["fresh", "stale"]),
    }),
  ]);

/** A failed or waiting refresh does not imply whether a usable result exists. */
export const fieldWork = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("idle") }),
  z.object({ kind: z.literal("pending") }),
  z.object({ kind: z.literal("waiting"), reason: z.string() }),
  z.object({
    kind: z.literal("failed"),
    error: z.string(),
    retryAt: z.iso.datetime().nullable(),
  }),
]);

export const fieldResetPreview = <V extends z.ZodType>(value: V) => {
  const result = fieldResult(value);
  return z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("not_loaded") }),
    z.object({
      kind: z.literal("ready"),
      result: z.discriminatedUnion("kind", [
        result.options[1],
        result.options[2].extend({ freshness: z.literal("fresh") }),
      ]),
    }),
  ]);
};

export const fieldControls = <V extends z.ZodType>(value: V) =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("readonly"),
      reason: z.enum(["computed", "allocated", "not_allowed"]),
    }),
    z.object({
      kind: z.literal("editable"),
      canSetNone: z.boolean(),
      canConfirm: z.boolean(),
      reset: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("unavailable") }),
        z.object({
          kind: z.literal("available"),
          preview: fieldResetPreview(value),
        }),
      ]),
    }),
  ]);

/** Current assignment and controls must never be reconstructed from a cache. */
export const fieldEnvelope = <S extends z.ZodType, V extends z.ZodType>(
  stored: S,
  effective: V,
) =>
  z.object({
    current: z.object({
      assignment: fieldAssignment(stored).nullable(),
      controls: fieldControls(effective),
    }),
    result: fieldResult(effective),
    work: fieldWork,
  });

/** Computed fields expose no fictitious assignment or edit capability. */
export const computedFieldEnvelope = <V extends z.ZodType>(effective: V) =>
  z.object({
    current: z.object({
      assignment: z.null(),
      controls: z.object({
        kind: z.literal("readonly"),
        reason: z.enum(["computed", "allocated", "not_allowed"]),
      }),
    }),
    result: fieldResult(effective),
    work: fieldWork,
  });

type StoredFieldSchemas = Readonly<Record<string, z.ZodType | null>>;

type EnvelopedReadFields<
  ReadFields extends z.ZodRawShape,
  Stored extends StoredFieldSchemas,
> = {
  [K in keyof ReadFields & keyof Stored]: ReadFields[K] extends z.ZodType
    ? Stored[K] extends z.ZodType
      ? ReturnType<typeof fieldEnvelope<Stored[K], ReadFields[K]>>
      : ReturnType<typeof computedFieldEnvelope<ReadFields[K]>>
    : never;
};

type PublicFieldSchemas<S extends z.ZodRawShape, P extends z.ZodRawShape> = {
  [K in keyof S]: K extends keyof P ? P[K] : S[K];
};
type PublicReadOutput<S extends z.ZodType, P extends z.ZodRawShape> = {
  [K in keyof z.output<S>]: K extends keyof P ? z.output<P[K]> : z.output<S>[K];
};

/**
 * Each projection envelopes only fields it actually reads. The field's stored
 * schema comes from its declaration; the effective schema comes from this read.
 */
export function withFieldEnvelopes<
  ReadFields extends z.ZodRawShape,
  Stored extends StoredFieldSchemas,
  Public extends z.ZodRawShape = {},
>(
  schema: z.ZodObject<ReadFields>,
  storedFields: Stored,
  publicReadFields?: Public,
): z.ZodObject<
  Omit<
    PublicFieldSchemas<ReadFields, Public>,
    keyof Stored | "fieldResolutions" | "derived" | "fields"
  > & {
    fields: z.ZodObject<
      EnvelopedReadFields<PublicFieldSchemas<ReadFields, Public>, Stored>
    >;
  }
>;
export function withFieldEnvelopes<
  S extends z.ZodType,
  Stored extends StoredFieldSchemas,
  Public extends z.ZodRawShape = {},
>(
  schema: S,
  storedFields: Stored,
  publicReadFields?: Public,
): z.ZodType<
  Omit<
    PublicReadOutput<S, Public>,
    keyof Stored | "fieldResolutions" | "derived" | "fields"
  > & {
    fields: {
      [
        K in keyof PublicReadOutput<S, Public> & keyof Stored
      ]: Stored[K] extends z.ZodType
        ? FieldEnvelope<Stored[K], z.ZodType<PublicReadOutput<S, Public>[K]>>
        : z.output<
            ReturnType<
              typeof computedFieldEnvelope<
                z.ZodType<PublicReadOutput<S, Public>[K]>
              >
            >
          >;
    };
  }
>;
export function withFieldEnvelopes(
  schema: z.ZodType,
  storedFields: StoredFieldSchemas,
  publicReadFields: z.ZodRawShape = {},
): z.ZodType {
  if (!(schema instanceof z.ZodObject))
    throw new Error("Field envelopes require an object read schema");
  const fields: z.ZodRawShape = Object.fromEntries(
    Object.entries(storedFields).flatMap(([key, stored]) => {
      const effective = schema.shape[key]
        ? (publicReadFields[key] ?? schema.shape[key])
        : undefined;
      return effective
        ? [
            [
              key,
              stored === null
                ? computedFieldEnvelope(effective)
                : fieldEnvelope(stored, effective),
            ],
          ]
        : [];
    }),
  );
  const ordinaryFields: z.ZodRawShape = Object.fromEntries(
    Object.entries(schema.shape)
      .filter(
        ([key]) =>
          key !== "fieldResolutions" &&
          key !== "derived" &&
          key !== "fields" &&
          !Object.hasOwn(fields, key),
      )
      .map(([key, value]) => [key, publicReadFields[key] ?? value]),
  );
  return z.object(ordinaryFields).extend({ fields: z.object(fields) });
}

export type FieldEnvelope<S extends z.ZodType, V extends z.ZodType> = z.output<
  ReturnType<typeof fieldEnvelope<S, V>>
>;

const readableFieldEnvelope = fieldEnvelope(z.unknown(), z.unknown());
export type ReadableFieldEnvelope = z.output<typeof readableFieldEnvelope>;
type ReadableResult = Pick<ReadableFieldEnvelope, "result">;
type PresentDecision<E extends ReadableResult> = Exclude<
  E["result"],
  { kind: "missing" }
>["decision"];
type PresentValue<E extends ReadableResult> = Extract<
  PresentDecision<E>["outcome"],
  { kind: "value" }
>["value"];

/** Missing and successful empty results remain distinguishable to renderers. */
export function fieldDecisionOf<E extends ReadableResult>(
  envelope: E,
): PresentDecision<E> | null;
export function fieldDecisionOf(envelope: ReadableResult) {
  return envelope.result.kind === "missing" ? null : envelope.result.decision;
}

/** Scalar/structured renderers use this; editors inspect the decision as well. */
export function fieldValueOf<E extends ReadableResult>(
  envelope: E,
): PresentValue<E> | null;
export function fieldValueOf(envelope: ReadableResult) {
  const decision = fieldDecisionOf(envelope);
  return decision?.outcome.kind === "value" ? decision.outcome.value : null;
}

const recordFields = z.object({ fields: z.record(z.string(), z.unknown()) });

/** Unknown records enter generic field renderers at this narrow parse boundary. */
export function fieldEnvelopeFor(
  record: unknown,
  field: string,
): ReadableFieldEnvelope | undefined {
  const container = recordFields.safeParse(record);
  if (!container.success) return undefined;
  const envelope = readableFieldEnvelope.safeParse(
    container.data.fields[field],
  );
  return envelope.success ? envelope.data : undefined;
}
