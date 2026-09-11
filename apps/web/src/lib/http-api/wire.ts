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

export type WireIo = "input" | "output";

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
  if (io === "input" && def.coerce !== true)
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
  if (io === "input") {
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
  if (passThrough.has(def.type)) return remember(schema, io, schema);
  const handler = handlers.get(def.type);
  if (!handler) {
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
  // the truthful static view of the returned runtime schema.
  return walk(schema, io, [], options);
}
