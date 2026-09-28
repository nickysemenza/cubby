import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { renderDerivedDdl } from "../src/server/db/derived-ddl";
import { MIGRATIONS_FOLDER } from "./db-migrate";

/** Hash of the derived DDL the committed migrations already carry. */
export const DERIVED_LOCK = join(MIGRATIONS_FOLDER, "derived.lock");

export const derivedDdlHash = (ddl: string = renderDerivedDdl()): string =>
  createHash("sha256").update(ddl).digest("hex");

export const readDerivedLock = (): string | undefined =>
  existsSync(DERIVED_LOCK)
    ? readFileSync(DERIVED_LOCK, "utf8").trim()
    : undefined;
