import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { food as foodTable, foodAlias, releaseState } from "./sql-schema";
import {
  dataTypeEnum,
  type FoodLookupParam,
  type FoodSummary,
  toFoodSummaryCompact,
  type FoodSummaryCompact,
} from "../schemas";
import { toFtsFallbackQuery, toFtsQuery } from "./fts-query";
import type { FoodSearchArgs } from "./search-args";
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

// Stable namespace generation. Schema changes migrate the existing object in
// place so loaded releases and in-flight shard progress survive deployments.
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

export type FoodSearchPage = { data: FoodSummaryCompact[]; count: number };

// A shard that fails this many times in a row fails the release, so a missing
// object or a persistent R2 error surfaces instead of loading forever.
export const MAX_SHARD_ATTEMPTS = 3;

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

const countRow = z.object({ count: z.number() });

const MAX_SQL_VARIABLES = 100;

export class ShardLoadError extends Error {}

function parseSummary(text: string): FoodSummary {
  // SAFETY: every stored summary passed `releaseShardLine` when its shard was
  // loaded into this same object; re-validating each read costs the hot path.
  return JSON.parse(text) as FoodSummary;
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
    private readonly db: Pick<
      BaseSQLiteDatabase<"sync", unknown>,
      "select" | "insert" | "update" | "delete"
    >,
  ) {}

  private stateRow(): StateRow | null {
    const row = this.db.select().from(releaseState).get();
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
    this.db
      .insert(releaseState)
      .values({
        id: 1,
        release,
        state: "loading",
        manifest: JSON.stringify(manifest),
        started_at: new Date().toISOString(),
      })
      .run();
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
      this.db
        .update(releaseState)
        .set({
          state: "failed",
          error: `${key} did not load after ${row.attempts} attempts${row.error ? `; last error: ${row.error}` : ""}`,
        })
        .where(eq(releaseState.id, 1))
        .run();
      return null;
    }
    this.db
      .update(releaseState)
      .set({ attempts: sql`${releaseState.attempts} + 1` })
      .where(eq(releaseState.id, 1))
      .run();
    return key;
  }

  /** Returns a failed load to loading from its last committed shard. */
  resume() {
    this.db
      .update(releaseState)
      .set({ state: "loading", attempts: 0, error: null })
      .where(and(eq(releaseState.id, 1), eq(releaseState.state, "failed")))
      .run();
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
      this.db
        .update(releaseState)
        .set({
          next_shard: next,
          attempts: 0,
          error: null,
          state: done ? "ready" : "loading",
          ready_at: done ? new Date().toISOString() : null,
        })
        .where(eq(releaseState.id, 1))
        .run();
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
    this.db
      .update(releaseState)
      .set({ error: failure.message, state: failed ? "failed" : "loading" })
      .where(eq(releaseState.id, 1))
      .run();
    return !failed;
  }

  private insert(food: FoodSummary, superseded: number[]) {
    const branded = food.brandedFoodInfo;
    const value = {
      fdc_id: food.fdc_id,
      data_type: food.foodInfo.data_type,
      description: food.foodInfo.description,
      barcode_key: branded ? usdaBarcodeKey(branded.gtin_upc) : null,
      ndb_number: food.legacyFoodInfo?.ndb_number ?? null,
      summary: JSON.stringify(food),
    };
    this.db
      .insert(foodTable)
      .values(value)
      .onConflictDoUpdate({ target: foodTable.fdc_id, set: value })
      .run();
    // Drizzle has no FTS5 virtual-table write builder. Contentless FTS keeps
    // its existing rowid mapping and weighted rank configuration.
    this.sql.exec(
      "INSERT INTO food_search (rowid, description, brand_name, brand_owner) VALUES (?, ?, ?, ?)",
      food.fdc_id,
      food.foodInfo.description,
      branded?.brand_name ?? "",
      branded?.brand_owner ?? "",
    );
    for (const old of superseded) {
      this.db
        .insert(foodAlias)
        .values({ fdc_id: old, current_fdc_id: food.fdc_id })
        .onConflictDoUpdate({
          target: foodAlias.fdc_id,
          set: { current_fdc_id: food.fdc_id },
        })
        .run();
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
      const selected = foodTable[column];
      const rows = this.db
        .select({ key: selected, summary: foodTable.summary })
        .from(foodTable)
        .where(inArray(selected, chunk))
        .orderBy(desc(foodTable.fdc_id))
        .all();
      for (const { key, summary } of rows) {
        if (key !== null && !out.has(key)) out.set(key, parseSummary(summary));
      }
    }
    return out;
  }

  private currentIds(ids: number[]): Map<number, number> {
    const out = new Map<number, number>();
    for (const chunk of chunks([...new Set(ids)], MAX_SQL_VARIABLES)) {
      const rows = this.db
        .select()
        .from(foodAlias)
        .where(inArray(foodAlias.fdc_id, chunk))
        .all();
      for (const alias of rows) out.set(alias.fdc_id, alias.current_fdc_id);
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

  search(args: FoodSearchArgs): FoodSearchPage {
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

  private listPage(args: FoodSearchArgs): FoodSearchPage {
    const types = dataTypePredicate(
      "data_type",
      args.dataTypeFilter,
      args.foodsOnly,
      args.dataTypes,
    );
    for (const value of types.values) dataTypeEnum.parse(value);
    const where = types.values.length
      ? inArray(foodTable.data_type, types.values)
      : undefined;
    const column =
      args.orderBy === "fdc_id"
        ? foodTable.fdc_id
        : args.orderBy === "data_type"
          ? foodTable.data_type
          : foodTable.description;
    const order =
      args.orderBy === "relevance" || args.direction === "asc"
        ? asc(column)
        : desc(column);
    const rows = this.db
      .select({ summary: foodTable.summary })
      .from(foodTable)
      .where(where)
      .orderBy(order, asc(foodTable.fdc_id))
      .limit(args.pageSize)
      .offset(args.pageIndex * args.pageSize)
      .all();
    const total = this.db
      .select({ count: count() })
      .from(foodTable)
      .where(where)
      .get();
    return {
      data: rows.map((row) => toFoodSummaryCompact(parseSummary(row.summary))),
      count: total?.count ?? 0,
    };
  }

  private searchPage(args: FoodSearchArgs, ftsQuery: string): FoodSearchPage {
    if (!ftsQuery) return this.listPage(args);
    // MATCH, rank and the weighted FTS5 tie-break expressions are kept together
    // as raw SQL because Drizzle does not model virtual FTS tables.
    const types = dataTypePredicate(
      "f.data_type",
      args.dataTypeFilter,
      args.foodsOnly,
      args.dataTypes,
    );
    for (const value of types.values) dataTypeEnum.parse(value);
    const where = `WHERE food_search MATCH ?${types.sql ? ` AND ${types.sql}` : ""}`;
    const whereValues = [ftsQuery, ...types.values];
    const from = "food_search JOIN food f ON f.fdc_id = food_search.rowid";

    const orderValues: Array<string | number> = [];
    let order: string;
    if (args.orderBy === "relevance") {
      orderValues.push(...matchQualityBindings(args.nameFilter?.trim() ?? ""));
      // Textual fit leads; data type is a late tie-break; fdc_id is only the
      // unique terminal key that keeps LIMIT/OFFSET paging deterministic.
      order = `${matchQualityCase("f.description")}, food_search.rank, LENGTH(f.description), ${dataTypePriorityCase("f.data_type")}, f.fdc_id`;
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
        toFoodSummaryCompact(
          parseSummary(z.object({ summary: z.string() }).parse(row).summary),
        ),
      ),
      count: countRow.parse(count).count,
    };
  }
}
