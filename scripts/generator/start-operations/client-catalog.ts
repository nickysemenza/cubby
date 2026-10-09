import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { generatedHeader } from "../artifacts.ts";
import type { EntityArtifacts } from "../entities/declarations.ts";
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
const overridesSchema = z.record(z.string(), overrideMembersSchema);

const cacheTagsModuleSchema = z.object({ ripple: rippleSchema });
const cachePolicyModuleSchema = z.object({
  ENTITY_ROOT_TAGS: z.array(tagSchema),
});
const overridesModuleSchema = z.object({ operationOverrides: overridesSchema });

/** What the catalog needs from the hand-written client modules. */
type ClientModules = {
  ripple: z.infer<typeof rippleSchema>;
  overrides: z.infer<typeof overridesSchema>;
  entityRootTags: readonly Tag[];
};

const loadClientModules = async (): Promise<ClientModules> => ({
  ripple: cacheTagsModuleSchema.parse(
    await import(pathToFileURL(CACHE_TAGS_MODULE).href),
  ).ripple,
  overrides: overridesModuleSchema.parse(
    await import(pathToFileURL(OPERATION_OVERRIDES_MODULE).href),
  ).operationOverrides,
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
  ripple: boolean;
  rippleFor: boolean;
};

class CatalogRenderer {
  readonly used: UsedImports = {
    entityRootTags: false,
    operationOverrides: false,
    ripple: false,
    rippleFor: false,
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
    const kept = this.dataFields(domain, member, definition).filter(
      ([name]) => override === undefined || !(name in override),
    );
    // Imports follow the emitted code, not the computed data: an overridden
    // field's helpers would otherwise be imported and never read.
    for (const [, code] of kept) {
      if (code.includes("...ENTITY_ROOT_TAGS")) this.used.entityRootTags = true;
      if (code.startsWith("ripple.")) this.used.ripple = true;
      if (code.startsWith("rippleFor(")) this.used.rippleFor = true;
    }
    const fields = kept.map(([name, code]) => `${name}: ${code}`);
    if (override !== undefined) {
      this.used.operationOverrides = true;
      fields.push(
        `...${property(property("operationOverrides", domainName), member)}`,
      );
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
    return `export const ${name} = /* @__PURE__ */ defineOperationDomain(${exportName}${
      members.length > 0 ? `, {\n${members.join("\n")}\n}` : ""
    });\n`;
  }

  imports(module: string, contractExports: readonly string[]): string[] {
    return [
      `import { ${contractExports.join(", ")} } from "~/contracts/${module}.contract";`,
      ...(this.used.entityRootTags
        ? [`import { ENTITY_ROOT_TAGS } from "~/contracts/cache-policy";`]
        : []),
      ...(this.used.ripple || this.used.rippleFor
        ? [
            `import { ${[
              ...(this.used.ripple ? ["ripple"] : []),
              ...(this.used.rippleFor ? ["rippleFor"] : []),
            ].join(", ")} } from "~/integrations/tanstack-query/cache-tags";`,
          ]
        : []),
      `import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";`,
      ...(this.used.operationOverrides
        ? [
            `import { operationOverrides } from "~/integrations/tanstack-query/operation-overrides";`,
          ]
        : []),
    ];
  }
}

const CLIENT_CATALOG_DIRECTORY =
  "apps/web/src/integrations/tanstack-query/generated";

/**
 * The browser catalog: one module per contract module
 * (`generated/<module>.gen.ts`), importing only that contract module, so a
 * route bundles only the domains it calls. Each exports one domain object per
 * contract, each query member carrying its resolved cache tags and each
 * mutation its invalidation fan-out. Fails generation on a name collision, an
 * `invalidates` row `ripple` does not have, a malformed tag, or an override
 * that matches no contract member.
 */
export const renderClientCatalog = async (): Promise<EntityArtifacts[]> => {
  const modules = await loadClientModules();
  const names = new Map<string, string>();
  const byModule = new Map<string, LoadedContract[]>();
  for (const loaded of await loadContracts()) {
    const name = domainExportName(loaded.exportName);
    const existing = names.get(name);
    if (existing !== undefined)
      throw new Error(
        `${loaded.exportName} and ${existing} both map to the client catalog export ${name}.`,
      );
    names.set(name, loaded.exportName);
    byModule.set(loaded.module, [
      ...(byModule.get(loaded.module) ?? []),
      loaded,
    ]);
  }
  const unknownDomain = Object.keys(modules.overrides).find(
    (domain) => !names.has(domain),
  );
  if (unknownDomain !== undefined)
    throw new Error(
      `operationOverrides.${unknownDomain} does not match any contract export named ${unknownDomain}Contract.`,
    );
  return [...byModule]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([module, contracts]) => {
      const renderer = new CatalogRenderer(modules);
      const blocks = contracts.map((loaded) => renderer.renderDomain(loaded));
      return {
        relativePath: `${CLIENT_CATALOG_DIRECTORY}/${module}.gen.ts`,
        source:
          generatedHeader +
          `// The browser catalog for contracts/${module}.contract.ts: one domain\n` +
          `// object per contract, each member carrying its resolved cache tags\n` +
          `// (defaulting to [domain, member]) or invalidation fan-out. Cache policy\n` +
          `// is authored as data on the contract members (contracts/cache-policy.ts);\n` +
          `// policy that reads the call's input lives in operation-overrides.ts and\n` +
          `// is spread onto its member here.\n\n` +
          `${renderer
            .imports(
              module,
              contracts.map(({ exportName }) => exportName),
            )
            .join("\n")}\n\n` +
          blocks.join("\n"),
      };
    });
};
