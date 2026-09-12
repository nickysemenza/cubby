import { readFileSync } from "node:fs";
import { z } from "zod";

import { childSchemas, discriminatorOf } from "../../src/lib/http-api/wire";

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
  const seen = new Set<z.ZodType>();
  for (const [id, schema] of named)
    nameUnionMembers(schema, id, [], seen, named, claim);
  return named;
}

/** The constant a member's tag property carries, read off its JSON Schema. */
const literalTag = (option: z.ZodType, key: string): string | undefined => {
  const tag = childSchemas(option).find(([segment]) => segment === key)?.[1];
  if (tag === undefined) return undefined;
  const json = z.toJSONSchema(tag, { unrepresentable: "any" });
  const value = z
    .union([z.string(), z.number(), z.boolean()])
    .safeParse(json.const ?? json.enum?.[0]).data;
  return value === undefined ? undefined : String(value);
};

const structuralSegment = /^(?:innerType|\[|\||&|in$|out$|\(\))/u;

/**
 * A discriminated union's members must be components for the document's
 * `discriminator.mapping` to reference them, so an unnamed member is named
 * after the nearest named ancestor and its tag: `Source` + `url` gives
 * `SourceUrl`. When two unnamed unions share that ancestor, the property
 * path from it (`trail`) tells them apart. Walks every named export once.
 */
function nameUnionMembers(
  schema: z.ZodType,
  parent: string,
  trail: readonly string[],
  seen: Set<z.ZodType>,
  named: ReadonlyMap<string, z.ZodType>,
  claim: (id: string, schema: z.ZodType, source: string) => void,
): void {
  if (seen.has(schema)) return;
  seen.add(schema);
  const key = discriminatorOf(schema);
  for (const [segment, child] of childSchemas(schema)) {
    if (key !== undefined && z.globalRegistry.get(child)?.id === undefined) {
      const tag = literalTag(child, key);
      if (tag !== undefined) {
        const bare = `${parent}${pascal(tag)}`;
        const taken = named.get(bare);
        const id =
          taken === undefined || taken === child
            ? bare
            : `${parent}${trail.map(pascal).join("")}${pascal(tag)}`;
        claim(id, child, `${parent}${trail.join(".")}${segment}`);
        z.globalRegistry.add(child, { ...z.globalRegistry.get(child), id });
      }
    }
    const childId = z.globalRegistry.get(child)?.id;
    nameUnionMembers(
      child,
      childId ?? parent,
      childId !== undefined || structuralSegment.test(segment)
        ? []
        : [...trail, segment],
      seen,
      named,
      claim,
    );
  }
}
