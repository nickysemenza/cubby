import {
  importRunAgentManifest,
  type AgentImportRunPurpose,
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
  entityKinds?: readonly string[],
) {
  return compiledMcpTools(MCP_TOOL_BINDINGS, MCP_TOOLS).flatMap((tool) => {
    const narrowed = narrowedToolSchema(tool, allowed);
    return narrowed
      ? [
          {
            name: tool.name,
            description: narrowed.description,
            inputSchema:
              tool.name === "entity_read" && entityKinds
                ? narrowedEntityKinds(narrowed.inputJsonSchema, entityKinds)
                : narrowed.inputJsonSchema,
          },
        ]
      : [];
  });
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

/**
 * `schema` with only `kinds` in `entity` and in each per-kind branch (labelled
 * `entity=<kind>`), and without the shared definitions nothing references
 * any more. The input is the cached tool schema, so this builds a copy.
 */
function narrowedEntityKinds(
  schema: InputJsonSchema,
  kinds: readonly string[],
): InputJsonSchema {
  const allowed = new Set(kinds);
  const keep = (branch: JSONType) => {
    const label = isJsonObject(branch) ? branch.description : undefined;
    const kind =
      typeof label === "string" ? ENTITY_BRANCH.exec(label)?.[1] : undefined;
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
  if (!isJsonObject(narrowed)) return schema;
  const { definitions, ...root } = narrowed;
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
  const { mcpActions, mcpEntityKinds }: ImportRunAgentConfig =
    importRunAgentManifest[purpose];
  return purchaseAgentTools(new Set(mcpActions), mcpEntityKinds);
}
