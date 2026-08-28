import { readFileSync } from "node:fs";
import path from "node:path";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";
import { z } from "zod";

const WRANGLER_CONFIG_PATH = path.resolve(
  import.meta.dirname,
  "../wrangler.jsonc",
);

const wranglerConfigSchema = z.object({
  vars: z
    .object({
      R2_PUBLIC_URL: z.string(),
    })
    .optional(),
});

/** Read the canonical public R2 origin used by both the Worker and client build. */
export const readR2PublicUrlFromWrangler = (): string => {
  const errors: ParseError[] = [];
  const rawConfig = parse(readFileSync(WRANGLER_CONFIG_PATH, "utf8"), errors);
  const error = errors[0];
  if (error) {
    throw new Error(
      `Invalid wrangler.jsonc: ${printParseErrorCode(error.error)} at offset ${error.offset}`,
    );
  }
  const config = wranglerConfigSchema.parse(rawConfig);

  const value = config.vars?.R2_PUBLIC_URL;
  if (value === undefined) {
    throw new Error("wrangler.jsonc vars.R2_PUBLIC_URL must be a string");
  }

  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "wrangler.jsonc vars.R2_PUBLIC_URL must be an HTTPS origin without a path, query, or hash",
    );
  }
  return parsed.origin;
};
