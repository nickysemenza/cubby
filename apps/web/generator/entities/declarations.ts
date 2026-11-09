import { compileEntityDeclarations } from "./compile.ts";
import { modulesChildren } from "@cubby/schemas/compiler/child-tables/modules";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { validatePredicateBaseline } from "./predicate-baseline.ts";
import { EntityDeclarationError, SPEC_DIRECTORY } from "./source.ts";
import {
  declarationModules,
  objectValue,
  type CompiledEntity,
  type DeclarationObject,
} from "./declaration-types.ts";
export * from "./declaration-types.ts";

export const compileLoadedEntityDeclarations = (
  loaded: readonly DeclarationObject[],
): CompiledEntity[] => {
  return compileEntityDeclarations(loaded, modulesChildren);
};

export const loadEntityDeclarationBundle = async (): Promise<{
  entities: CompiledEntity[];
  declarations: DeclarationObject[];
}> => {
  const entries = (await readdir(SPEC_DIRECTORY, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".entity.ts"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0)
    throw new EntityDeclarationError(
      `${SPEC_DIRECTORY} has no entity declarations.`,
    );
  const loaded = await Promise.all(
    entries.map(async (entry) => {
      const module = await import(
        pathToFileURL(resolve(SPEC_DIRECTORY, entry.name)).href
      );
      const raw = objectValue(module.default, entry.name);
      // Filter schemas are generated from descriptors (`deriveSchema`); a
      // hand-written map would silently shadow them.
      if (module.filterSchemas !== undefined || "filterSchemas" in raw)
        throw new EntityDeclarationError(
          `${entry.name} exports filterSchemas; declare filters as descriptors with deriveSchema instead.`,
        );
      declarationModules.set(String(raw.key), {
        path: `../entity-definitions/${entry.name.replace(/\.ts$/, "")}`,
        readSchemas: z
          .object({
            output: z.instanceof(z.ZodObject),
            list: z.instanceof(z.ZodObject),
            detail: z.instanceof(z.ZodObject),
          })
          .parse(raw.readSchemas),
        enumExports: Object.keys(module).filter((key) =>
          key.startsWith("generated"),
        ),
      });
      return raw;
    }),
  );
  const entities = compileLoadedEntityDeclarations(loaded);
  validatePredicateBaseline(entities);
  return { entities, declarations: loaded };
};

export const loadEntityDeclarations = async (): Promise<CompiledEntity[]> =>
  (await loadEntityDeclarationBundle()).entities;
