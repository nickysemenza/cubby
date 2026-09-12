import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * OpenAPI components are named after the Zod schemas the packages export:
 * `productTopLevelOut` becomes `ProductTopLevelOut`. Every exported schema
 * of these modules is registered in `z.globalRegistry` under that name
 * BEFORE the HTTP contract is imported, so the wire projections built from
 * them carry the names into the document.
 *
 * Precedence: an explicit `.meta({ id })` wins; the first export of an
 * instance wins over a re-export; a second, different instance claiming a
 * taken bare name is qualified with its module name; a collision on the
 * qualified name is an error naming both sources.
 */

/** Package export subpaths that hold test helpers, not schemas. */
const EXCLUDED_SUBPATHS = new Set(["./testing"]);

/** Web-side schema modules the HTTP contract reaches, relative to src. */
const WEB_SCHEMA_MODULES = [
  "server/entity-kernel/contracts.ts",
  "server/generated/entity-bindings.gen.ts",
  "entities/generated/entity-lists.gen.ts",
  "entities/generated/entity-details.gen.ts",
] as const;

const packageExports = z.object({
  exports: z.record(z.string(), z.unknown()),
});

/** `ledger-party` -> `LedgerParty`, `productTopLevelOut` -> `ProductTopLevelOut`. */
export const pascal = (name: string): string =>
  name
    .replace(/Schema$/u, "")
    .split(/[-_./]/u)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

interface SchemaModule {
  specifier: string;
  /** The module's own name for qualifying a colliding component name. */
  qualifier: string;
}

const packageModules = (name: string, packageJsonUrl: URL): SchemaModule[] => {
  const { exports } = packageExports.parse(
    JSON.parse(readFileSync(packageJsonUrl, "utf8")),
  );
  return Object.keys(exports)
    .filter((subpath) => !EXCLUDED_SUBPATHS.has(subpath))
    .sort()
    .map((subpath) => ({
      specifier: subpath === "." ? name : `${name}/${subpath.slice(2)}`,
      qualifier: pascal(
        subpath === "." ? name.split("/").at(-1)! : subpath.slice(2),
      ),
    }));
};

const schemaModules = (srcUrl: URL): SchemaModule[] => [
  ...packageModules(
    "@cubby/schemas",
    new URL("../../../packages/schemas/package.json", srcUrl),
  ),
  ...packageModules(
    "@cubby/usda-schemas",
    new URL("../../../packages/usda-schemas/package.json", srcUrl),
  ),
  ...WEB_SCHEMA_MODULES.map((path) => ({
    specifier: new URL(path, srcUrl).href,
    qualifier: pascal(path.replace(/\.gen\.ts$|\.ts$/u, "")),
  })),
];

/**
 * Register every exported schema under its component name and return the
 * name -> schema map. `srcUrl` is the `apps/web/src/` directory.
 */
export async function registerSchemaNames(
  srcUrl: URL,
): Promise<Map<string, z.ZodType>> {
  const named = new Map<string, z.ZodType>();
  const owners = new Map<z.ZodType, string>();
  const claim = (id: string, schema: z.ZodType, source: string) => {
    const clash = named.get(id);
    if (clash !== undefined && clash !== schema)
      throw new Error(
        `OpenAPI component name collision on ${id}: ${source} and ${owners.get(clash) ?? "an explicit .meta({ id })"} name different schemas. Give one of them an explicit .meta({ id }).`,
      );
    named.set(id, schema);
    owners.set(schema, source);
  };
  for (const { specifier, qualifier } of schemaModules(srcUrl)) {
    const module: object = await import(specifier);
    // ESM namespaces list their exports in sorted order, so first-wins is
    // deterministic across runs.
    for (const [exportName, value] of Object.entries(module)) {
      if (!(value instanceof z.ZodType) || owners.has(value)) continue;
      const source = `${specifier}#${exportName}`;
      const explicit = z.globalRegistry.get(value)?.id;
      if (explicit !== undefined) {
        claim(explicit, value, source);
        continue;
      }
      const bare = pascal(exportName);
      const id = named.has(bare) ? `${qualifier}${bare}` : bare;
      claim(id, value, source);
      z.globalRegistry.add(value, { ...z.globalRegistry.get(value), id });
    }
  }
  return named;
}
