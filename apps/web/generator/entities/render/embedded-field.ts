import { z } from "zod";

import { EntityDeclarationError } from "../declarations.ts";

type EmbeddedRender = { code: string; matches: number; usesZod: boolean };

/** Inspect declaration schemas at generation time; emitted projections stay concrete. */
export function renderEmbeddedField(
  schema: z.ZodType,
  expression: string,
  path: readonly string[],
  target: string,
): Pick<EmbeddedRender, "code" | "usesZod"> {
  const visit = (
    current: z.core.$ZodType,
    source: string,
    remaining: readonly string[],
  ): EmbeddedRender => {
    if (current instanceof z.ZodLazy)
      return visit(current.unwrap(), `${source}.unwrap()`, remaining);
    if (current instanceof z.ZodNullable || current instanceof z.ZodOptional) {
      const result = visit(current.unwrap(), `${source}.unwrap()`, remaining);
      return result.matches
        ? {
            code: `${result.code}.${current instanceof z.ZodNullable ? "nullable" : "optional"}()`,
            matches: result.matches,
            usesZod: result.usesZod,
          }
        : { code: source, matches: 0, usesZod: false };
    }
    if (current instanceof z.ZodArray) {
      const result = visit(current.element, `${source}.element`, remaining);
      return result.matches
        ? {
            code: `z.array(${result.code})`,
            matches: result.matches,
            usesZod: true,
          }
        : { code: source, matches: 0, usesZod: false };
    }
    if (current instanceof z.ZodDiscriminatedUnion) {
      const results = current.options.map((option, index) =>
        visit(option, `${source}.options[${index}]`, remaining),
      );
      const matches = results.reduce((sum, result) => sum + result.matches, 0);
      return matches
        ? {
            code: `z.discriminatedUnion(${JSON.stringify(current.def.discriminator)}, [${results.map((result) => result.code).join(",")}])`,
            matches,
            usesZod: true,
          }
        : { code: source, matches: 0, usesZod: false };
    }
    if (!(current instanceof z.ZodObject))
      return { code: source, matches: 0, usesZod: false };
    const [key, ...rest] = remaining;
    if (key === undefined)
      return {
        code: `withFieldEnvelopes(${source}, ${target}FieldEnvelopeFields, ${target}PublicReadFields)`,
        matches: 1,
        usesZod: false,
      };
    const child = current.shape[key];
    if (!child) return { code: source, matches: 0, usesZod: false };
    const result = visit(
      child,
      `${source}.shape[${JSON.stringify(key)}]`,
      rest,
    );
    return result.matches
      ? {
          code: `${source}.extend({${JSON.stringify(key)}:${result.code}})`,
          matches: result.matches,
          usesZod: result.usesZod,
        }
      : { code: source, matches: 0, usesZod: false };
  };
  const result = visit(schema, expression, path);
  if (!result.matches)
    throw new EntityDeclarationError(
      `Embedded field path ${path.join(".")} has no object projection in ${expression}.`,
    );
  return { code: result.code, usesZod: result.usesZod };
}
