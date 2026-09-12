import { z } from "zod";

/**
 * The JSON projection of a domain type: what a `Response.json()` body or a
 * JSON request body actually carries. Dates become ISO strings; everything
 * else keeps its shape. `toWire` is the runtime counterpart, so the type and
 * the walker MUST agree on every mapping (the parity test enforces it).
 */
export type Json<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends Date
    ? string
    : T extends readonly (infer V)[]
      ? Json<V>[]
      : T extends object
        ? { [K in keyof T]: Json<T[K]> }
        : T;

/**
 * `input` and `output` are JSON bodies. `query` is a URL query string as the
 * router receives it: one string per key, or an array for a repeated key, so
 * numbers, booleans and lists are coerced from their text form.
 */
export type WireIo = "input" | "output" | "query";

export interface WireOptions {
  /**
   * Schemas the walker must not descend into, keyed by the domain schema
   * instance. Used for type-only carriers (`z.custom<T>()`) whose runtime
   * wire schema lives elsewhere.
   */
  overrides?: ReadonlyMap<z.ZodType, z.ZodType>;
}

export class WireSchemaError extends Error {
  constructor(
    message: string,
    readonly path: readonly string[],
  ) {
    super(`${message} at ${path.length ? path.join(".") : "<root>"}`);
    this.name = "WireSchemaError";
  }
}

/**
 * A query projection was refused because the input is not flat. Kept apart
 * from a plain WireSchemaError so a transport decision can never swallow a
 * real schema bug: callers decide GET vs POST with `isFlatQueryInput` first.
 */
export class QueryProjectionError extends WireSchemaError {
  constructor(message: string, path: readonly string[]) {
    super(message, path);
    this.name = "QueryProjectionError";
  }
}

/**
 * Component names for OpenAPI. A domain schema carrying `.meta({ id })` gets
 * `${io}_${id}` here; everything else is named by the emitter's fallback.
 */
export const wireRegistry = z.registry<{ id: string }>();

// One wire instance per (domain schema, io) so shared domain schemas become one
// OpenAPI component and one identity in the contract. This is a cache keyed by
// identity, not a side channel: the wire schema is self-sufficient.
const memo = new WeakMap<z.ZodType, Partial<Record<WireIo, z.ZodType>>>();

const passThrough = new Set<string>([
  "string",
  "number",
  "int",
  "boolean",
  "null",
  "any",
  "unknown",
  "enum",
  "template_literal",
]);

// Numbers and booleans arrive as text on a query string, so they get coercing
// projections instead of passing through.
const queryPassThrough = new Set<string>([
  "string",
  "null",
  "any",
  "unknown",
  "enum",
  "template_literal",
]);

const wrapperTypes = new Set<string>([
  "optional",
  "nullable",
  "nonoptional",
  "readonly",
  "default",
  "prefault",
  "catch",
]);

const queryScalarTypes = new Set<string>([
  "string",
  "number",
  "int",
  "boolean",
  "enum",
  "literal",
  "template_literal",
  "null",
  "any",
  "unknown",
  "date",
]);

const unsupported = new Set<string>([
  "custom",
  "transform",
  "map",
  "set",
  "bigint",
  "symbol",
  "function",
  "promise",
  "file",
  "void",
  "never",
  "nan",
  "success",
  "undefined",
]);

/**
 * The child slots a Zod 4 def can carry, by node type. Every field is
 * optional because the walker only reads the ones its `type` promises.
 */
interface WalkableDef extends z.core.$ZodTypeDef {
  innerType?: z.ZodType;
  element?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  catchall?: z.ZodType;
  items?: readonly z.ZodType[];
  rest?: z.ZodType | null;
  keyType?: z.ZodType;
  valueType?: z.ZodType;
  options?: readonly z.ZodType[];
  left?: z.ZodType;
  right?: z.ZodType;
  getter?: () => z.ZodType;
  in?: z.ZodType;
  out?: z.ZodType;
  coerce?: boolean;
  discriminator?: string;
  values?: readonly (
    | string
    | number
    | boolean
    | null
    | undefined
    | bigint
    | symbol
  )[];
  defaultValue?: unknown;
}

// SAFETY: `_zod.def` is the runtime def whose `type` names which optional
// child fields are present; the walker checks `type` before reading any.
const defOf = (schema: z.ZodType): WalkableDef =>
  schema._zod.def as WalkableDef;

// SAFETY: `z.clone` rebuilds the same class from a def; the patch only
// replaces child schemas with their wire projections, never the def type.
const rebuild = (schema: z.ZodType, patch: Partial<WalkableDef>) =>
  z.clone(schema, { ...defOf(schema), ...patch } as typeof schema._zod.def);

type JsonLiteral = string | number | boolean | null;

const isJsonLiteral = (value: unknown): value is JsonLiteral =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

function remember(source: z.ZodType, io: WireIo, wire: z.ZodType): z.ZodType {
  let result = wire;
  const meta = z.globalRegistry.get(source);
  if (meta && result !== source) {
    const { id, ...rest } = meta;
    if (Object.keys(rest).length) result = result.meta(rest);
    if (id !== undefined && !wireRegistry.get(result))
      wireRegistry.add(result, { id: `${io}_${id}` });
  }
  if (result !== source && !result.description && source.description) {
    result = result.describe(source.description);
  }
  const slot = memo.get(source) ?? {};
  slot[io] = result;
  memo.set(source, slot);
  return result;
}

interface Visit {
  schema: z.ZodType;
  def: WalkableDef;
  io: WireIo;
  path: string[];
  options: WireOptions;
  child: (value: z.ZodType | null | undefined, segment: string) => z.ZodType;
}

type NodeHandler = (visit: Visit) => z.ZodType;

const visitLiteral: NodeHandler = ({ schema, def, path }) => {
  if (!(def.values ?? []).every(isJsonLiteral))
    throw new WireSchemaError("Literal values must be JSON values", path);
  return schema;
};

const visitDate: NodeHandler = ({ def, io, path }) => {
  if (io !== "output" && def.coerce !== true)
    throw new WireSchemaError(
      "Input dates must accept ISO strings with z.coerce.date()",
      path,
    );
  // Date#toISOString always emits a `Z` offset, which is what the default
  // z.iso.datetime() accepts. Date min/max checks do not survive the wire;
  // the handler's own input schema still enforces them.
  return z.iso.datetime();
};

const visitWrapper: NodeHandler = ({ schema, def, child }) =>
  rebuild(schema, { innerType: child(def.innerType, "innerType") });

const visitDefault: NodeHandler = ({ schema, def, io, path, child }) => {
  // Outputs already have defaults applied, so the wrapper is dropped.
  if (io === "output") return child(def.innerType, "innerType");
  if (def.type === "default" && def.defaultValue instanceof Date)
    throw new WireSchemaError("Default values must be JSON values", path);
  return rebuild(schema, { innerType: child(def.innerType, "innerType") });
};

const visitObject: NodeHandler = ({ schema, def, child }) => {
  const fields = Object.fromEntries(
    Object.entries(def.shape ?? {}).map(([key, value]) => [
      key,
      child(value, key),
    ]),
  );
  const patch: Partial<WalkableDef> = { shape: fields };
  // `z.strictObject` is `catchall: z.never()`, a constraint rather than a
  // value shape, so it is kept as-is instead of walked.
  if (def.catchall instanceof z.ZodType)
    patch.catchall =
      defOf(def.catchall).type === "never"
        ? def.catchall
        : child(def.catchall, "[catchall]");
  return rebuild(schema, patch);
};

const visitArray: NodeHandler = ({ schema, def, child }) =>
  rebuild(schema, { element: child(def.element, "[]") });

const visitTuple: NodeHandler = ({ schema, def, child }) => {
  const items = (def.items ?? []).map((item, index) =>
    child(item, `[${index}]`),
  );
  const patch: Partial<WalkableDef> = { items };
  if (def.rest instanceof z.ZodType) patch.rest = child(def.rest, "[rest]");
  return rebuild(schema, patch);
};

const visitRecord: NodeHandler = ({ schema, def, child }) =>
  rebuild(schema, {
    keyType: child(def.keyType, "[key]"),
    valueType: child(def.valueType, "[value]"),
  });

const visitUnion: NodeHandler = ({ schema, def, child }) =>
  rebuild(schema, {
    options: (def.options ?? []).map((option, index) =>
      child(option, `|${index}`),
    ),
  });

const visitIntersection: NodeHandler = ({ schema, def, child }) =>
  rebuild(schema, {
    left: child(def.left, "&left"),
    right: child(def.right, "&right"),
  });

const visitLazy: NodeHandler = ({ schema, def, io, path, child }) => {
  const getter = def.getter;
  if (!getter) throw new WireSchemaError("Lazy schema without getter", path);
  // Register before recursing so a self-reference resolves to this node.
  const wire = z.lazy(() => child(getter(), "()"));
  const slot = memo.get(schema) ?? {};
  slot[io] = wire;
  memo.set(schema, slot);
  return wire;
};

const visitPipe: NodeHandler = ({ def, io, path, child }) => {
  const inbound = def.in;
  const outbound = def.out;
  if (io !== "output") {
    // `z.preprocess(fn, schema)` is pipe(transform, schema): the wire is
    // what the preprocessor's target accepts; a plain pipe/codec accepts
    // its input side.
    const source =
      inbound && defOf(inbound).type === "transform" ? outbound : inbound;
    return child(source, "in");
  }
  if (outbound && defOf(outbound).type === "transform")
    throw new WireSchemaError(
      "Output transforms need a concrete output schema",
      path,
    );
  return child(outbound, "out");
};

const handlers = new Map<string, NodeHandler>([
  ["literal", visitLiteral],
  ["date", visitDate],
  ["optional", visitWrapper],
  ["nullable", visitWrapper],
  ["nonoptional", visitWrapper],
  ["readonly", visitWrapper],
  ["default", visitDefault],
  ["prefault", visitDefault],
  ["catch", visitDefault],
  ["object", visitObject],
  ["array", visitArray],
  ["tuple", visitTuple],
  ["record", visitRecord],
  ["union", visitUnion],
  ["intersection", visitIntersection],
  ["lazy", visitLazy],
  ["pipe", visitPipe],
]);

/** A query leaf: one text value the router can hand over as a string. */
const isQueryScalar = (schema: z.ZodType): boolean => {
  const def = defOf(schema);
  if (wrapperTypes.has(def.type))
    return def.innerType instanceof z.ZodType && isQueryScalar(def.innerType);
  if (def.type === "union") return (def.options ?? []).every(isQueryScalar);
  if (def.type === "pipe")
    return def.out instanceof z.ZodType && isQueryScalar(def.out);
  return queryScalarTypes.has(def.type);
};

/** The `[S, array(S)]` union `oneOrMany`-style filters are built from. */
const oneOrManyOption = (def: WalkableDef): z.ZodType | undefined => {
  const [single, many] = def.options ?? [];
  if (
    def.options?.length === 2 &&
    single instanceof z.ZodType &&
    many instanceof z.ZodType &&
    defOf(many).type === "array" &&
    defOf(many).element === single
  )
    return single;
  return undefined;
};

/** A query list: repeated keys carrying scalars. */
const isQueryList = (schema: z.ZodType): boolean => {
  const def = defOf(schema);
  if (wrapperTypes.has(def.type))
    return def.innerType instanceof z.ZodType && isQueryList(def.innerType);
  if (def.type === "array")
    return def.element instanceof z.ZodType && isQueryScalar(def.element);
  if (def.type === "union") {
    const single = oneOrManyOption(def);
    return single !== undefined && isQueryScalar(single);
  }
  if (def.type === "pipe")
    return def.out instanceof z.ZodType && isQueryList(def.out);
  return false;
};

/**
 * Whether an input wire schema can travel as query parameters: no input, a
 * scalar (carried as `?input=`), or an object whose every field is a scalar
 * or a list of scalars. Anything structured needs a JSON body. This is the
 * one authority the router and the registry generator use for GET vs POST.
 */
export const isFlatQueryInput = (wire: z.ZodType): boolean => {
  const def = defOf(wire);
  if (def.type === "null" || def.type === "undefined") return true;
  if (def.type === "object")
    return Object.values(def.shape ?? {}).every(
      (field) => isQueryScalar(field) || isQueryList(field),
    );
  return isQueryScalar(wire);
};

/**
 * `?flag=true` and `?flag=false` next to a real boolean. `z.coerce.boolean()`
 * is not usable here: it reads the text "false" as true.
 */
const queryBoolean = () =>
  z.codec(z.union([z.boolean(), z.enum(["true", "false"])]), z.boolean(), {
    decode: (value) => value === true || value === "true",
    encode: (value) => value,
  });

/**
 * One `?key=a` or several `?key=a&key=b`: the router hands over a string for
 * one occurrence and an array for repeats, and the domain wants a list.
 */
const oneOrManyQuery = (element: z.ZodType) =>
  z.codec(z.union([element, z.array(element)]), z.array(element), {
    decode: (value) => (Array.isArray(value) ? value : [value]),
    encode: (value) => value,
  });

const visitQueryNumber: NodeHandler = ({ schema }) =>
  rebuild(schema, { coerce: true });

const literalKind = (
  values: NonNullable<WalkableDef["values"]>,
): "number" | "boolean" | "string" | "mixed" => {
  if (values.every((value) => z.number().safeParse(value).success))
    return "number";
  if (values.every((value) => z.boolean().safeParse(value).success))
    return "boolean";
  if (values.every((value) => z.string().safeParse(value).success))
    return "string";
  return "mixed";
};

// A literal number or boolean still arrives as text; the literal check runs
// on the coerced value.
const visitQueryLiteral: NodeHandler = (visit) => {
  const literal = visitLiteral(visit);
  switch (literalKind(visit.def.values ?? [])) {
    case "number":
      // SAFETY: every literal value is a number, so the literal's input is a
      // number: what the coercing number schema feeds it.
      return z.coerce.number().pipe(literal as z.ZodType<unknown, number>);
    case "boolean":
      // SAFETY: every literal value is a boolean, so the literal's input is a
      // boolean: what the query boolean codec decodes to.
      return queryBoolean().pipe(literal as z.ZodType<unknown, boolean>);
    case "string":
      return literal;
    case "mixed":
      throw new QueryProjectionError(
        "Query literals must be all strings, all numbers or all booleans",
        visit.path,
      );
  }
};

const visitQueryBoolean: NodeHandler = () => queryBoolean();

// Query strings cannot carry null, and a default is re-applied by the domain
// schema after the route validates, so both become plain optionals.
const visitQueryOptional: NodeHandler = ({ def, child }) =>
  child(def.innerType, "innerType").optional();

const visitQueryArray: NodeHandler = ({ def, path, child }) => {
  const element = child(def.element, "[]");
  if (!isQueryScalar(element))
    throw new QueryProjectionError("Query lists carry scalars only", path);
  return oneOrManyQuery(element);
};

const visitQueryUnion: NodeHandler = ({ schema, def, path, child }) => {
  const single = oneOrManyOption(def);
  if (single) return oneOrManyQuery(child(single, "|0"));
  const options = (def.options ?? []).map((option, index) =>
    child(option, `|${index}`),
  );
  if (!options.every(isQueryScalar))
    throw new QueryProjectionError("Query unions carry scalars only", path);
  return rebuild(schema, { options });
};

const visitQueryObject: NodeHandler = (visit) => {
  if (visit.path.length > 0)
    throw new QueryProjectionError(
      "Query parameters cannot nest objects",
      visit.path,
    );
  const object = visitObject(visit);
  // An unknown query key is a typo, never data: the root is strict.
  return defOf(object).catchall instanceof z.ZodType
    ? object
    : rebuild(object, { catchall: z.never() });
};

const queryHandlers = new Map<string, NodeHandler>([
  ["literal", visitQueryLiteral],
  ["date", visitDate],
  ["number", visitQueryNumber],
  ["int", visitQueryNumber],
  ["boolean", visitQueryBoolean],
  ["optional", visitWrapper],
  ["nonoptional", visitWrapper],
  ["readonly", visitWrapper],
  ["nullable", visitQueryOptional],
  ["default", visitQueryOptional],
  ["prefault", visitQueryOptional],
  ["catch", visitQueryOptional],
  ["object", visitQueryObject],
  ["array", visitQueryArray],
  ["union", visitQueryUnion],
  ["pipe", visitPipe],
]);

function walk(
  schema: z.ZodType,
  io: WireIo,
  path: string[],
  options: WireOptions,
): z.ZodType {
  const override = options.overrides?.get(schema);
  if (override) return override;
  const cached = memo.get(schema)?.[io];
  if (cached) return cached;
  const def = defOf(schema);
  const isQuery = io === "query";
  if ((isQuery ? queryPassThrough : passThrough).has(def.type))
    return remember(schema, io, schema);
  const handler = (isQuery ? queryHandlers : handlers).get(def.type);
  if (!handler) {
    if (isQuery && handlers.has(def.type))
      throw new QueryProjectionError(
        `Query parameters cannot carry a ${def.type}`,
        path,
      );
    throw new WireSchemaError(
      unsupported.has(def.type)
        ? `Unsupported wire schema type ${def.type}`
        : `Unknown schema type ${def.type}`,
      path,
    );
  }
  const child = (value: z.ZodType | null | undefined, segment: string) => {
    if (!(value instanceof z.ZodType))
      throw new WireSchemaError(`Expected a Zod schema for ${segment}`, path);
    return walk(value, io, [...path, segment], options);
  };
  return remember(
    schema,
    io,
    handler({ schema, def, io, path, options, child }),
  );
}

/**
 * Project a domain schema onto the JSON wire. Outputs describe what a JSON
 * response body carries (Dates as ISO strings); inputs describe what a JSON
 * request body or query carries and still parse into the domain input type.
 */
export function toWire<S extends z.ZodType>(
  schema: S,
  io: "output",
  options?: WireOptions,
): z.ZodType<Json<z.output<S>>>;
export function toWire<S extends z.ZodType>(
  schema: S,
  io: "input",
  options?: WireOptions,
): z.ZodType<Json<z.input<S>>, Json<z.input<S>>>;
export function toWire<S extends z.ZodType>(
  schema: S,
  io: "query",
  options?: WireOptions,
): z.ZodType<Json<z.input<S>>, Json<z.input<S>>>;
export function toWire(
  schema: z.ZodType,
  io: WireIo,
  options?: WireOptions,
): z.ZodType;
export function toWire(
  schema: z.ZodType,
  io: WireIo,
  options: WireOptions = {},
): z.ZodType {
  // SAFETY: the walker maps exactly the node types the `Json<T>` type maps —
  // Date -> ISO string and nothing else changes shape — so the overloads are
  // the truthful static view of the returned runtime schema. The query
  // projection additionally accepts the text form of every value, and its
  // coercions still admit the JSON form the static type spells.
  return walk(schema, io, [], options);
}

/**
 * The wire projection `toWire` already built for a domain schema, if any.
 * Read by the OpenAPI emitter to name components after the exports the
 * projections came from.
 */
export const wireProjection = (
  schema: z.ZodType,
  io: WireIo,
): z.ZodType | undefined => memo.get(schema)?.[io];

/**
 * The direct child schemas of a node, by path segment, in walker order. Used
 * by the OpenAPI emitter to reach discriminated-union members without
 * re-implementing the def layout.
 */
export const childSchemas = (
  schema: z.ZodType,
): readonly (readonly [string, z.ZodType])[] => {
  const def = defOf(schema);
  const entries: (readonly [string, z.ZodType])[] = [];
  const push = (segment: string, value: z.ZodType | null | undefined) => {
    if (value instanceof z.ZodType) entries.push([segment, value]);
  };
  push("innerType", def.innerType);
  push("[]", def.element);
  for (const [key, value] of Object.entries(def.shape ?? {})) push(key, value);
  push("[catchall]", def.catchall);
  (def.items ?? []).forEach((item, index) => push(`[${index}]`, item));
  push("[rest]", def.rest);
  push("[key]", def.keyType);
  push("[value]", def.valueType);
  (def.options ?? []).forEach((option, index) => push(`|${index}`, option));
  push("&left", def.left);
  push("&right", def.right);
  push("in", def.in);
  push("out", def.out);
  if (def.getter) push("()", def.getter());
  return entries;
};

/** The discriminator key of a `z.discriminatedUnion`, if the node is one. */
export const discriminatorOf = (
  schema: z.core.$ZodType,
): string | undefined => {
  // SAFETY: same def read as `defOf`, on the core type the JSON Schema
  // override hands over; only `type` and `discriminator` are consulted.
  const def = schema._zod.def as WalkableDef;
  return def.type === "union" ? def.discriminator : undefined;
};
