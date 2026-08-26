import { readFileSync } from "node:fs";
import path from "node:path";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";

const WRANGLER_CONFIG_PATH = path.resolve(
  import.meta.dirname,
  "../wrangler.jsonc",
);

type WranglerConfig = {
  vars?: Record<string, unknown>;
};

/** Read the canonical public R2 origin used by both the Worker and client build. */
export const readR2PublicUrlFromWrangler = (): string => {
  const errors: ParseError[] = [];
  const config = parse(
    readFileSync(WRANGLER_CONFIG_PATH, "utf8"),
    errors,
  ) as WranglerConfig;
  const error = errors[0];
  if (error) {
    throw new Error(
      `Invalid wrangler.jsonc: ${printParseErrorCode(error.error)} at offset ${error.offset}`,
    );
  }

  const value = config.vars?.R2_PUBLIC_URL;
  if (typeof value !== "string") {
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
