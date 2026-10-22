import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { generatedHeader } from "../artifacts.ts";
import {
  type ContractMember,
  type LoadedContract,
  loadContracts,
  OPERATION_OVERRIDES_MODULE,
  SOURCE_ROOT,
} from "./collect.ts";

const CACHE_TAGS_MODULE = join(
  SOURCE_ROOT,
  "integrations/tanstack-query/cache-tags.ts",
);
const CACHE_POLICY_MODULE = join(SOURCE_ROOT, "contracts/cache-policy.ts");

const tagSchema = z.array(z.string().min(1)).min(1);
type Tag = z.infer<typeof tagSchema>;
const rippleSchema = z.record(z.string(), z.unknown());
const overrideMembersSchema = z.record(z.string(), z.unknown());
type OverrideMembers = z.infer<typeof overrideMembersSchema>;

const cacheTagsModuleSchema = z.object({ ripple: rippleSchema });
const cachePolicyModuleSchema = z.object({
  ENTITY_ROOT_TAGS: z.array(tagSchema),
});
const overridesModuleSchema = z.record(z.string(), z.unknown());

/** What the catalog needs from the hand-written client modules. */
type ClientModules = {
  ripple: z.infer<typeof rippleSchema>;
  overrides: Record<string, OverrideMembers>;
  entityRootTags: readonly Tag[];
};

const loadClientModules = async (): Promise<ClientModules> => ({
  ripple: cacheTagsModuleSchema.parse(
    await import(pathToFileURL(CACHE_TAGS_MODULE).href),
  ).ripple,
  overrides: Object.fromEntries(
    Object.entries(
      overridesModuleSchema.parse(
        await import(pathToFileURL(OPERATION_OVERRIDES_MODULE).href),
      ),
    )
      .filter(([name]) => name.endsWith("Overrides"))
      .map(([name, value]) => [
        name.slice(0, -"Overrides".length),
        overrideMembersSchema.parse(value),
      ]),
  ),
  entityRootTags: cachePolicyModuleSchema.parse(
    await import(pathToFileURL(CACHE_POLICY_MODULE).href),
  ).ENTITY_ROOT_TAGS,
});

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const property = (base: string, key: string): string =>
  IDENTIFIER.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
const memberKey = (key: string): string =>
  IDENTIFIER.test(key) ? key : JSON.stringify(key);

/** A domain's export name is its contract's, without the `Contract` suffix. */
const domainExportName = (contractExport: string): string => {
  if (!contractExport.endsWith("Contract") || contractExport === "Contract")
    throw new Error(
      `${contractExport} must be named <domain>Contract to get a client catalog export.`,
    );
  return contractExport.slice(0, -"Contract".length);
};

/** Which optional imports the emitted module ended up needing. */
type UsedImports = {
  entityRootTags: boolean;
  operationOverrides: boolean;
};

class CatalogRenderer {
  readonly used: UsedImports = {
    entityRootTags: false,
    operationOverrides: false,
  };
  private readonly entityRootsJson: string;

  constructor(private readonly modules: ClientModules) {
    this.entityRootsJson = JSON.stringify(modules.entityRootTags);
  }

  /**
   * The default tag is the operation's own id, split into its two segments, so
   * `product.search` answers to `["product", "search"]` and a `["product"]`
   * invalidation reaches it by prefix. An explicit list (even an empty one)
   * replaces the default.
   */
  private tagsOf(
    domain: string,
    member: string,
    definition: ContractMember,
  ): readonly Tag[] {
    const declared = definition.cache?.tags;
    return declared === undefined
      ? [[domain, member]]
      : z.array(tagSchema).parse(declared, {
          error: () =>
            `${domain}.${member} declares an invalid cache tag; a tag is a non-empty list of non-empty strings.`,
        });
  }

  private renderTags(tags: readonly Tag[]): string {
    const roots = this.modules.entityRootTags.length;
    const endsWithRoots =
      tags.length >= roots &&
      JSON.stringify(tags.slice(tags.length - roots)) === this.entityRootsJson;
    if (!endsWithRoots)
      return `[${tags.map((tag) => JSON.stringify(tag)).join(", ")}]`;
    this.used.entityRootTags = true;
    const prefix = tags
      .slice(0, tags.length - roots)
      .map((tag) => JSON.stringify(tag));
    return `[${[...prefix, "...ENTITY_ROOT_TAGS"].join(", ")}]`;
  }

  private renderInvalidates(
    operation: string,
    keys: readonly string[],
  ): string {
    for (const key of keys) {
      if (key === "none" || !Object.hasOwn(this.modules.ripple, key))
        throw new Error(
          `${operation} invalidates unknown ripple row ${JSON.stringify(key)}. Add it to \`ripple\` in cache-tags.ts and to RippleKey in contracts/cache-policy.ts.`,
        );
    }
    const [only, ...rest] = keys;
    if (only === undefined) return "ripple.none";
    if (rest.length === 0) return property("ripple", only);
    return `rippleFor(${JSON.stringify(keys)})`;
  }

  /** The policy fields one query or mutation member contributes. */
  private dataFields(
    domain: string,
    member: string,
    definition: ContractMember,
  ): [string, string][] {
    const operation = `${domain}.${member}`;
    if (definition.kind === "query") {
      if (definition.invalidates !== undefined)
        throw new Error(
          `${operation} is a query and cannot declare invalidates.`,
        );
      const fields: [string, string][] = [
        ["tags", this.renderTags(this.tagsOf(domain, member, definition))],
      ];
      const profile = definition.cache?.profile;
      if (profile !== undefined)
        fields.push(["cache", JSON.stringify(profile)]);
      return fields;
    }
    if (definition.cache !== undefined)
      throw new Error(`${operation} is a mutation and cannot declare cache.`);
    return [
      [
        "invalidates",
        this.renderInvalidates(operation, definition.invalidates ?? []),
      ],
    ];
  }

  private renderMember(
    domainName: string,
    domain: string,
    member: string,
    definition: ContractMember,
    override: OverrideMembers | undefined,
  ): string | undefined {
    if (definition.kind === "subscription") {
      if (override !== undefined)
        throw new Error(
          `${domain}.${member} is a subscription and takes no override.`,
        );
      return undefined;
    }
    // A field the override defines is not also emitted from contract data.
    const fields = this.dataFields(domain, member, definition)
      .filter(([name]) => override === undefined || !(name in override))
      .map(([name, code]) => `${name}: ${code}`);
    if (override !== undefined) {
      this.used.operationOverrides = true;
      fields.push(`...${property(`${domainName}Overrides`, member)}`);
    }
    return `  ${memberKey(member)}: { ${fields.join(", ")} },`;
  }

  renderDomain({ exportName, contract }: LoadedContract): string {
    const name = domainExportName(exportName);
    const overrides = this.modules.overrides[name] ?? {};
    const unknownOverride = Object.keys(overrides).find(
      (member) => contract.ops[member] === undefined,
    );
    if (unknownOverride !== undefined)
      throw new Error(
        `operationOverrides.${name}.${unknownOverride} does not match a member of ${exportName}.`,
      );
    const members = Object.entries(contract.ops).flatMap(
      ([member, definition]) =>
        this.renderMember(
          name,
          contract.domain,
          member,
          definition,
          overrides[member] === undefined
            ? undefined
            : overrideMembersSchema.parse(overrides[member]),
        ) ?? [],
    );
    return `export const ${name} = /* @__PURE__ */ defineOperationDomain(contract${
      members.length > 0 ? `, {\n${members.join("\n")}\n}` : ""
    });\n`;
  }

  imports(
    exportName: string,
    module: string,
    name: string,
    body: string,
  ): string[] {
    const cacheImports = [
      ...(body.includes("ripple.") || body.includes("ripple[")
        ? ["ripple"]
        : []),
      ...(body.includes("rippleFor(") ? ["rippleFor"] : []),
    ];
    return [
      `import { ${exportName} as contract } from "${module}";`,
      ...(this.used.entityRootTags
        ? [`import { ENTITY_ROOT_TAGS } from "~/contracts/cache-policy";`]
        : []),
      ...(cacheImports.length
        ? [
            `import { ${cacheImports.join(", ")} } from "~/integrations/tanstack-query/cache-tags";`,
          ]
        : []),
      `import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";`,
      ...(this.used.operationOverrides
        ? [
            `import { ${name}Overrides } from "~/integrations/tanstack-query/operation-overrides/${name}";`,
          ]
        : []),
    ];
  }
}

/** Generate isolated domain modules plus test-only enumeration and lazy commands. */
export const renderClientCatalog = async (): Promise<{
  domains: { relativePath: string; source: string }[];
  all: { relativePath: string; source: string };
  commands: { relativePath: string; source: string };
  commandRuntime: { relativePath: string; source: string };
}> => {
  const modules = await loadClientModules();
  const loadedContracts = await loadContracts();
  const names = new Map<string, string>();
  const domains = loadedContracts.map((loaded) => {
    const name = domainExportName(loaded.exportName);
    const existing = names.get(name);
    if (existing !== undefined)
      throw new Error(
        `${loaded.exportName} and ${existing} both map to the client catalog export ${name}.`,
      );
    names.set(name, loaded.exportName);
    const renderer = new CatalogRenderer(modules);
    const body = renderer.renderDomain(loaded);
    return {
      name,
      relativePath: `apps/web/src/integrations/tanstack-query/generated/catalog/${name}.gen.ts`,
      source:
        generatedHeader +
        renderer
          .imports(loaded.exportName, loaded.module, name, body)
          .join("\n") +
        "\n\n" +
        body,
    };
  });
  const unknownDomain = Object.keys(modules.overrides).find(
    (domain) => !names.has(domain),
  );
  if (unknownDomain !== undefined)
    throw new Error(
      `operationOverrides.${unknownDomain} does not match any contract export named ${unknownDomain}Contract.`,
    );

  const allSource =
    generatedHeader +
    domains
      .map(
        ({ name }) =>
          `export { ${name} } from "~/integrations/tanstack-query/generated/catalog/${name}.gen";`,
      )
      .join("\n") +
    "\n";

  const commandCases = loadedContracts.flatMap(({ exportName, contract }) =>
    Object.entries(contract.ops).flatMap(([member, definition]) => {
      if (definition.kind !== "mutation" || definition.command === undefined)
        return [];
      const operation = `${contract.domain}.${member}`;
      const name = domainExportName(exportName);
      const descriptor = property(name, member);
      const commandJson = JSON.stringify(z.json().parse(definition.command));
      if (commandJson === undefined)
        throw new Error(
          `${operation} command metadata is not JSON-compatible.`,
        );
      return [
        {
          domain: name,
          metadata: `    case ${JSON.stringify(operation)}: return ${commandJson};`,
          options: `    case ${JSON.stringify(operation)}: { const descriptor = ${descriptor}; const input = descriptor.definition.input; if (!input) throw new Error(\`Command \${operation} has no input schema.\`); return { ...descriptor.mutationOptions(), command: workflowCommandMetadata(operation), mutationFn: async (body: Record<string, unknown>): Promise<unknown> => descriptor.call(input.parse(body)) }; }`,
        },
      ];
    }),
  );
  const commandSource =
    generatedHeader +
    `import type { WorkflowCommandMetadata } from "@cubby/schemas/workflow-command";\n\n` +
    `export function workflowCommandMetadata(operation: string): WorkflowCommandMetadata {\n  switch (operation) {\n${commandCases.map(({ metadata }) => metadata).join("\n")}\n    default: throw new Error(\`Undeclared user command: \${operation}\`);\n  }\n}\n\n` +
    `export async function loadWorkflowCommandOptions(operation: string) {\n  const { workflowCommandOptions } = await import("~/integrations/tanstack-query/generated/command-runtime.gen");\n  return workflowCommandOptions(operation);\n}\n`;
  const commandRuntimeSource =
    generatedHeader +
    `import { workflowCommandMetadata } from "~/integrations/tanstack-query/generated/commands.gen";\n` +
    [...new Set(commandCases.map(({ domain }) => domain))]
      .map(
        (domain) =>
          `import { ${domain} } from "~/integrations/tanstack-query/generated/catalog/${domain}.gen";`,
      )
      .join("\n") +
    `\n\nexport function workflowCommandOptions(operation: string) {\n  switch (operation) {\n${commandCases.map(({ options }) => options).join("\n")}\n    default: throw new Error(\`Undeclared user command: \${operation}\`);\n  }\n}\n`;
  return {
    domains,
    all: {
      relativePath:
        "apps/web/src/integrations/tanstack-query/generated/catalog/all.gen.ts",
      source: allSource,
    },
    commands: {
      relativePath:
        "apps/web/src/integrations/tanstack-query/generated/commands.gen.ts",
      source: commandSource,
    },
    commandRuntime: {
      relativePath:
        "apps/web/src/integrations/tanstack-query/generated/command-runtime.gen.ts",
      source: commandRuntimeSource,
    },
  };
};
