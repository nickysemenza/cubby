import { z } from "zod";
import type { ListFoodsArgs } from "../contract";
import {
  dataTypeEnum,
  type FoodLookupParam,
  type FoodSummary,
  type FoodSummaryMcpOut,
} from "../schemas";
import { toFtsFallbackQuery, toFtsQuery } from "./fts-query";
import {
  dataTypePredicate,
  dataTypePriorityCase,
  matchQualityBindings,
  matchQualityCase,
  sqlDirection,
  sqlOrderBy,
} from "./search-sql";
import {
  releaseManifest,
  releaseShardLine,
  shardKey,
  usdaBarcodeKey,
  type ReleaseId,
  type ReleaseManifest,
} from "./shard";

// Bump when the table layout below changes. A new generation is a new Durable
// Object name, so the release reloads from its R2 shards instead of migrating
// derived data in place (ADR 0008).
export const USDA_RELEASE_GENERATION = 1;

export const usdaReleaseObjectName = (release: ReleaseId) =>
  `${release}.g${USDA_RELEASE_GENERATION}`;

export const releaseFromObjectName = (name: string): ReleaseId => {
  const match = /^(\d{4}-\d{2})\.g(\d+)$/u.exec(name);
  if (!match?.[1] || Number(match[2]) !== USDA_RELEASE_GENERATION) {
    throw new Error(
      `USDA release object name ${JSON.stringify(name)} is not <YYYY-MM>.g${USDA_RELEASE_GENERATION}`,
    );
  }
  return match[1];
};

type SqlValue = ArrayBuffer | string | number | null;

/** The slice of Durable Object SQLite storage the store uses. */
export interface ReleaseSql {
  exec(
    query: string,
    ...bindings: SqlValue[]
  ): { toArray(): Record<string, SqlValue>[] };
  readonly databaseSize: number;
}

export const releaseStatus = z.object({
  release: z.string(),
  state: z.enum(["loading", "ready", "failed"]),
  shardsLoaded: z.number().int(),
  shardCount: z.number().int().nullable(),
  error: z.string().nullable(),
  databaseBytes: z.number(),
  startedAt: z.string(),
  readyAt: z.string().nullable(),
});
export type ReleaseStatus = z.infer<typeof releaseStatus>;

export const releaseCounts = releaseManifest.pick({
  release: true,
  foodsByDataType: true,
  supersededCount: true,
});
export type ReleaseCounts = z.infer<typeof releaseCounts>;

/** A text-search result: the food without its full nutrient table. */
export type FoodSearchRow = FoodSummaryMcpOut;
export type FoodSearchPage = { data: FoodSearchRow[]; count: number };

// A shard that fails this many times in a row fails the release, so a missing
// object or a persistent R2 error surfaces instead of loading forever.
export const MAX_SHARD_ATTEMPTS = 3;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS release_state (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     release TEXT NOT NULL,
     state TEXT NOT NULL,
     manifest TEXT,
     next_shard INTEGER NOT NULL DEFAULT 0,
     attempts INTEGER NOT NULL DEFAULT 0,
     error TEXT,
     started_at TEXT NOT NULL,
     ready_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS food (
     fdc_id INTEGER PRIMARY KEY,
     data_type TEXT NOT NULL,
     description TEXT NOT NULL,
     barcode_key TEXT,
     ndb_number INTEGER,
     summary TEXT NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS food_barcode_key ON food (barcode_key)",
  "CREATE INDEX IF NOT EXISTS food_ndb_number ON food (ndb_number)",
  "CREATE INDEX IF NOT EXISTS food_description ON food (description)",
  "CREATE INDEX IF NOT EXISTS food_data_type ON food (data_type, description)",
  `CREATE TABLE IF NOT EXISTS food_alias (
     fdc_id INTEGER PRIMARY KEY,
     current_fdc_id INTEGER NOT NULL
   ) WITHOUT ROWID`,
];

// Contentless: the text lives in `food`; this table only maps terms to
// rowid = fdc_id. Brand columns weigh less than the description. The rank
// setting persists, so it is written once, with the table.
const SEARCH_SCHEMA = [
  `CREATE VIRTUAL TABLE food_search USING fts5(
     description, brand_name, brand_owner,
     content = '', tokenize = 'unicode61 remove_diacritics 1'
   )`,
  "INSERT INTO food_search (food_search, rank) VALUES ('rank', 'bm25(1.0, 0.3, 0.3)')",
];

const stateRow = z.object({
  release: z.string(),
  state: releaseStatus.shape.state,
  manifest: z.string().nullable(),
  next_shard: z.number(),
  attempts: z.number(),
  error: z.string().nullable(),
  started_at: z.string(),
  ready_at: z.string().nullable(),
});
type StateRow = z.infer<typeof stateRow>;

const summaryRow = z.object({ fdc_id: z.number(), summary: z.string() });
const countRow = z.object({ count: z.number() });

const MAX_SQL_VARIABLES = 100;

export class ShardLoadError extends Error {}

function parseSummary(text: string): FoodSummary {
  // SAFETY: every stored summary passed `releaseShardLine` when its shard was
  // loaded into this same object; re-validating each read costs the hot path.
  return JSON.parse(text) as FoodSummary;
}

function toSearchRow(food: FoodSummary): FoodSearchRow {
  const { nutrientSummary: _dropped, ...nutritionInfo } = food.nutritionInfo;
  return { ...food, nutritionInfo };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

export class UsdaReleaseStore {
  constructor(
    private readonly sql: ReleaseSql,
    private readonly transaction: <T>(fn: () => T) => T,
  ) {}

  init() {
    for (const statement of SCHEMA) this.sql.exec(statement);
    const [search] = this.sql
      .exec("SELECT 1 AS present FROM sqlite_master WHERE name = 'food_search'")
      .toArray();
    if (!search)
      for (const statement of SEARCH_SCHEMA) this.sql.exec(statement);
  }

  private stateRow(): StateRow | null {
    const [row] = this.sql.exec("SELECT * FROM release_state").toArray();
    return row ? stateRow.parse(row) : null;
  }

  private manifest(row: StateRow): ReleaseManifest | null {
    return row.manifest
      ? releaseManifest.parse(JSON.parse(row.manifest))
      : null;
  }

  hasStarted() {
    return this.stateRow() !== null;
  }

  /** Starts loading `manifest`'s shards from the first one. */
  begin(release: ReleaseId, manifest: ReleaseManifest) {
    if (manifest.release !== release) {
      throw new Error(
        `Manifest for ${manifest.release} found under release ${release}`,
      );
    }
    this.sql.exec(
      "INSERT INTO release_state (id, release, state, manifest, started_at) VALUES (1, ?, 'loading', ?, ?)",
      release,
      JSON.stringify(manifest),
      new Date().toISOString(),
    );
  }

  isLoading() {
    return this.stateRow()?.state === "loading";
  }

  status(): ReleaseStatus {
    const row = this.stateRow();
    if (!row) throw new Error("USDA release load has not started");
    return {
      release: row.release,
      state: row.state,
      shardsLoaded: row.next_shard,
      shardCount: this.manifest(row)?.shardCount ?? null,
      error: row.error,
      databaseBytes: this.sql.databaseSize,
      startedAt: row.started_at,
      readyAt: row.ready_at,
    };
  }

  /**
   * Claims an attempt at the next shard and returns its R2 key, or null when
   * nothing is pending. The attempt is counted before any work, so an
   * invocation the platform kills mid-shard still uses one up; a shard whose
   * attempts are spent fails the release here.
   */
  beginShardAttempt(): string | null {
    const row = this.stateRow();
    if (row?.state !== "loading") return null;
    const key = shardKey(row.release, row.next_shard);
    if (row.attempts >= MAX_SHARD_ATTEMPTS) {
      this.sql.exec(
        "UPDATE release_state SET state = 'failed', error = ? WHERE id = 1",
        `${key} did not load after ${row.attempts} attempts${row.error ? `; last error: ${row.error}` : ""}`,
      );
      return null;
    }
    this.sql.exec(
      "UPDATE release_state SET attempts = attempts + 1 WHERE id = 1",
    );
    return key;
  }

  /** Returns a failed load to loading from its last committed shard. */
  resume() {
    this.sql.exec(
      "UPDATE release_state SET state = 'loading', attempts = 0, error = NULL WHERE id = 1 AND state = 'failed'",
    );
  }

  /**
   * Loads one shard and advances progress in a single transaction, so an
   * eviction between shards neither repeats nor skips one.
   */
  applyShard(key: string, text: string) {
    this.transaction(() => {
      const row = this.stateRow();
      if (
        row?.state !== "loading" ||
        shardKey(row.release, row.next_shard) !== key
      )
        return;
      const lines = text.split("\n");
      for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = releaseShardLine.parse(JSON.parse(line));
        } catch (error) {
          throw new ShardLoadError(
            `${key} line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        this.insert(parsed.food, parsed.supersededFdcIds);
      }
      const manifest = this.manifest(row);
      const next = row.next_shard + 1;
      const done = manifest !== null && next >= manifest.shardCount;
      this.sql.exec(
        "UPDATE release_state SET next_shard = ?, attempts = 0, error = NULL, state = ?, ready_at = ? WHERE id = 1",
        next,
        done ? "ready" : "loading",
        done ? new Date().toISOString() : null,
      );
    });
  }

  /**
   * Counts a failed shard attempt; returns whether the load should retry. A
   * `permanent` failure (an invalid line) fails the release at once.
   */
  recordShardFailure(failure: {
    message: string;
    permanent: boolean;
  }): boolean {
    const row = this.stateRow();
    if (!row) return false;
    const failed = failure.permanent || row.attempts >= MAX_SHARD_ATTEMPTS;
    this.sql.exec(
      "UPDATE release_state SET error = ?, state = ? WHERE id = 1",
      failure.message,
      failed ? "failed" : "loading",
    );
    return !failed;
  }

  private insert(food: FoodSummary, superseded: number[]) {
    const branded = food.brandedFoodInfo;
    this.sql.exec(
      "INSERT OR REPLACE INTO food (fdc_id, data_type, description, barcode_key, ndb_number, summary) VALUES (?, ?, ?, ?, ?, ?)",
      food.fdc_id,
      food.foodInfo.data_type,
      food.foodInfo.description,
      branded ? usdaBarcodeKey(branded.gtin_upc) : null,
      food.legacyFoodInfo?.ndb_number ?? null,
      JSON.stringify(food),
    );
    this.sql.exec(
      "INSERT INTO food_search (rowid, description, brand_name, brand_owner) VALUES (?, ?, ?, ?)",
      food.fdc_id,
      food.foodInfo.description,
      branded?.brand_name ?? "",
      branded?.brand_owner ?? "",
    );
    for (const old of superseded) {
      this.sql.exec(
        "INSERT OR REPLACE INTO food_alias (fdc_id, current_fdc_id) VALUES (?, ?)",
        old,
        food.fdc_id,
      );
    }
  }

  /** Throws the raw load state unless the release is ready to serve. */
  assertReady() {
    const status = this.status();
    if (status.state === "ready") return;
    const progress = `${status.shardsLoaded}/${status.shardCount ?? "?"} shards`;
    throw new Error(
      status.state === "failed"
        ? `USDA release ${status.release} failed to load after ${progress}: ${status.error}`
        : `USDA release ${status.release} is loading: ${progress}${status.error ? ` (retrying after: ${status.error})` : ""}`,
    );
  }

  counts(): ReleaseCounts {
    this.assertReady();
    const row = this.stateRow();
    const manifest = row && this.manifest(row);
    if (!manifest) throw new Error("USDA release is ready without a manifest");
    return releaseCounts.parse(manifest);
  }

  private summariesByColumn(
    column: "fdc_id" | "barcode_key" | "ndb_number",
    values: Array<string | number>,
  ): Map<string | number, FoodSummary> {
    const out = new Map<string | number, FoodSummary>();
    for (const chunk of chunks([...new Set(values)], MAX_SQL_VARIABLES)) {
      // `fdc_id DESC` with first-wins keeps the newest record when a barcode or
      // NDB number is shared by several current foods.
      const rows = this.sql
        .exec(
          `SELECT ${column} AS key, fdc_id, summary FROM food WHERE ${column} IN (${chunk.map(() => "?").join(", ")}) ORDER BY fdc_id DESC`,
          ...chunk,
        )
        .toArray();
      for (const row of rows) {
        const { summary } = summaryRow.parse(row);
        const key = z.union([z.string(), z.number()]).parse(row.key);
        if (!out.has(key)) out.set(key, parseSummary(summary));
      }
    }
    return out;
  }

  private currentIds(ids: number[]): Map<number, number> {
    const out = new Map<number, number>();
    for (const chunk of chunks([...new Set(ids)], MAX_SQL_VARIABLES)) {
      const rows = this.sql
        .exec(
          `SELECT fdc_id, current_fdc_id FROM food_alias WHERE fdc_id IN (${chunk.map(() => "?").join(", ")})`,
          ...chunk,
        )
        .toArray();
      for (const row of rows) {
        const alias = z
          .object({ fdc_id: z.number(), current_fdc_id: z.number() })
          .parse(row);
        out.set(alias.fdc_id, alias.current_fdc_id);
      }
    }
    return out;
  }

  lookupBatch(lookups: FoodLookupParam[]): Array<FoodSummary | null> {
    this.assertReady();
    const fdcIds = lookups.flatMap((l) => (l.kind === "fdc" ? [l.fdc_id] : []));
    const aliases = this.currentIds(fdcIds);
    const resolvedId = (id: number) => aliases.get(id) ?? id;
    const byId = this.summariesByColumn("fdc_id", fdcIds.map(resolvedId));
    const byBarcode = this.summariesByColumn(
      "barcode_key",
      lookups.flatMap((l) => {
        const key = l.kind === "upc" ? usdaBarcodeKey(l.gtin_upc) : null;
        return key ? [key] : [];
      }),
    );
    const byNdb = this.summariesByColumn(
      "ndb_number",
      lookups.flatMap((l) => (l.kind === "ndb" ? [l.ndb_number] : [])),
    );
    return lookups.map((lookup) => {
      if (lookup.kind === "fdc")
        return byId.get(resolvedId(lookup.fdc_id)) ?? null;
      if (lookup.kind === "ndb") return byNdb.get(lookup.ndb_number) ?? null;
      const key = usdaBarcodeKey(lookup.gtin_upc);
      return (key && byBarcode.get(key)) || null;
    });
  }

  getFood(fdcId: number): FoodSummary | null {
    return this.lookupBatch([{ kind: "fdc", fdc_id: fdcId }])[0] ?? null;
  }

  search(args: ListFoodsArgs): FoodSearchPage {
    this.assertReady();
    const andQuery = toFtsQuery(args.nameFilter ?? "");
    let page = this.searchPage(args, andQuery);
    // The fallback decision is the AND *count*, not the page: an empty page
    // past the end of a non-empty result is paging, not a miss.
    if (andQuery && page.count === 0) {
      const fallback = toFtsFallbackQuery(args.nameFilter ?? "");
      if (fallback) page = this.searchPage(args, fallback);
    }
    return page;
  }

  private searchPage(args: ListFoodsArgs, ftsQuery: string): FoodSearchPage {
    const types = dataTypePredicate(
      "f.data_type",
      args.dataTypeFilter,
      args.foodsOnly,
      args.dataTypes,
    );
    for (const value of types.values) dataTypeEnum.parse(value);
    const conditions = [
      ...(ftsQuery ? ["food_search MATCH ?"] : []),
      ...(types.sql ? [types.sql] : []),
    ];
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const whereValues = [...(ftsQuery ? [ftsQuery] : []), ...types.values];
    const from = ftsQuery
      ? "food_search JOIN food f ON f.fdc_id = food_search.rowid"
      : "food f";

    const orderValues: Array<string | number> = [];
    let order: string;
    if (args.orderBy === "relevance" && ftsQuery) {
      orderValues.push(...matchQualityBindings(args.nameFilter?.trim() ?? ""));
      // Textual fit leads; data type is a late tie-break; fdc_id is only the
      // unique terminal key that keeps LIMIT/OFFSET paging deterministic.
      order = `${matchQualityCase("f.description")}, food_search.rank, LENGTH(f.description), ${dataTypePriorityCase("f.data_type")}, f.fdc_id`;
    } else if (args.orderBy === "relevance") {
      order = "f.description, f.fdc_id";
    } else {
      order = `f.${sqlOrderBy(args.orderBy)} ${sqlDirection(args.direction)}, f.fdc_id`;
    }

    const rows = this.sql
      .exec(
        `SELECT f.summary FROM ${from} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
        ...whereValues,
        ...orderValues,
        args.pageSize,
        args.pageIndex * args.pageSize,
      )
      .toArray();
    const [count] = this.sql
      .exec(`SELECT count(*) AS count FROM ${from} ${where}`, ...whereValues)
      .toArray();
    return {
      data: rows.map((row) =>
        toSearchRow(
          parseSummary(z.object({ summary: z.string() }).parse(row).summary),
        ),
      ),
      count: countRow.parse(count).count,
    };
  }
}
