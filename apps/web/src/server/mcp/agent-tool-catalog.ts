import {
  importRunAgentManifest,
  type AgentImportRunPurpose,
  type EntityReadView,
  type ImportRunAgentConfig,
} from "@cubby/schemas/import-run-agent";
import type { JSONType } from "zod";

import { MCP_TOOLS } from "~/contracts/mcp-tools";
import { MCP_TOOL_BINDINGS } from "~/server/generated/mcp-tools.gen";

import {
  compiledMcpTools,
  narrowedToolSchema,
} from "./tools/tool-registration";

/**
 * The tools a purchase agent mounts, each narrowed to its `allowed` actions:
 * what `tools/list` answers that agent, and what the agent mounts without
 * listing (`purchaseAgentToolCatalog`).
 */
export function purchaseAgentTools(
  allowed: ReadonlySet<string>,
  entityRead?: EntityReadView,
) {
  return compiledMcpTools(MCP_TOOL_BINDINGS, MCP_TOOLS).flatMap((tool) => {
    const narrowed = narrowedToolSchema(tool, allowed);
    if (!narrowed) return [];
    if (tool.name !== "entity_read" || !entityRead)
      return [
        {
          name: tool.name,
          description: narrowed.description,
          inputSchema: narrowed.inputJsonSchema,
        },
      ];
    return [
      {
        name: tool.name,
        description: withoutOtherKindNotes(
          narrowed.description,
          entityKindsOf(narrowed.inputJsonSchema),
          new Set(Object.keys(entityRead.filters)),
        ),
        inputSchema: narrowedEntityRead(narrowed.inputJsonSchema, entityRead),
      },
    ];
  });
}

/** Every kind a tool schema's `entity` input names. */
function entityKindsOf(schema: InputJsonSchema): Set<string> {
  const entity = isJsonObject(schema.properties)
    ? schema.properties.entity
    : undefined;
  return new Set(
    isJsonObject(entity) && Array.isArray(entity.enum)
      ? entity.enum.map(String)
      : [],
  );
}

/**
 * `description` without the declaration's sentences about other kinds: a
 * sentence whose first word names an entity kind (`Recipe availability …`)
 * describes that kind alone.
 */
function withoutOtherKindNotes(
  description: string,
  kinds: ReadonlySet<string>,
  served: ReadonlySet<string>,
): string {
  const [declaration = "", ...rest] = description.split("\n\n");
  const kept = declaration.split(/(?<=\.) /u).filter((sentence) => {
    const word = /^\w+/u.exec(sentence)?.[0] ?? "";
    const kind = word.charAt(0).toLowerCase() + word.slice(1);
    return !kinds.has(kind) || served.has(kind);
  });
  return [kept.join(" "), ...rest].join("\n\n");
}

type JsonObject = { [key: string]: JSONType };
/** A tool's advertised input JSON Schema, as `narrowedToolSchema` publishes it. */
type InputJsonSchema = NonNullable<
  ReturnType<typeof narrowedToolSchema>
>["inputJsonSchema"];
const isJsonObject = (value: JSONType | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ENTITY_BRANCH = /\bentity=(\w+)/u;
const REF = /"\$ref":"#\/definitions\/([^"]+)"/gu;

/** The kind a per-kind branch (labelled `entity=<kind>`) serves. */
const branchKind = (branch: JSONType) => {
  const label = isJsonObject(branch) ? branch.description : undefined;
  return typeof label === "string" ? ENTITY_BRANCH.exec(label)?.[1] : undefined;
};

/** A per-kind `filters` branch advertising only `keys` of its properties. */
function narrowedFilters(branch: JSONType, keys: ReadonlySet<string>) {
  const only = (part: JSONType): JSONType =>
    isJsonObject(part) && isJsonObject(part.properties)
      ? {
          ...part,
          properties: Object.fromEntries(
            Object.entries(part.properties).filter(([key]) => keys.has(key)),
          ),
        }
      : part;
  if (!isJsonObject(branch)) return branch;
  return Array.isArray(branch.allOf)
    ? { ...branch, allOf: branch.allOf.map(only) }
    : only(branch);
}

/**
 * `schema` as `view` serves the agent: only its kinds in `entity` and in each
 * per-kind branch, only each kind's listed `filters`, none of the `omit`
 * inputs, and without the shared definitions nothing references any more.
 * The input is the cached tool schema, so this builds a copy.
 */
function narrowedEntityRead(
  schema: InputJsonSchema,
  view: EntityReadView,
): InputJsonSchema {
  const allowed = new Set(Object.keys(view.filters));
  const keep = (branch: JSONType) => {
    const kind = branchKind(branch);
    return kind === undefined || allowed.has(kind);
  };
  const narrow = (value: JSONType, key?: string): JSONType => {
    if (Array.isArray(value))
      return value
        .filter((item) => key !== "anyOf" || keep(item))
        .map((item) => narrow(item));
    if (!isJsonObject(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([name, item]): [string, JSONType] =>
        key === "entity" && name === "enum" && Array.isArray(item)
          ? [name, item.filter((kind) => allowed.has(String(kind)))]
          : [name, narrow(item, name)],
      ),
    );
  };
  const narrowed = narrow(schema);
  if (!isJsonObject(narrowed) || !isJsonObject(narrowed.properties))
    return schema;
  const omitted = new Set(view.omit);
  const properties = Object.fromEntries(
    Object.entries(narrowed.properties).flatMap(
      ([name, value]): Array<[string, JSONType]> => {
        if (omitted.has(name)) return [];
        if (name !== "filters" || !isJsonObject(value)) return [[name, value]];
        const filters = (branch: JSONType) =>
          narrowedFilters(
            branch,
            new Set(view.filters[branchKind(branch) ?? ""] ?? []),
          );
        return [
          [
            name,
            Array.isArray(value.anyOf)
              ? { ...value, anyOf: value.anyOf.map(filters) }
              : filters(value),
          ],
        ];
      },
    ),
  );
  const { definitions, ...rest } = narrowed;
  const root = { ...rest, properties };
  if (!isJsonObject(definitions)) return root;
  const reachable = new Set<string>();
  const pending = [JSON.stringify(root)];
  while (pending.length > 0) {
    for (const [, name] of (pending.pop() ?? "").matchAll(REF)) {
      if (!name || reachable.has(name)) continue;
      reachable.add(name);
      pending.push(JSON.stringify(definitions[name] ?? null));
    }
  }
  return {
    ...root,
    definitions: Object.fromEntries(
      Object.entries(definitions).filter(([name]) => reachable.has(name)),
    ),
  };
}

/** The MCP tools a run purpose's agent mounts, as `tools/list` describes them. */
export function purchaseAgentToolCatalog(purpose: AgentImportRunPurpose) {
  const { mcpActions, entityRead }: ImportRunAgentConfig =
    importRunAgentManifest[purpose];
  return purchaseAgentTools(new Set(mcpActions), entityRead);
}
