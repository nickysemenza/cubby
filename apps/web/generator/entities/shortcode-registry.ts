import { rawSource } from "../artifacts.ts";
import { capitalize } from "@cubby/shared/text-case";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseSync, type Expression, type ObjectExpression } from "oxc-parser";
import { z } from "zod";
import { generatedHeader } from "../artifacts.ts";
import { EntityDeclarationError, SPEC_DIRECTORY } from "./source.ts";
import type { EntityArtifacts } from "../artifacts.ts";
import { renderRecord } from "./render/record.ts";

const property = (object: ObjectExpression, name: string) =>
  object.properties.find(
    (candidate) =>
      candidate.type === "Property" &&
      candidate.key.type === "Identifier" &&
      candidate.key.name === name,
  );

const literal = (value: Expression | undefined, where: string) => {
  const parsed = z
    .string()
    .nullable()
    .safeParse(value?.type === "Literal" ? value.value : undefined);
  if (!parsed.success)
    throw new EntityDeclarationError(
      `${where} must be a string or null literal.`,
    );
  return parsed.data;
};

const valueOf = (object: ObjectExpression, name: string) => {
  const found = property(object, name);
  // SAFETY: an object literal's non-shorthand property value is an expression;
  // `literal` and the ObjectExpression checks below reject any other shape.
  return found?.type === "Property" ? (found.value as Expression) : undefined;
};

/**
 * The shortcode registry is read from the declarations' source instead of
 * their evaluated modules: every declaration imports `@cubby/shared`, whose
 * shortcode schemas are built from this registry, so it must exist before the
 * first declaration can load (a fresh checkout has no generated files).
 */
export const renderShortcodeRegistryArtifacts = async (): Promise<
  readonly EntityArtifacts[]
> => {
  const files = (await readdir(SPEC_DIRECTORY))
    .filter((name) => name.endsWith(".entity.ts"))
    .sort((left, right) => left.localeCompare(right));
  const entityKeys: string[] = [];
  const prefixes: Record<string, string> = {};
  const lengths: Record<string, number> = {};
  for (const name of files) {
    const path = resolve(SPEC_DIRECTORY, name);
    const program = parseSync(path, await readFile(path, "utf8")).program;
    const exported = program.body.find(
      (statement) => statement.type === "ExportDefaultDeclaration",
    );
    const call =
      exported?.type === "ExportDefaultDeclaration"
        ? exported.declaration
        : undefined;
    const argument =
      call?.type === "CallExpression" ? call.arguments[0] : undefined;
    let declaration =
      argument?.type === "ObjectExpression" ? argument : undefined;
    if (argument?.type === "Identifier" && argument.name === "definition") {
      for (const statement of program.body) {
        if (
          statement.type !== "ExportNamedDeclaration" ||
          statement.declaration?.type !== "VariableDeclaration"
        )
          continue;
        for (const binding of statement.declaration.declarations) {
          const pattern = binding.id;
          if (
            pattern.type !== "ObjectPattern" ||
            !["definition", "readSchemas"].every((name) =>
              pattern.properties.some(
                (property) =>
                  property.type === "Property" &&
                  property.value.type === "Identifier" &&
                  property.value.name === name,
              ),
            ) ||
            binding.init?.type !== "CallExpression" ||
            binding.init.callee.type !== "Identifier" ||
            binding.init.callee.name !== "defineEntityModel"
          )
            continue;
          const body = binding.init.arguments[0];
          if (body?.type === "ObjectExpression") declaration = body;
        }
      }
    }
    if (!declaration)
      throw new EntityDeclarationError(
        `${name} must export default defineEntity(definition, …) with an exported literal defineEntityModel body.`,
      );
    const key = literal(valueOf(declaration, "key"), `${name} key`);
    const identifiers = valueOf(declaration, "identifiers");
    if (identifiers?.type !== "ObjectExpression" || key === null)
      throw new EntityDeclarationError(
        `${name} must declare key and identifiers literally.`,
      );
    entityKeys.push(key);
    const shortcode = literal(
      valueOf(identifiers, "shortcode"),
      `${name} identifiers.shortcode`,
    );
    if (shortcode !== null) prefixes[key] = shortcode;
    const length = valueOf(identifiers, "shortcodeLength");
    if (length !== undefined) {
      lengths[key] = z
        .int()
        .min(5)
        .max(32)
        .parse(length.type === "Literal" ? length.value : undefined);
    }
  }
  // The stable per-entity import surface (`productShortcode` /
  // `ProductShortcode`, >150 sites): each is the schema-map entry, never a
  // second `makeShortcodeSchema` call.
  const named = Object.keys(prefixes)
    .map(
      (type) =>
        `export const ${type}Shortcode = SHORTCODE_SCHEMA.${type};\n` +
        `export type ${capitalize(type)}Shortcode = ShortcodeFor<"${type}">;\n`,
    )
    .join("");
  return [
    {
      relativePath:
        "packages/schemas/src/entity-definitions/definition-catalog.gen.ts",
      source: rawSource(
        generatedHeader +
          files
            .map(
              (file, index) =>
                `import type { definition as Definition${index} } from ${JSON.stringify(`./${file.slice(0, -3)}`)};`,
            )
            .join("\n") +
          `\nexport type EntityDefinitions = ${files.map((_, index) => `typeof Definition${index}`).join(" | ")};\n`,
      ),
    },
    {
      relativePath: "packages/shared/src/generated/shortcode-registry.gen.ts",
      source: rawSource(
        generatedHeader +
          renderRecord({ name: "ENTITY_KEYS", entries: entityKeys }) +
          renderRecord({
            name: "SHORTCODE_PREFIX",
            entries: prefixes,
            comment:
              "// Generated shortcode registry stays one entity per line.",
          }) +
          "export type ShortcodeType = keyof typeof SHORTCODE_PREFIX;\n" +
          `export const SHORTCODE_LENGTH: Partial<Record<ShortcodeType, number>> = ${JSON.stringify(lengths)};\n`,
      ),
    },
    {
      relativePath: "packages/shared/src/generated/shortcode-named.gen.ts",
      source: rawSource(
        generatedHeader +
          'import { SHORTCODE_SCHEMA, type ShortcodeFor } from "../shortcode-schema";\n\n' +
          named,
      ),
    },
  ];
};
