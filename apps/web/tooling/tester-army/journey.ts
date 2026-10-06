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
  /** Poll deadline when the rows come from background work; default `TESTER_ARMY_DB_TIMEOUT_MS`. */
  timeoutMs?: number;
};

/**
 * A live agent run the journey started or seeded. The wait ends when the run
 * reaches `until`; a run that settles anywhere else fails at once with its
 * last progress and failed operations, instead of timing out.
 */
export type RunWait = {
  /** One row with column `id`: the run under test. */
  sql: string;
  params?: (ids: JourneyIds) => string[];
  until: "completed" | "awaiting_approval";
  timeoutMs: number;
};

export type StepCheck = {
  /** Exact text that must be on screen as soon as this step ends. */
  visible?: (ids: JourneyIds) => string[];
  /** Read-backs that must hold as soon as this step ends (for example "no write yet"). */
  db?: DbCheck[];
};

export type JourneyStep = {
  /** Holds the step until background work has written these rows. */
  ready?: DbCheck;
  /** Holds the step until a live run is ready for it (for example, proposals to review). */
  awaitRun?: RunWait;
  goal: string;
  check?: StepCheck;
  /** Replaces `goal` for one engine when the labels differ. */
  web?: string;
  ios?: string;
};

export type Journey = {
  id: string;
  title: string;
  /**
   * Runs on the coupled harness: the built Worker hosting the purchase agent,
   * with live model peers, object storage, and a simulated Mac browser. Web only.
   */
  coupled?: true;
  /** Exercises a control only the web app renders; never selected for iOS. */
  webOnly?: true;
  /** Extra agent context for this journey's steps. */
  context?: string;
  /** Attempt deadline when the journey waits on a live run. */
  timeoutMs?: number;
  /** Key of the seeded entity code the journey opens first. */
  start?: string;
  /** Opens a list or screen instead of an entity: a web path and an iOS deep link. */
  open?: (ids: JourneyIds) => { web: string; ios?: string };
  steps: JourneyStep[];
  /** Waits for a live run after the steps, then reloads before the final checks. */
  awaitRun?: RunWait;
  /** Exact on-screen text that must be visible once the steps finish. */
  visible: (ids: JourneyIds) => string[];
  /** Exact on-screen text that must be absent (for example a rejected edit). */
  absent?: (ids: JourneyIds) => string[];
  db: DbCheck[];
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
          {
            label: `${journey.id}: ${check.label}`,
            timeoutMs:
              check.timeoutMs ??
              Number(process.env.TESTER_ARMY_DB_TIMEOUT_MS ?? 15_000),
          },
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

const harnessName = z.enum(["standard", "coupled"]);
export type Harness = z.infer<typeof harnessName>;

/** Coupled journeys run on the web harness, so they are web only too. */
const isWebOnly = (journey: Pick<Journey, "coupled" | "webOnly">) =>
  Boolean(journey.coupled || journey.webOnly);

export const harnessOf = (journey: Pick<Journey, "coupled">): Harness =>
  journey.coupled ? "coupled" : "standard";

/**
 * `--journey a,b` (`TESTER_ARMY_JOURNEYS`) and `--harness`
 * (`TESTER_ARMY_HARNESS`) narrow the catalog; coupled and `webOnly` journeys
 * are web only.
 */
export function selectedJourneys(all: Journey[], engine: Engine) {
  const wanted = process.env.TESTER_ARMY_JOURNEYS?.split(",").filter(Boolean);
  const harness = harnessName
    .optional()
    .parse(process.env.TESTER_ARMY_HARNESS || undefined);
  const unknown = wanted?.filter((id) => !all.some((j) => j.id === id)) ?? [];
  if (unknown.length)
    throw new Error(`Unknown Tester Army journey: ${unknown.join(", ")}`);
  const webOnly = all.filter(
    (j) => isWebOnly(j) && engine === "ios" && wanted?.includes(j.id),
  );
  if (webOnly.length)
    throw new Error(
      `Web-only Tester Army journey: ${webOnly.map((j) => j.id).join(", ")}`,
    );
  return all.filter(
    (j) =>
      (!wanted?.length || wanted.includes(j.id)) &&
      (!harness || harnessOf(j) === harness) &&
      (engine === "web" || !isWebOnly(j)),
  );
}

const runOutcome = z.object({
  status: z.string(),
  failureCode: z.string().nullable(),
  awaitingApproval: z.boolean(),
});
const runEvidence = z.object({
  progress: z.array(
    z.object({ phase: z.string(), detail: z.string().nullable() }),
  ),
  // A review stop records its reason as an open finding.
  findings: z.array(z.object({ kind: z.string(), summary: z.string() })),
  failed: z.array(
    z.object({
      kind: z.string(),
      state: z.string(),
      error: z.string().nullable(),
    }),
  ),
});

/** Why a run stopped: its last progress, open findings, and failed operations. */
async function runDiagnosis(pool: Pool, runId: string) {
  const [progress, findings, failed] = await Promise.all([
    pool.query(
      'SELECT phase, detail FROM "RunProgress" WHERE "runId" = $1 ORDER BY "createdAt" DESC LIMIT 3',
      [runId],
    ),
    pool.query(
      'SELECT kind, summary FROM "RunFinding" WHERE "runId" = $1 AND status = $2 ORDER BY "createdAt"',
      [runId, "open"],
    ),
    pool.query(
      'SELECT kind, state, error FROM "RunOperation" WHERE "runId" = $1 AND state = $2 ORDER BY "startedAt"',
      [runId, "failed"],
    ),
  ]);
  return JSON.stringify(
    runEvidence.parse({
      progress: progress.rows,
      findings: findings.rows,
      failed: failed.rows,
    }),
    null,
    2,
  );
}

/** Polls a live run until it reaches `wait.until`; see {@link RunWait}. */
export async function awaitRun(
  journey: { id: string },
  wait: RunWait,
  ids: JourneyIds,
) {
  const pool = new Pool({
    connectionString: z.string().min(1).parse(process.env.DATABASE_URL),
  });
  let runId: string | undefined;
  try {
    await pollUntil(
      async () => {
        const selected = await pool.query(wait.sql, wait.params?.(ids) ?? []);
        runId = z
          .object({ id: z.string() })
          .optional()
          .parse(selected.rows[0])?.id;
        if (!runId) return undefined;
        const run = runOutcome.parse(
          (
            await pool.query(
              `SELECT r.status, r."failureCode",
                      COALESCE((SELECT p."awaitingApproval" FROM "RunProgress" p
                                WHERE p."runId" = r.id ORDER BY p."createdAt" DESC LIMIT 1), false) AS "awaitingApproval"
                 FROM "Run" r WHERE r.id = $1`,
              [runId],
            )
          ).rows[0],
        );
        if (wait.until === "completed" && run.status === "completed")
          return true;
        if (
          wait.until === "awaiting_approval" &&
          run.status === "running" &&
          run.awaitingApproval
        )
          return true;
        if (run.status === "running" || run.status.startsWith("paused"))
          return undefined;
        throw new Error(
          `${journey.id}: run ended ${run.status}${run.failureCode ? ` (${run.failureCode})` : ""} before ${wait.until}\n${await runDiagnosis(pool, runId)}`,
        );
      },
      {
        label: `${journey.id}: run ${wait.until}`,
        timeoutMs: wait.timeoutMs,
        intervalMs: 2_000,
      },
    );
  } catch (error) {
    if (
      !runId ||
      !(error instanceof Error) ||
      !error.message.startsWith("Timed out")
    )
      throw error;
    throw new Error(`${error.message}\n${await runDiagnosis(pool, runId)}`, {
      cause: error,
    });
  } finally {
    await pool.end();
  }
}
