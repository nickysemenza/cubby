import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { z } from "zod";
import { pollUntil } from "@cubby/shared/retry";

/**
 * A Tester Army journey is described once and executed by both engines.
 * The agent follows plain-language goals; exact UI text and database
 * read-backs (never the agent's own verdict) decide correctness.
 */
export type Engine = "web" | "ios";

/** A journey's seeded codes; reading one that was not seeded is a journey bug, so it throws. */
export class JourneyIds {
  constructor(
    private readonly codes: Readonly<Record<string, string>>,
    private readonly journey: string,
  ) {}
  get(key: string): string {
    const code = this.codes[key];
    if (code === undefined)
      throw new Error(`Journey ${this.journey} has no seeded ${key}`);
    return code;
  }
}

export type Json = z.core.util.JSONType;
export type ExpectedRow = Record<string, Json>;

/**
 * Rows a read-back query must return. Both sides are normalized by Postgres
 * (`jsonb`), so key order and numeric text cannot cause a false verdict.
 */
export type DbCheck = {
  label: string;
  sql: string;
  /** Resolved against the journey's seeded ids. */
  params?: (ids: JourneyIds) => string[];
  /** Expected rows in order, each a plain object of column -> value. */
  rows: (ids: JourneyIds) => ExpectedRow[];
};

export type StepCheck = {
  /** Exact text that must be on screen as soon as this step ends. */
  visible?: (ids: JourneyIds) => string[];
  /** Read-backs that must hold as soon as this step ends (for example "no write yet"). */
  db?: DbCheck[];
};

export type JourneyStep = {
  goal: string;
  check?: StepCheck;
  /** Replaces `goal` for one engine when the labels differ. */
  web?: string;
  ios?: string;
};

export type Journey = {
  id: string;
  title: string;
  /** Key of the seeded entity code the journey opens first. */
  start?: string;
  /** Opens a list or screen instead of an entity: a web path and an iOS deep link. */
  open?: (ids: JourneyIds) => { web: string; ios?: string };
  steps: JourneyStep[];
  /** Exact on-screen text that must be visible once the steps finish. */
  visible: (ids: JourneyIds) => string[];
  /** Exact on-screen text that must be absent (for example a rejected edit). */
  absent?: (ids: JourneyIds) => string[];
  db: DbCheck[];
  /** Engines the journey is not applicable to, with the reason. */
  skip?: Partial<Record<Engine, string>>;
};

export function stepGoal(step: JourneyStep, engine: Engine) {
  return step[engine] ?? step.goal;
}

export function loadJourneyIds(journey: string): JourneyIds {
  const file = z.string().min(1).parse(process.env.TESTER_ARMY_IDS_FILE);
  const all = z
    .record(z.string(), z.record(z.string(), z.string()))
    .parse(JSON.parse(readFileSync(file, "utf8")));
  const codes = all[journey];
  if (!codes) throw new Error(`No seeded ids for journey ${journey}`);
  return new JourneyIds(codes, journey);
}

const wrongRow = { unexpected: "synthetic-wrong-row" } satisfies ExpectedRow;

/** An expectation that can never match: the real rows plus one invented row. */
function corrupt(rows: ExpectedRow[]): ExpectedRow[] {
  return [...rows, wrongRow];
}

const jsonText = z.object({ text: z.string() });

async function normalizeExpected(pool: Pool, rows: ExpectedRow[]) {
  const result = await pool.query(`SELECT $1::jsonb::text AS text`, [
    JSON.stringify(rows),
  ]);
  return jsonText.parse(result.rows[0]).text;
}

async function readBack(pool: Pool, check: DbCheck, ids: JourneyIds) {
  const result = await pool.query(
    `SELECT COALESCE(jsonb_agg(to_jsonb(q)), '[]'::jsonb)::text AS text FROM (${check.sql}) q`,
    check.params?.(ids) ?? [],
  );
  return jsonText.parse(result.rows[0]).text;
}

/**
 * Polls each read-back until it equals the expectation. With `wrong`, the
 * expectation is deliberately corrupted, so the run must fail here. After a
 * passing read-back the same query is compared against a corrupted
 * expectation, which must NOT match: a negative control that proves the check
 * can fail without a second model run.
 */
export async function assertDatabase(
  journey: { id: string },
  checks: DbCheck[],
  ids: JourneyIds,
  wrong: boolean,
) {
  const pool = new Pool({
    connectionString: z.string().min(1).parse(process.env.DATABASE_URL),
  });
  try {
    for (const check of checks) {
      const expected = check.rows(ids);
      const target = await normalizeExpected(
        pool,
        wrong ? corrupt(expected) : expected,
      );
      let actual = "";
      try {
        await pollUntil(
          async () => {
            actual = await readBack(pool, check, ids);
            return actual === target ? true : undefined;
          },
          { label: `${journey.id}: ${check.label}`, timeoutMs: 15_000 },
        );
      } catch (cause) {
        throw new Error(
          `Database assertion failed (${journey.id}: ${check.label}). expected ${target} actual ${actual}`,
          { cause },
        );
      }
      if (actual === (await normalizeExpected(pool, corrupt(expected))))
        throw new Error(
          `Negative control matched (${journey.id}: ${check.label}); the assertion cannot fail`,
        );
    }
  } finally {
    await pool.end();
  }
}

export function selectedJourneys<T extends { id: string }>(all: T[]) {
  const wanted = process.env.TESTER_ARMY_JOURNEYS?.split(",").filter(Boolean);
  if (!wanted?.length) return all;
  const unknown = wanted.filter((id) => !all.some((j) => j.id === id));
  if (unknown.length)
    throw new Error(`Unknown Tester Army journey: ${unknown.join(", ")}`);
  return all.filter((j) => wanted.includes(j.id));
}
