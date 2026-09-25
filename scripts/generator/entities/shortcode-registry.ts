import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseSync, type Expression, type ObjectExpression } from "oxc-parser";
import { z } from "zod";
import { generatedHeader } from "../artifacts.ts";
import {
  EntityDeclarationError,
  SPEC_DIRECTORY,
  type EntityArtifacts,
} from "./declarations.ts";
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
export const renderShortcodeRegistryArtifact =
  async (): Promise<EntityArtifacts> => {
    const files = (await readdir(SPEC_DIRECTORY))
      .filter((name) => name.endsWith(".entity.ts"))
      .sort((left, right) => left.localeCompare(right));
    const prefixes: Record<string, string> = {};
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
      const declaration =
        call?.type === "CallExpression" ? call.arguments[0] : undefined;
      if (declaration?.type !== "ObjectExpression")
        throw new EntityDeclarationError(
          `${name} must export default defineEntity({...}).`,
        );
      const key = literal(valueOf(declaration, "key"), `${name} key`);
      const identifiers = valueOf(declaration, "identifiers");
      if (identifiers?.type !== "ObjectExpression" || key === null)
        throw new EntityDeclarationError(
          `${name} must declare key and identifiers literally.`,
        );
      const shortcode = literal(
        valueOf(identifiers, "shortcode"),
        `${name} identifiers.shortcode`,
      );
      if (shortcode !== null) prefixes[key] = shortcode;
    }
    return {
      relativePath: "packages/shared/src/generated/shortcode-registry.gen.ts",
      source:
        generatedHeader +
        renderRecord({
          name: "SHORTCODE_PREFIX",
          entries: prefixes,
          comment: "// Generated shortcode registry stays one entity per line.",
        }) +
        "export type ShortcodeType = keyof typeof SHORTCODE_PREFIX;\n",
    };
  };
