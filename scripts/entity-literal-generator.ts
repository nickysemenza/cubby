import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_DIRECTORY = resolve(
  ROOT,
  "scripts/entity-literals/entities",
);
const SPEC_PATH = SPEC_DIRECTORY;

type AstNode = { type: string; [key: string]: unknown };
type LiteralValue = string | number | boolean | null | LiteralObject | LiteralValue[];
interface LiteralObject {
  [key: string]: LiteralValue;
}

type SourceRef = Readonly<{ module: string; export: string }>;
export type EntityLiteral = Readonly<{
  key: string;
  shortcode: string | null;
  /** Raw descriptor data; compiler emits the runtime shape without helper calls. */
  descriptor: LiteralObject;
  contract:
    | Readonly<{
        create: SourceRef;
        update: SourceRef;
        output: SourceRef;
        mcpOut: SourceRef | null;
      }>
    | null;
  route: Readonly<{ basePath: string; detailParam?: string }> | null;
  filterUrlKeys: readonly string[];
}>;

export type EntityArtifacts = Readonly<{
  relativePath: string;
  source: string;
}>;

class LiteralSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiteralSpecError";
  }
}

const isNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null && "type" in value;

const asNode = (value: unknown, context: string): AstNode => {
  if (!isNode(value)) {
    throw new LiteralSpecError(`${context} must be syntax.`);
  }
  return value;
};

const objectValue = (value: LiteralValue, context: string): LiteralObject => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LiteralSpecError(`${context} must be an object.`);
  }
  return value;
};

const required = (object: LiteralObject, key: string, context: string) => {
  if (!(key in object)) {
    throw new LiteralSpecError(`${context}.${key} is required.`);
  }
  const value = object[key];
  if (value === undefined) {
    throw new LiteralSpecError(`${context}.${key} must not be undefined.`);
  }
  return value;
};

const stringValue = (value: LiteralValue, context: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new LiteralSpecError(`${context} must be a non-empty string.`);
  }
  return value;
};

const booleanValue = (value: LiteralValue, context: string): boolean => {
  if (typeof value !== "boolean") {
    throw new LiteralSpecError(`${context} must be a boolean.`);
  }
  return value;
};

const exactKeys = (
  object: LiteralObject,
  allowed: readonly string[],
  context: string,
) => {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new LiteralSpecError(`${context}.${key} is not allowed.`);
    }
  }
};

const sourceRef = (value: LiteralValue, context: string): SourceRef => {
  const object = objectValue(value, context);
  exactKeys(object, ["module", "export"], context);
  return {
    module: stringValue(required(object, "module", context), `${context}.module`),
    export: stringValue(required(object, "export", context), `${context}.export`),
  };
};

const policies = ["restrict", "cascade", "setNull", "detach"] as const;

const legacyShape = (raw: LiteralObject, context: string): LiteralObject => {
  if (raw.descriptor !== undefined) return { filters: { urlKeys: [] }, ...raw };
  exactKeys(raw, ["key", "names", "route", "table", "identifiers", "presentation", "fields", "filters", "relations", "search", "capabilities", "extensions"], context);
  const names = objectValue(required(raw, "names", context), `${context}.names`);
  exactKeys(names, ["singular", "plural"], `${context}.names`);
  const identifiers = objectValue(required(raw, "identifiers", context), `${context}.identifiers`);
  exactKeys(identifiers, ["brand", "shortcode", "legacy"], `${context}.identifiers`);
  const presentation = objectValue(required(raw, "presentation", context), `${context}.presentation`);
  exactKeys(presentation, ["titleField"], `${context}.presentation`);
  const search = objectValue(required(raw, "search", context), `${context}.search`);
  exactKeys(search, ["enabled"], `${context}.search`);
  const capabilities = objectValue(required(raw, "capabilities", context), `${context}.capabilities`);
  exactKeys(capabilities, ["auditable", "images", "countable", "softDelete", "delete", "merge", "mcp"], `${context}.capabilities`);
  const extensions = objectValue(required(raw, "extensions", context), `${context}.extensions`);
  exactKeys(extensions, ["countFilter", "relatednessSignals", "mcpNames"], `${context}.extensions`);
  const deleteCapability = required(capabilities, "delete", `${context}.capabilities`);
  if (deleteCapability !== null) {
    const deletion = objectValue(deleteCapability, `${context}.capabilities.delete`);
    exactKeys(deletion, ["mode", "bulk"], `${context}.capabilities.delete`);
    const mode = stringValue(required(deletion, "mode", `${context}.capabilities.delete`), `${context}.capabilities.delete.mode`);
    if (mode !== "soft" && mode !== "hard") throw new LiteralSpecError(`${context}.capabilities.delete.mode is invalid.`);
    booleanValue(required(deletion, "bulk", `${context}.capabilities.delete`), `${context}.capabilities.delete.bulk`);
  }
  booleanValue(required(capabilities, "merge", `${context}.capabilities`), `${context}.capabilities.merge`);
  const mcpActions = required(capabilities, "mcp", `${context}.capabilities`);
  if (!Array.isArray(mcpActions)) throw new LiteralSpecError(`${context}.capabilities.mcp must be an array.`);
  const supportedMcpActions = ["get", "list", "create", "update", "delete"];
  for (const [index, action] of mcpActions.entries()) {
    const name = stringValue(action, `${context}.capabilities.mcp[${index}]`);
    if (!supportedMcpActions.includes(name)) throw new LiteralSpecError(`${context}.capabilities.mcp[${index}] is unsupported.`);
  }
  const relations = required(raw, "relations", context);
  if (!Array.isArray(relations)) throw new LiteralSpecError(`${context}.relations must be an array.`);
  for (const [index, value] of relations.entries()) {
    const relation = objectValue(value, `${context}.relations[${index}]`);
    exactKeys(relation, ["key", "label", "target", "provenance", "deletionPolicy", "inverse"], `${context}.relations[${index}]`);
    const provenance = objectValue(required(relation, "provenance", `${context}.relations[${index}]`), `${context}.relations[${index}].provenance`);
    const policy =
      relation.deletionPolicy === undefined
        ? "restrict"
        : stringValue(
            relation.deletionPolicy,
            `${context}.relations[${index}].deletionPolicy`,
          );
    if (!(policies as readonly string[]).includes(policy)) throw new LiteralSpecError(`${context}.relations[${index}].deletionPolicy is invalid.`);
    relation.deletionPolicy = policy;
    if (provenance.kind === "local-path" && relation.inverse === undefined) throw new LiteralSpecError(`${context}.relations[${index}] local-path requires inverse.`);
  }
  const route = required(raw, "route", context);
  if (route !== null) {
    exactKeys(objectValue(route, `${context}.route`), ["basePath", "detailParam"], `${context}.route`);
  }
  return {
    key: required(raw, "key", context),
    route,
    descriptor: {
      dbTable: required(raw, "table", context), idBrand: required(identifiers, "brand", `${context}.identifiers`),
      ...(identifiers.shortcode === null ? {} : { shortcodePrefix: identifiers.shortcode }),
      ...(identifiers.legacy === null ? {} : { legacyShortcodePrefix: identifiers.legacy }),
      softDelete: required(capabilities, "softDelete", `${context}.capabilities`),
      ...(route === null ? { browserRoutes: false } : {}),
      auditable: required(capabilities, "auditable", `${context}.capabilities`), hasImages: required(capabilities, "images", `${context}.capabilities`),
      searchable: required(search, "enabled", `${context}.search`), countable: required(capabilities, "countable", `${context}.capabilities`), relationships: relations,
      lifecycle: { delete: required(capabilities, "delete", `${context}.capabilities`), merge: required(capabilities, "merge", `${context}.capabilities`) },
      mcp: required(capabilities, "mcp", `${context}.capabilities`),
      ...(extensions.countFilter === null ? {} : { countFilter: extensions.countFilter }),
      ...(extensions.mcpNames === null ? {} : { mcpNames: extensions.mcpNames }),
      ...(extensions.relatednessSignals === null ? {} : { relatednessSignals: extensions.relatednessSignals }),
    },
    contract: required(raw, "fields", context),
    filters: required(raw, "filters", context),
  };
};

const compileEntity = (value: LiteralValue, index: number): EntityLiteral => {
  const context = `ENTITY_LITERALS[${index}]`;
  const object = legacyShape(objectValue(value, context), context);
  exactKeys(
    object,
    ["key", "contract", "descriptor", "route", "filters"],
    context,
  );

  const key = stringValue(required(object, "key", context), `${context}.key`);
  if (!/^[a-z][a-zA-Z-]*$/.test(key)) {
    throw new LiteralSpecError(`${context}.key must be lower-camel-case or kebab-case.`);
  }

  const descriptor = objectValue(required(object, "descriptor", context), `${context}.descriptor`);
  const filters = objectValue(required(object, "filters", context), `${context}.filters`);
  exactKeys(filters, ["urlKeys"], `${context}.filters`);
  const rawFilterUrlKeys = required(filters, "urlKeys", `${context}.filters`);
  if (!Array.isArray(rawFilterUrlKeys)) {
    throw new LiteralSpecError(`${context}.filters.urlKeys must be an array.`);
  }
  const filterUrlKeys = rawFilterUrlKeys.map((value, index) =>
    stringValue(value, `${context}.filters.urlKeys[${index}]`),
  );
  if (new Set(filterUrlKeys).size !== filterUrlKeys.length) {
    throw new LiteralSpecError(`${context}.filters.urlKeys contains duplicates.`);
  }
  const routeValue = object.route;
  const route = routeValue === undefined || routeValue === null ? null : (() => {
    const value = objectValue(routeValue, `${context}.route`);
    return { basePath: stringValue(required(value, "basePath", `${context}.route`), `${context}.route.basePath`), ...(value.detailParam === undefined ? {} : { detailParam: stringValue(value.detailParam, `${context}.route.detailParam`) }) };
  })();
  const shortcodeValue = descriptor.shortcodePrefix;
  const shortcode = shortcodeValue === undefined ? null : stringValue(shortcodeValue, `${context}.descriptor.shortcodePrefix`);
  if (shortcode !== null && !/^[A-Z]{3}-$/.test(shortcode)) {
    throw new LiteralSpecError(`${context}.descriptor.shortcodePrefix must be an XXX- prefix.`);
  }
  booleanValue(required(descriptor, "auditable", `${context}.descriptor`), `${context}.descriptor.auditable`);
  if (descriptor.browserRoutes !== undefined) booleanValue(descriptor.browserRoutes, `${context}.descriptor.browserRoutes`);
  booleanValue(required(descriptor, "searchable", `${context}.descriptor`), `${context}.descriptor.searchable`);

  const contractValue = required(object, "contract", context);
  const contract =
    contractValue === null
      ? null
      : (() => {
          const contractObject = objectValue(contractValue, `${context}.contract`);
          exactKeys(
            contractObject,
            ["create", "update", "output", "mcpOut"],
            `${context}.contract`,
          );
          const mcpOut = required(contractObject, "mcpOut", `${context}.contract`);
          return {
            create: sourceRef(
              required(contractObject, "create", `${context}.contract`),
              `${context}.contract.create`,
            ),
            update: sourceRef(
              required(contractObject, "update", `${context}.contract`),
              `${context}.contract.update`,
            ),
            output: sourceRef(
              required(contractObject, "output", `${context}.contract`),
              `${context}.contract.output`,
            ),
            mcpOut:
              mcpOut === null
                ? null
                : sourceRef(mcpOut, `${context}.contract.mcpOut`),
          };
        })();

  if (shortcode === null && contract !== null) {
    throw new LiteralSpecError(`${context} cannot declare a contract without a shortcode.`);
  }
  return {
    key,
    shortcode,
    contract,
    descriptor,
    route,
    filterUrlKeys,
  };
};

const unwrapTypeAssertion = (node: AstNode): AstNode => {
  if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression") {
    return unwrapTypeAssertion(asNode(node.expression, `${node.type}.expression`));
  }
  return node;
};

const literalFromNode = (node: AstNode, context: string): LiteralValue => {
  const expression = unwrapTypeAssertion(node);
  if (expression.type === "Literal") {
    const value = expression.value;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      return value;
    }
  }

  if (expression.type === "ArrayExpression") {
    const elements = expression.elements;
    if (!Array.isArray(elements)) {
      throw new LiteralSpecError(`${context} has an invalid array.`);
    }
    return elements.map((element, index) =>
      literalFromNode(asNode(element, `${context}[${index}]`), `${context}[${index}]`),
    );
  }

  if (expression.type === "ObjectExpression") {
    const properties = expression.properties;
    if (!Array.isArray(properties)) {
      throw new LiteralSpecError(`${context} has an invalid object.`);
    }
    const result: LiteralObject = {};
    for (const propertyValue of properties) {
      const property = asNode(propertyValue, context);
      if (
        property.type !== "Property" ||
        property.kind !== "init" ||
        property.method === true ||
        property.shorthand === true ||
        property.computed === true
      ) {
        throw new LiteralSpecError(`${context} only permits ordinary literal properties.`);
      }
      const keyNode = asNode(property.key, `${context}.key`);
      const key =
        keyNode.type === "Identifier"
          ? keyNode.name
          : keyNode.type === "Literal"
            ? keyNode.value
            : undefined;
      if (typeof key !== "string" || key.length === 0) {
        throw new LiteralSpecError(`${context} has an invalid property key.`);
      }
      if (key in result) {
        throw new LiteralSpecError(`${context}.${key} is declared more than once.`);
      }
      result[key] = literalFromNode(
        asNode(property.value, `${context}.${key}`),
        `${context}.${key}`,
      );
    }
    return result;
  }

  throw new LiteralSpecError(
    `${context} must be a literal object, array, string, number, boolean, or null; found ${expression.type}.`,
  );
};

export const parseEntityLiterals = (source: string, filename = SPEC_PATH): EntityLiteral[] => {
  const parsed = parseSync(filename, source, { lang: "ts", range: true });
  const firstError = parsed.errors.at(0);
  if (firstError !== undefined) {
    throw new LiteralSpecError(`${filename}: ${firstError.message}`);
  }

  const declarations = (parsed.program.body as unknown[]).flatMap((statement) => {
    const node = asNode(statement, filename);
    if (node.type !== "ExportNamedDeclaration") {
      return [];
    }
    const declaration = node.declaration;
    if (!isNode(declaration) || declaration.type !== "VariableDeclaration") {
      return [];
    }
    const declarators = declaration.declarations;
    return Array.isArray(declarators) ? declarators : [];
  });
  const matching = declarations.filter((declaration) => {
    if (!isNode(declaration) || declaration.type !== "VariableDeclarator") {
      return false;
    }
    const identifier = declaration.id;
    return isNode(identifier) && identifier.type === "Identifier" && identifier.name === "ENTITY_LITERALS";
  });

  if (matching.length !== 1) {
    throw new LiteralSpecError(
      `${filename} must export exactly one const named ENTITY_LITERALS.`,
    );
  }
  const declaration = asNode(matching[0], filename);
  const initialValue = declaration.init;
  if (!isNode(initialValue)) {
    throw new LiteralSpecError(`${filename}: ENTITY_LITERALS must have an initializer.`);
  }
  const literal = literalFromNode(initialValue, "ENTITY_LITERALS");
  if (!Array.isArray(literal)) {
    throw new LiteralSpecError("ENTITY_LITERALS must be an array.");
  }

  const entities = literal.map(compileEntity);
  if (entities.length === 0) {
    throw new LiteralSpecError("ENTITY_LITERALS must not be empty.");
  }
  const keys = new Set<string>();
  for (const [index, entity] of entities.entries()) {
    if (keys.has(entity.key)) {
      throw new LiteralSpecError(`ENTITY_LITERALS[${index}].key duplicates ${entity.key}.`);
    }
    keys.add(entity.key);
  }
  return entities;
};

const parseEntityLiteralFile = (source: string, filename: string): EntityLiteral => {
  const parsed = parseSync(filename, source, { lang: "ts", range: true });
  const firstError = parsed.errors.at(0);
  if (firstError !== undefined) throw new LiteralSpecError(`${filename}: ${firstError.message}`);
  const declaration = (parsed.program.body as unknown[]).find((statement) => {
    const node = asNode(statement, filename);
    return node.type === "ExportDefaultDeclaration";
  });
  if (!declaration) throw new LiteralSpecError(`${filename} must default-export literalEntity({...}).`);
  const expression = unwrapTypeAssertion(asNode(declaration, filename).declaration as AstNode);
  if (expression.type !== "CallExpression") throw new LiteralSpecError(`${filename} must call literalEntity({...}).`);
  const callee = asNode(expression.callee, `${filename}.callee`);
  const arguments_ = expression.arguments;
  if (
    callee.type !== "Identifier" ||
    callee.name !== "literalEntity" ||
    !Array.isArray(arguments_) ||
    arguments_.length !== 1
  ) {
    throw new LiteralSpecError(`${filename} must default-export literalEntity({...}).`);
  }
  return compileEntity(
    literalFromNode(asNode(arguments_[0], `${filename}.argument`), "literalEntity"),
    0,
  );
};

export const parseEntityLiteralFiles = async (): Promise<EntityLiteral[]> => {
  const entries = (await readdir(SPEC_DIRECTORY, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".entity.ts"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0) throw new LiteralSpecError(`${SPEC_DIRECTORY} has no *.entity.ts files.`);
  const entities = await Promise.all(
    entries.map(async (entry) =>
      parseEntityLiteralFile(
        await readFile(resolve(SPEC_DIRECTORY, entry.name), "utf8"),
        resolve(SPEC_DIRECTORY, entry.name),
      ),
    ),
  );
  const keys = new Set<string>();
  const routes = new Set<string>();
  for (const entity of entities) {
    if (keys.has(entity.key)) throw new LiteralSpecError(`Duplicate entity key ${entity.key}.`);
    keys.add(entity.key);
    if (entity.descriptor.browserRoutes === false) continue;
    for (const route of Object.values(browserRoutes(entity).routes)) {
      if (routes.has(route)) throw new LiteralSpecError(`Duplicate browser route ${route}.`);
      routes.add(route);
    }
  }
  return entities;
};

const generatedHeader =
  "// Generated by `pnpm entity:generate` from `scripts/entity-literals/entities/*.entity.ts`. Do not edit.\n\n";

const literal = (value: unknown, depth = 0): string => {
  const indent = "  ".repeat(depth);
  const nestedIndent = "  ".repeat(depth + 1);
  if (Array.isArray(value)) {
    return value.length === 0
      ? "[]"
      : `[\n${value.map((item) => `${nestedIndent}${literal(item, depth + 1)}`).join(",\n")}\n${indent}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    return entries.length === 0
      ? "{}"
      : `{\n${entries
          .map(([key, item]) => {
            const property = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
            return `${nestedIndent}${property}: ${literal(item, depth + 1)}`;
          })
          .join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
};

const compactLiteral = (value: unknown) =>
  JSON.stringify(value).replaceAll(
    /"([A-Za-z_$][\w$]*)":/g,
    (_, key: string) => `${key}:`,
  );

const browserRouteExtension: Readonly<
  Partial<Record<string, Readonly<{ basePath: string; detailParam?: string }>>>
> = {
  inventory: { basePath: "inventory" },
  "usda-food": { basePath: "usda", detailParam: "id" },
};

const browserBasePath = (entity: string): string =>
  browserRouteExtension[entity]?.basePath ??
  (() => {
    const singular = entity.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    return singular.endsWith("y")
      ? `${singular.slice(0, -1)}ies`
      : /(?:s|x|z|ch|sh)$/.test(singular)
        ? `${singular}es`
        : `${singular}s`;
  })();

const browserRoutes = (entity: EntityLiteral) => {
  const basePath = entity.route?.basePath ?? browserBasePath(entity.key);
  const detailParam = entity.route?.detailParam ?? browserRouteExtension[entity.key]?.detailParam ?? "shortcode";
  return {
    basePath,
    routes: { detail: `/${basePath}/$${detailParam}`, list: `/${basePath}` },
  };
};

export const renderEntityArtifacts = (entities: readonly EntityLiteral[]): EntityArtifacts[] => {
  const imports = new Map<string, Set<string>>();
  for (const { contract } of entities) {
    if (contract === null) continue;
    for (const ref of [contract.create, contract.update, contract.output, contract.mcpOut]) {
      if (ref === null) continue;
      const exports = imports.get(ref.module) ?? new Set<string>();
      exports.add(ref.export);
      imports.set(ref.module, exports);
    }
  }
  const schemaImportEntries = [...imports.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const identifierImportIndex = schemaImportEntries.findIndex(
    ([module]) => module.localeCompare("@cubby/schemas/identifiers") > 0,
  );
  schemaImportEntries.splice(
    identifierImportIndex === -1
      ? schemaImportEntries.length
      : identifierImportIndex,
    0,
    ["@cubby/schemas/identifiers", new Set(["shortcodeSchema"])],
  );
  const schemaImports = schemaImportEntries
    .map(
      ([module, exports]) =>
        `import { ${[...exports].sort().join(", ")} } from ${JSON.stringify(module)};`,
    )
    .join("\n");
  const bindings = entities
    .filter((entity) => entity.shortcode !== null)
    .map((entity) => {
      if (entity.contract === null) return `  ${JSON.stringify(entity.key)}: { crud: null, mcpOut: null },`;
      const { create, update, output, mcpOut } = entity.contract;
      return `  ${JSON.stringify(entity.key)}: {crud:crud(${JSON.stringify(entity.key)},{createInput:${create.export},updateInput:${update.export},output:${output.export}}),mcpOut:${mcpOut?.export ?? "null"}},`;
    })
    .join("\n");
  const commandVariants = (
    action: "create" | "update",
    schema: "create" | "update",
  ) =>
    entities
      .filter((entity) => entity.contract !== null)
      .map((entity) => {
        const schemaRef = entity.contract?.[schema];
        if (!schemaRef) throw new LiteralSpecError(`${entity.key}.${schema} is missing.`);
        const id =
          action === "update"
            ? ",id:shortcodeSchema(" + JSON.stringify(entity.key) + ")"
            : "";
        return `z.object({action:z.literal(${JSON.stringify(action)}),entity:z.literal(${JSON.stringify(entity.key)})${id},data:${schemaRef.export}})`;
      })
      .join(",\n  ");
  const browserEntities = entities.filter(
    ({ descriptor }) => descriptor.browserRoutes !== false,
  );
  const browserCrudEntities = browserEntities
    .filter(({ contract }) => contract !== null)
    .map(({ key }) => key);
  const kernelEntities = entities
    .filter(({ contract, key }) => contract !== null || key === "image")
  const kernelEntityKeys = kernelEntities.map(({ key }) => key);
  const kernelContractCases = Object.fromEntries(
    kernelEntities.map((entity) => {
      const lifecycle = objectValue(
        required(entity.descriptor, "lifecycle", `${entity.key}.descriptor`),
        `${entity.key}.descriptor.lifecycle`,
      );
      const actions = [
        "get",
        "list",
        ...(entity.descriptor.searchable === true ? ["search"] : []),
        ...(entity.contract === null ? [] : ["create"]),
        "update",
        ...(lifecycle.delete === null ? [] : ["delete"]),
        ...(lifecycle.merge === true ? ["merge"] : []),
      ];
      return [
        entity.key,
        { actions, filterUrlKeys: entity.filterUrlKeys },
      ];
    }),
  );
  const entitiesForAction = (action: string) =>
    Object.entries(kernelContractCases)
      .filter(([, contractCase]) => contractCase.actions.includes(action))
      .map(([key]) => key);
  return [
    {
      relativePath: "packages/schemas/src/generated/entity-manifest-data.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "../entity";\n' +
        'import type { EntityDescriptor } from "../entity-manifest";\n\n' +
        "// biome-ignore format: generated data stays one entity per line.\n" +
        `export const generatedEntityManifest = ${compactLiteral(
          Object.fromEntries(entities.map(({ key, descriptor }) => [key, descriptor])),
        )} as const satisfies Record<Entity, EntityDescriptor>;\n`,
    },
    {
      relativePath: "apps/web/src/server/generated/entity-bindings.gen.ts",
      source:
        generatedHeader +
        'import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";\n' +
        `${schemaImports}\n` +
        'import { type ZodSchema, z } from "zod";\n\n' +
        "type CrudBinding = {\n" +
        "  idSchema: ZodSchema;\n" +
        "  createInput: ZodSchema;\n" +
        "  updateInput: ZodSchema;\n" +
        "  output: ZodSchema;\n" +
        "};\n\n" +
        "type EntityBinding = { crud: CrudBinding | null; mcpOut: ZodSchema | null };\n\n" +
        "const crud = <E extends ShortcodeEntity, S extends Omit<CrudBinding, \"idSchema\">>(\n" +
        "  entity: E,\n" +
        "  schemas: S,\n" +
        ") => ({ idSchema: shortcodeSchema(entity), ...schemas });\n\n" +
        "// biome-ignore format: generated bindings stay one entity per line.\n" +
        `export const ENTITY_BINDINGS = {\n${bindings}\n} satisfies Record<ShortcodeEntity, EntityBinding>;\n\n` +
        "// biome-ignore format: one generated variant per entity.\n" +
        `export const generatedEntityCreateCommandSchema = z.union([\n  ${commandVariants("create", "create")}\n]);\n\n` +
        "// biome-ignore format: one generated variant per entity.\n" +
        `export const generatedEntityUpdateCommandSchema = z.union([\n  ${commandVariants("update", "update")}\n]);\n`,
    },
    {
      relativePath: "apps/web/src/entities/generated/entity-routes.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "@cubby/schemas/entity";\n\n' +
        "// biome-ignore format: generated routes stay one entity per line.\n" +
        `export const generatedBrowserRoutes = ${compactLiteral(
          Object.fromEntries(browserEntities.map((entity) => [entity.key, browserRoutes(entity)])),
        )} as const satisfies Partial<Record<Entity, { basePath: string; routes: { detail: string; list: string } }>>;\n\n` +
        "// biome-ignore format: generated entity roster stays one line.\n" +
        `export const generatedBrowserCrudEntities = ${compactLiteral(browserCrudEntities)} as const;\n` +
        "export type GeneratedBrowserCrudEntity = (typeof generatedBrowserCrudEntities)[number];\n",
    },
    {
      relativePath: "apps/web/src/server/generated/entity-kernel-entities.gen.ts",
      source:
        generatedHeader +
        "// biome-ignore format: generated entity roster stays one line.\n" +
        `export const generatedEntityKernelEntities = ${compactLiteral(kernelEntityKeys)} as const;\n\n` +
        "// biome-ignore format: generated capabilities stay compact and reviewable.\n" +
        `export const generatedEntityKernelContractCases = ${compactLiteral(kernelContractCases)} as const;\n\n` +
        "// biome-ignore format: generated action rosters stay one line each.\n" +
        `export const generatedSearchEntityKernelEntities = ${compactLiteral(entitiesForAction("search"))} as const;\n` +
        `export const generatedMergeEntityKernelEntities = ${compactLiteral(entitiesForAction("merge"))} as const;\n`,
    },
  ];
};

export const renderFilterArtifact = (entities: readonly EntityLiteral[]): EntityArtifacts => {
  const roster = Object.fromEntries(
    entities.map(({ key, filterUrlKeys }) => [key, filterUrlKeys]),
  );
  return {
    relativePath: "apps/web/src/entities/filter-search-fields.gen.ts",
    source:
      generatedHeader +
      'import type { Entity } from "@cubby/schemas/entity";\n' +
      'import { urlStringParam } from "~/lib/search-params";\n\n' +
      "// biome-ignore format: generated data stays one entity per line.\n" +
      `const entityFilterUrlKeyRoster: Partial<Record<Entity, readonly string[]>> = ${compactLiteral(roster)};\n\n` +
      "/** The URL keys an entity accepts for its canonical filter assembly. */\n" +
      "export const entityFilterUrlKeys = (entity: Entity): readonly string[] =>\n" +
      "  entityFilterUrlKeyRoster[entity] ?? [];\n\n" +
      "export function entityFilterSearchFields(\n" +
      "  entity: Entity,\n" +
      "): Record<string, typeof urlStringParam> {\n" +
      "  const fields: Record<string, typeof urlStringParam> = {};\n" +
      "  for (const key of entityFilterUrlKeys(entity)) fields[key] = urlStringParam;\n" +
      "  return fields;\n" +
      "}\n",
  };
};

const formatSource = (root: string, artifact: EntityArtifacts): string => {
  const result = execFileSync(
    "pnpm",
    [
      "exec",
      "biome",
      "format",
      "--stdin-file-path",
      artifact.relativePath,
    ],
    { cwd: root, encoding: "utf8", input: artifact.source },
  );
  return result;
};

const generatedName = /^(?:entity-literal-.+|entity-manifest-data|entity-bindings|entity-routes|entity-kernel-entities|filter-search-fields)\.gen\.ts$/;

const findExtraArtifacts = async (root: string, artifacts: readonly EntityArtifacts[]) => {
  const expected = new Set(artifacts.map(({ relativePath }) => relativePath));
  const directories = new Set(artifacts.map(({ relativePath }) => dirname(relativePath)));
  const extras: string[] = [];
  for (const directory of directories) {
    const absoluteDirectory = resolve(root, directory);
    try {
      const entries = await readdir(absoluteDirectory, { withFileTypes: true });
      for (const entry of entries) {
        const relativePath = `${directory}/${entry.name}`;
        if (entry.isFile() && generatedName.test(entry.name) && !expected.has(relativePath)) {
          extras.push(relativePath);
        }
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return extras.sort();
};

export const checkEntityArtifacts = async (
  root: string,
  artifacts: readonly EntityArtifacts[],
) => {
  const problems: string[] = [];
  for (const artifact of artifacts) {
    const artifactPath = resolve(root, artifact.relativePath);
    try {
      const current = await readFile(artifactPath, "utf8");
      if (current !== artifact.source) {
        problems.push(`stale: ${artifact.relativePath}`);
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        problems.push(`missing: ${artifact.relativePath}`);
        continue;
      }
      throw error;
    }
  }
  for (const extra of await findExtraArtifacts(root, artifacts)) {
    problems.push(`extraneous: ${extra}`);
  }
  return problems;
};

const writeEntityArtifacts = async (root: string, artifacts: readonly EntityArtifacts[]) => {
  const problems = await checkEntityArtifacts(root, artifacts);
  const extras = problems.filter((problem) => problem.startsWith("extraneous:"));
  if (extras.length > 0) {
    throw new LiteralSpecError(`Refusing to overwrite with ${extras.join(", ")}.`);
  }
  for (const artifact of artifacts) {
    const artifactPath = resolve(root, artifact.relativePath);
    await stat(dirname(artifactPath)).catch(async (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        await mkdir(dirname(artifactPath), { recursive: true });
        return;
      }
      throw error;
    });
    await writeFile(artifactPath, artifact.source);
  }
};

const generateEntityArtifacts = async (
  root = ROOT,
  source?: string,
) => {
  const entities = source === undefined ? await parseEntityLiteralFiles() : parseEntityLiterals(source, SPEC_PATH);
  const artifacts = [...renderEntityArtifacts(entities), renderFilterArtifact(entities)].map((artifact) => ({
    ...artifact,
    source: formatSource(root, artifact),
  }));
  return { entities, artifacts };
};

const main = async () => {
  const check = process.argv.slice(2).includes("--check");
  const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--check");
  if (unknownArguments.length > 0) {
    throw new LiteralSpecError(`Unknown arguments: ${unknownArguments.join(", ")}.`);
  }
  const { artifacts } = await generateEntityArtifacts();
  if (check) {
    const problems = await checkEntityArtifacts(ROOT, artifacts);
    if (problems.length > 0) {
      throw new LiteralSpecError(`Generated entity artifacts are out of date:\n${problems.join("\n")}`);
    }
    return;
  }
  await writeEntityArtifacts(ROOT, artifacts);
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
