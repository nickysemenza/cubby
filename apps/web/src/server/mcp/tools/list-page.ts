import { mcpRowSelectionFields } from "@cubby/schemas/mcp-detail";
import { MAX_PAGE_SIZE } from "@cubby/schemas/pagination";
import { decodeBase64UrlText, encodeBase64Url } from "@cubby/shared/base64";
import { z } from "zod";

import type { McpPageSpec } from "~/contracts/mcp-define";
import {
  type ReadSelection,
  rowSelection,
  selectableRow,
  selectRow,
} from "~/server/mcp/entity-field-selection";

/**
 * One read contract for every paged MCP read: `cursor` (opaque) and
 * `pageSize` in; `pageSize`, `nextCursor`, `totalCount?` and `truncated?`
 * out. Member contracts keep their own paging (pageIndex/pageSize,
 * offset/limit, a keyset or numeric cursor, or a first-N limit); the adapter
 * reads it from the member's input fields and translates once. A cursor holds
 * an absolute row offset, or a member keyset cursor plus the rows of that
 * member page already returned, so a page the size cap cut resumes at its
 * next row.
 */

/** A page's serialized response stays under this; a longer page ends early with `truncated`. */
const MCP_PAGE_MAX_BYTES = 100_000;

const outputObject = z.looseObject({});
/** A member's arguments or result object, read only through schemas here. */
type Fields = z.output<typeof outputObject>;
/** A member result, before its page is cut. */
type MemberResult = z.output<z.ZodType>;

type MemberPaging =
  | { kind: "pages"; nested: boolean }
  | { kind: "offset"; key: "offset" | "cursor" }
  | { kind: "keyset" }
  | { kind: "first" };

/** Member paging inputs; none is published. */
const MEMBER_PAGE_KEYS = new Set([
  "pagination",
  "pageIndex",
  "pageSize",
  "offset",
  "limit",
  "cursor",
  "page",
]);
/** Member continuation outputs, replaced by the published page fields. */
const MEMBER_NEXT_KEYS = new Set([
  "nextCursor",
  "next",
  "nextOffset",
  "totalCount",
  "truncated",
]);
const MEMBER_META_KEYS = new Set([
  "pageIndex",
  "pageSize",
  "totalCount",
  "hasNextPage",
]);

const position = z.strictObject({
  o: z.number().int().nonnegative(),
  c: z.string().min(1).optional(),
});
type Position = z.output<typeof position>;

const encodeCursor = (at: Position) => encodeBase64Url(JSON.stringify(at));
function decodeCursor(cursor: string): Position | null {
  try {
    const parsed = position.safeParse(JSON.parse(decodeBase64UrlText(cursor)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const cursorField = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (cursor) => decodeCursor(cursor) !== null,
    "Not a cursor this server issued; pass the previous page's nextCursor unchanged",
  )
  .optional()
  .describe("The previous page's nextCursor; omit for page 1.");

const pageOutputFields = {
  pageSize: z.number().int().nonnegative(),
  nextCursor: z
    .string()
    .nullable()
    .describe("Pass as `cursor` for the next page; null on the last page."),
  totalCount: z.number().int().nonnegative().optional(),
  truncated: z
    .boolean()
    .optional()
    .describe(
      "The page is incomplete: it ended early under the response size cap (continue with nextCursor), or the read capped what it returns.",
    ),
};

/** Peel wrappers that leave a field's value shape unchanged. */
function peel(schema: z.core.$ZodType): z.core.$ZodType {
  return schema instanceof z.ZodOptional ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodNullable
    ? peel(schema.def.innerType)
    : schema;
}

/** How a member pages, read from its input fields, and its page-size field. */
function memberPaging(fields: Readonly<Record<string, z.core.$ZodType>>) {
  const nested = fields.pagination && peel(fields.pagination);
  if (
    nested instanceof z.ZodObject &&
    nested.shape.pageIndex &&
    nested.shape.pageSize
  )
    return {
      paging: { kind: "pages", nested: true } satisfies MemberPaging,
      size: nested.shape.pageSize,
    };
  if (fields.pageIndex && fields.pageSize)
    return {
      paging: { kind: "pages", nested: false } satisfies MemberPaging,
      size: fields.pageSize,
    };
  if (!fields.limit) return null;
  const cursor = fields.cursor && peel(fields.cursor);
  const paging: MemberPaging =
    cursor instanceof z.ZodString
      ? { kind: "keyset" }
      : fields.offset
        ? { kind: "offset", key: "offset" }
        : cursor instanceof z.ZodNumber
          ? { kind: "offset", key: "cursor" }
          : { kind: "first" };
  return { paging, size: fields.limit };
}

/** The published `pageSize`, with the member's own bounds and default. */
function pageSizeField(
  name: string,
  size: z.core.$ZodType,
  paging: MemberPaging,
) {
  const number = peel(size);
  if (!(number instanceof z.ZodNumber))
    throw new Error(`MCP action ${name}: its page size is not a number`);
  const lowest = Math.max(0, number.minValue ?? 0);
  const min = number.safeParse(lowest).success ? lowest : lowest + 1;
  const max = Math.min(number.maxValue ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  const fallback =
    size instanceof z.ZodDefault
      ? z.number().parse(size.def.defaultValue)
      : undefined;
  // Only an offset member needs no size to place its next page.
  if (fallback === undefined && paging.kind !== "offset")
    throw new Error(`MCP action ${name}: its page size needs a default`);
  const integer = z.number().int().min(min).max(max);
  const described =
    z.globalRegistry.get(number)?.description ??
    z.globalRegistry.get(size)?.description;
  const field = described ? integer.describe(described) : integer;
  return {
    schema: fallback === undefined ? field.optional() : field.default(fallback),
    max,
    fallback,
  };
}

const objectOptions = (schema: z.core.$ZodType): z.ZodObject[] =>
  schema instanceof z.ZodObject
    ? [schema]
    : schema instanceof z.ZodUnion
      ? schema.options.flatMap(objectOptions)
      : [];

const union = (options: z.ZodType[]): z.ZodType =>
  options.length === 1
    ? options[0]!
    : z.union([options[0]!, options[1]!, ...options.slice(2)]);

/** The member input with its paging replaced by the published fields. */
function publishedInput(
  schema: z.core.$ZodType,
  fields: Readonly<Record<string, z.core.$ZodType>>,
): z.ZodType {
  if (schema instanceof z.ZodUnion)
    return union(
      schema.options.map((option) => publishedInput(option, fields)),
    );
  if (!(schema instanceof z.ZodObject)) throw new Error("Unpageable input");
  return z.object({
    ...Object.fromEntries(
      Object.entries(schema.shape).filter(
        ([key]) => !MEMBER_PAGE_KEYS.has(key),
      ),
    ),
    ...fields,
  });
}

const selectables = new WeakMap<z.core.$ZodType, z.ZodType>();
/**
 * A row schema with every object key optional, recursively: what a `fields`
 * or compact selection of a published row can still satisfy.
 */
function selectable(schema: z.core.$ZodType): z.ZodType {
  const cached = selectables.get(schema);
  if (cached) return cached;
  let result: z.ZodType;
  if (schema instanceof z.ZodObject)
    result = z.object(
      Object.fromEntries(
        Object.entries(schema.shape).map(([key, value]) => [
          key,
          selectable(value).optional(),
        ]),
      ),
    );
  else if (schema instanceof z.ZodArray)
    result = z.array(selectable(schema.def.element));
  else if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault)
    result = selectable(schema.def.innerType).optional();
  else if (schema instanceof z.ZodNullable)
    result = selectable(schema.def.innerType).nullable();
  else if (schema instanceof z.ZodUnion)
    result = union(schema.options.map(selectable));
  else if (schema instanceof z.ZodIntersection)
    result = z.intersection(
      selectable(schema.def.left),
      selectable(schema.def.right),
    );
  else if (schema instanceof z.ZodRecord)
    result = z.partialRecord(
      schema.def.keyType,
      selectable(schema.def.valueType),
    );
  else if (schema instanceof z.ZodLazy) {
    const lazy = schema;
    result = z.lazy(() => selectable(lazy.def.getter()));
  } else if (schema instanceof z.ZodType) result = schema;
  else throw new Error("Unsupported row schema");
  const description = z.globalRegistry.get(schema)?.description;
  if (description && result !== schema) result = result.describe(description);
  selectables.set(schema, result);
  return result;
}

const metas = new WeakMap<z.core.$ZodType, z.ZodType | null>();
/** A member's page meta without the fields the published page fields replace. */
function pagedMeta(schema: z.core.$ZodType): z.ZodType | null {
  const cached = metas.get(schema);
  if (cached !== undefined) return cached;
  const inner = peel(schema);
  let result: z.ZodType | null = null;
  if (inner instanceof z.ZodObject) {
    const rest = Object.entries(inner.shape).filter(
      ([key]) => !MEMBER_META_KEYS.has(key),
    );
    if (rest.length > 0) {
      const id = z.globalRegistry.get(inner)?.id;
      const rebuilt = z.object(Object.fromEntries(rest));
      const meta = id ? rebuilt.meta({ id: `Mcp${id}` }) : rebuilt;
      // A page whose remaining meta is all absent drops `meta` entirely.
      const omittable =
        schema instanceof z.ZodOptional ||
        rest.every(([, field]) => field instanceof z.ZodOptional);
      result = omittable ? meta.optional() : meta;
    }
  } else if (schema instanceof z.ZodType) result = schema;
  metas.set(schema, result);
  return result;
}

/** The row schemas an output publishes in its `items` array (or union of arrays). */
function rowsOf(schema: z.ZodObject, items: string): z.core.$ZodType[] {
  const field = schema.shape[items];
  const rows = field && peel(field);
  if (rows instanceof z.ZodArray) return [rows.def.element];
  if (
    rows instanceof z.ZodUnion &&
    rows.options.every((option) => option instanceof z.ZodArray)
  )
    return rows.options.map((option) => option.def.element);
  return [];
}

const rowUnion = (rows: z.core.$ZodType[]) =>
  union(rows.flatMap((row) => (row instanceof z.ZodType ? [row] : [])));

/** The member output with its continuation replaced by the published page fields. */
function publishedOutput(
  schema: z.core.$ZodType,
  items: string,
  projects: boolean,
): z.ZodType {
  if (schema instanceof z.ZodUnion)
    return union(
      schema.options.map((option) => publishedOutput(option, items, projects)),
    );
  if (!(schema instanceof z.ZodObject))
    return schema instanceof z.ZodType ? schema : z.unknown();
  const rows = rowsOf(schema, items);
  if (rows.length === 0) return schema;
  const published: Record<string, z.core.$ZodType> = {};
  for (const [key, value] of Object.entries(schema.shape)) {
    if (MEMBER_NEXT_KEYS.has(key)) continue;
    if (key === "meta") {
      const meta = pagedMeta(value);
      if (meta) published.meta = meta;
      continue;
    }
    published[key] =
      key === items && projects
        ? (() => {
            const array = z.array(selectable(rowUnion(rows)));
            return value instanceof z.ZodOptional ? array.optional() : array;
          })()
        : value;
  }
  const object = z.object({ ...published, ...pageOutputFields });
  const catchall = schema.def.catchall;
  return catchall ? object.catchall(catchall) : object;
}

const numberOf = (value: unknown) =>
  typeof value === "number" ? value : undefined;
const metaOf = (output: Fields) => outputObject.safeParse(output.meta).data;
const totalOf = (output: Fields) =>
  numberOf(output.totalCount) ?? numberOf(metaOf(output)?.totalCount);

/** One member call for the page at `at`, and which of its rows the page starts at. */
function memberRequest(
  paging: MemberPaging,
  at: Position,
  size: number | undefined,
  max: number,
) {
  switch (paging.kind) {
    case "pages": {
      const pageSize = size ?? 0;
      const pageIndex = pageSize === 0 ? 0 : Math.floor(at.o / pageSize);
      const page = { pageIndex, pageSize };
      return {
        args: paging.nested ? { pagination: page } : page,
        skip: at.o - pageIndex * pageSize,
        limit: pageSize,
      };
    }
    case "offset":
      return {
        args: { [paging.key]: at.o, limit: size },
        skip: 0,
        limit: size,
      };
    case "keyset":
    case "first": {
      const limit = Math.min(at.o + (size ?? 0), max);
      return {
        args:
          paging.kind === "keyset" && at.c
            ? { cursor: at.c, limit }
            : { limit },
        skip: at.o,
        limit,
      };
    }
  }
}

/** Where the page after a complete member page starts; `capped` when paging cannot reach more. */
function memberNext(
  paging: MemberPaging,
  output: Fields,
  at: Position,
  fetched: number,
  shown: number,
  limit: number | undefined,
  max: number,
): Position | "capped" | null {
  // A page without rows cannot advance an offset, so it ends the read.
  if (fetched === 0 && paging.kind !== "keyset") return null;
  switch (paging.kind) {
    case "pages": {
      if (!limit) return null;
      const total = totalOf(output);
      const more =
        metaOf(output)?.hasNextPage === true ||
        (total !== undefined && at.o + shown < total);
      return more ? { o: at.o + shown } : null;
    }
    case "offset": {
      const next = output.nextOffset ?? output.nextCursor;
      if (typeof next === "number") return { o: next };
      if (next === null) return null;
      const total = totalOf(output);
      if (total !== undefined)
        return at.o + fetched < total ? { o: at.o + fetched } : null;
      // One offset shared by several branches, each reporting its own next.
      const branched = Object.values(output).some(
        (value) =>
          Array.isArray(value) &&
          value.some(
            (branch) =>
              typeof outputObject.safeParse(branch).data?.nextOffset ===
              "number",
          ),
      );
      if (branched && limit) return { o: at.o + limit };
      return limit !== undefined && fetched >= limit
        ? { o: at.o + fetched }
        : null;
    }
    case "keyset": {
      const next = output.nextCursor ?? output.next;
      return typeof next === "string" && next.length > 0
        ? { c: next, o: 0 }
        : null;
    }
    case "first": {
      const more =
        output.truncated === true || (limit !== undefined && fetched >= limit);
      if (!more) return null;
      return limit !== undefined && limit < max
        ? { o: at.o + shown }
        : "capped";
    }
  }
}

const scalar = (schema: z.core.$ZodType): boolean => {
  const inner = peel(schema);
  return (
    inner instanceof z.ZodString ||
    inner instanceof z.ZodEnum ||
    inner instanceof z.ZodLiteral ||
    inner instanceof z.ZodNumber ||
    (inner instanceof z.ZodUnion && inner.options.every(scalar))
  );
};

/** A list of scalars that also takes one value, under the field's own wrappers. */
function oneOrMany(field: z.core.$ZodType): z.ZodType | null {
  const widened = oneOrManyUnder(field);
  const description = z.globalRegistry.get(field)?.description;
  return widened && description ? widened.describe(description) : widened;
}

function oneOrManyUnder(field: z.core.$ZodType): z.ZodType | null {
  if (field instanceof z.ZodOptional)
    return oneOrMany(field.def.innerType)?.optional() ?? null;
  if (field instanceof z.ZodNullable)
    return oneOrMany(field.def.innerType)?.nullable() ?? null;
  if (field instanceof z.ZodDefault)
    return (
      oneOrMany(field.def.innerType)?.default(field.def.defaultValue) ?? null
    );
  if (!(field instanceof z.ZodArray)) return null;
  const element = field.def.element;
  if (!(element instanceof z.ZodType) || !scalar(element)) return null;
  // The branch clones drop the field's description so it is published once.
  return z.union([element.clone(element.def), field.clone(field.def)]);
}

/**
 * Every read's top-level scalar lists (filters, `fields`) take one value or
 * several: published as `T | T[]`, and a single value is wrapped before any
 * schema parses it, so members keep their list inputs.
 */
export function oneOrManyLists(
  kind: "query" | "mutation",
  input: z.core.$ZodType,
) {
  const keys = new Set<string>();
  const widen = (schema: z.core.$ZodType): z.core.$ZodType => {
    if (schema instanceof z.ZodUnion)
      return schema.clone(
        { ...schema.def, options: schema.def.options.map(widen) },
        { parent: true },
      );
    if (!(schema instanceof z.ZodObject)) return schema;
    const entries = Object.entries(schema.shape).map(([key, field]) => {
      const widened = oneOrMany(field);
      if (widened) keys.add(key);
      return [key, widened ?? field] as const;
    });
    return entries.some(([key]) => keys.has(key))
      ? schema.clone(
          { ...schema.def, shape: Object.fromEntries(entries) },
          { parent: true },
        )
      : schema;
  };
  const schema = kind === "query" ? widen(input) : input;
  return {
    schema,
    normalize: (args: Fields) =>
      Object.fromEntries(
        Object.entries(args).map(([key, value]) => [
          key,
          keys.has(key) && value != null && !Array.isArray(value)
            ? [value]
            : value,
        ]),
      ),
  };
}

const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

export interface PagedRead {
  /** The published input: the member's, with `cursor`/`pageSize` for its paging. */
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  /**
   * Read one page: `input` is the published parse, `raw` the arguments it
   * came from. `fetch` runs the member on `raw` with the member's own paging
   * arguments in place of the published ones.
   */
  read(
    input: Fields,
    raw: Fields,
    fetch: (member: Fields) => Promise<MemberResult>,
  ): Promise<MemberResult>;
}

/**
 * The paged form of a read whose member input pages, or null. A member that
 * declares its own `fields` selection (the entity kernel) keeps it; every
 * other paged read gains the row selection of `mcpRowSelectionFields`.
 */
export function pagedRead(
  name: string,
  input: z.core.$ZodType,
  output: z.core.$ZodType,
  spec: McpPageSpec = {},
): PagedRead | null {
  const options = objectOptions(input);
  const detected = options
    .map((option) => memberPaging(option.shape))
    .find((paging) => paging !== null);
  if (!detected) return null;
  const { paging } = detected;
  const items = spec.items ?? "items";
  const size = pageSizeField(name, detected.size, paging);
  const outputs = objectOptions(output);
  const rows = outputs.flatMap((option) => rowsOf(option, items));
  if (rows.length === 0)
    throw new Error(
      `MCP action ${name} pages its input, but its output has no \`${items}\` array; declare page.items`,
    );
  const row = rowUnion(rows);
  const selects = !options.some((option) => "fields" in option.shape);
  if (selects && options.some((option) => "resultDetail" in option.shape))
    throw new Error(`MCP action ${name} declares resultDetail without fields`);
  const published = publishedInput(input, {
    cursor: cursorField,
    pageSize: size.schema,
    ...(selects ? mcpRowSelectionFields : {}),
  });
  const request = z.looseObject({
    cursor: z.string().optional(),
    pageSize: z.number().optional(),
    fields: z.array(z.string()).optional(),
    resultDetail: z.string().optional(),
  });

  /** One page of a member result: rows, continuation, and whether it fits. */
  const pageOf = (
    result: MemberResult,
    at: Position,
    pageSize: number | undefined,
    call: ReturnType<typeof memberRequest>,
    selection: ReadSelection | null,
  ) => {
    const parsed = outputObject.safeParse(result);
    const all = parsed.data?.[items];
    if (!parsed.data || !Array.isArray(all))
      return { fits: true, incomplete: false, value: result };
    const data = parsed.data;
    const available = all.slice(
      call.skip,
      pageSize === undefined ? undefined : call.skip + pageSize,
    );
    const selected = selection
      ? available.map((value) => {
          const source = selectableRow.safeParse(value);
          return source.success
            ? selectRow(source.data, row, selection)
            : value;
        })
      : available;
    const next = memberNext(
      paging,
      data,
      at,
      all.length,
      available.length,
      call.limit,
      size.max,
    );
    const total = totalOf(data);
    const incomplete = data.truncated === true || next === "capped";
    const base: Fields = {};
    for (const [key, value] of Object.entries(data)) {
      if (MEMBER_NEXT_KEYS.has(key)) continue;
      if (key === "meta") {
        const meta = Object.fromEntries(
          Object.entries(outputObject.safeParse(value).data ?? {}).filter(
            ([field]) => !MEMBER_META_KEYS.has(field),
          ),
        );
        if (Object.keys(meta).length > 0) base.meta = meta;
        continue;
      }
      base[key] = value;
    }
    const render = (
      count: number,
      cursor: Position | null,
      truncated: boolean,
    ) => ({
      ...base,
      [items]: selected.slice(0, count),
      pageSize: pageSize ?? available.length,
      nextCursor: cursor ? encodeCursor(cursor) : null,
      ...(total === undefined ? {} : { totalCount: total }),
      ...(truncated ? { truncated: true } : {}),
    });
    const complete = render(
      selected.length,
      next === "capped" ? null : next,
      incomplete,
    );
    if (bytes(complete) <= MCP_PAGE_MAX_BYTES || selected.length <= 1)
      return { fits: true, incomplete, value: complete };
    if (spec.refetch) return { fits: false, incomplete, value: complete };
    // The longest prefix under the cap; one row always ships, so paging progresses.
    const after = (count: number): Position =>
      paging.kind === "keyset" && at.c
        ? { c: at.c, o: at.o + count }
        : { o: at.o + count };
    const fits = (count: number) =>
      bytes(render(count, after(count), true)) <= MCP_PAGE_MAX_BYTES;
    let low = 1;
    let high = selected.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(middle)) low = middle;
      else high = middle - 1;
    }
    return {
      fits: true,
      incomplete: true,
      value: render(low, after(low), true),
    };
  };

  return {
    input: published,
    output: publishedOutput(output, items, selects),
    read: async (input, raw, fetch) => {
      const { cursor, pageSize, fields, resultDetail } = request.parse(input);
      const member: Fields = Object.fromEntries(
        Object.entries(raw).filter(
          ([key]) =>
            key !== "cursor" &&
            key !== "pageSize" &&
            !(selects && (key === "fields" || key === "resultDetail")),
        ),
      );
      const at = cursor === undefined ? { o: 0 } : decodeCursor(cursor);
      // The published schema refuses an undecodable cursor first.
      if (!at) throw new Error(`${name}: undecodable cursor`);
      const selection = selects
        ? rowSelection(name, row, {
            fields,
            resultDetail: resultDetail === "full" ? "full" : "compact",
          })
        : null;
      let current = pageSize ?? size.fallback;
      for (;;) {
        const call = memberRequest(paging, at, current, size.max);
        const page = pageOf(
          await fetch(
            Object.fromEntries(
              Object.entries({ ...member, ...call.args }).filter(
                ([, value]) => value !== undefined,
              ),
            ),
          ),
          at,
          current,
          call,
          selection,
        );
        // A refetching read halves an oversized or member-capped page.
        if (
          !spec.refetch ||
          (page.fits && !page.incomplete) ||
          current === undefined ||
          current <= 1
        )
          return page.value;
        current = Math.max(1, Math.floor(current / 2));
      }
    },
  };
}
