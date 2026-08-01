/**
 * The reconciliation matcher — link vendor-export lines to `Expense` rows.
 *
 * **Read-only. Ranks, never applies.** Everything here returns candidates for a
 * human to approve; nothing writes, and nothing here is safe to auto-apply.
 *
 * ## Why this exists at all
 *
 * Keyword search cannot reconcile this ledger, because **the ledger names the
 * thing, not the product**. Searching `festool`/`vacuum` for a "Festool Vacuum"
 * export line found nothing, so a duplicate row was added — while a
 * `dust extractor` row for the identical amount and date had existed since 2024.
 * Zero shared tokens. The same trap hid a Bosch miter saw booked as `chop saw`.
 * The only filter that works is **amount + date across the whole ledger,
 * ignoring names entirely**, with names used afterwards only to GRADE.
 *
 * ## Why one wide window instead of discrete hypotheses
 *
 * Ledger amounts are distorted two different ways: tax MULTIPLICATIVELY (the
 * house rate, and rows are entered both tax-inclusive and pre-tax) and fees
 * ADDITIVELY (shipping, core charges). Enumerating hypotheses — `cost`,
 * `cost x 1.08625`, `cost / 1.08625`, order-total — is the wrong shape, because
 * each is tested alone and none of them covers a fee at all. That approach
 * missed 24 pre-tax rows in one pass, found four separate ways.
 *
 * So this matches on ONE generous asymmetric window and then *explains* every
 * hit: `amountDelta`, `ratio`, and a `ratioLabel` classified against `taxRate`.
 * A residual of exactly `9.99` shows up as a plain number a human immediately
 * recognizes as shipping — which a discrete hypothesis would have silently
 * rejected. `taxRate` is therefore a LABELING input, never a matching one.
 *
 * ## Structure
 *
 * One query, two arms, `UNION ALL` into a single result set with a `matchedOn`
 * discriminator — so per-row capping and ranking happen once rather than being
 * reconciled between two queries:
 *
 *   - **order-id arm** — exact match on the charge's `orderId`. The strongest
 *     key, and the ONLY one that catches both the aggregate-vs-components and
 *     the split-vs-total directions. (B&H order `1121197219` was booked as two
 *     sibling rows; an amount+date search for its $306.27 order total found
 *     nothing, so a duplicate aggregate was created and had to be deleted.)
 *     Deliberately NOT day-limited: a charge's lines can sit weeks from the
 *     order date.
 *   - **amount+date arm** — the signed window described above.
 *
 * Token overlap is computed in TS below rather than in SQL: stopword handling
 * and compound words (`labelmaker` / "label maker") are prose logic that will
 * need iterating, `&&` in repo SQL is lint-banned, and keeping it out of the
 * query makes it structurally impossible for a grading signal to drift into a
 * filter — which it must never become.
 */
import { unsafeExpenseShortcode } from "@cubby/schemas/identifiers";
import type {
  ExpenseMatchCandidate,
  ExpenseMatchOptions,
  ExpenseMatchOut,
  ExpenseMatchRatioLabel,
} from "@cubby/schemas/project";
import { sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { getDb } from "~/server/repo/database-helpers";

/**
 * Raw shape of one candidate row off the wire.
 *
 * Money and day counts come back as strings from `pg` for `numeric`/`bigint`
 * outputs, so every one is cast in SQL and coerced again here — the same
 * belt-and-braces `detectors-purchase.ts` applies.
 */
type MatchRow = {
  key: string;
  expenseShortcode: string;
  name: string;
  cost: number | null;
  date: string;
  future: boolean;
  notes: string | null;
  vendorName: string | null;
  orderId: string | null;
  projectName: string | null;
  productName: string | null;
  matchedOn: "order_id" | "amount_date";
  vendorMatch: boolean | null;
  dayDelta: number | null;
  amountDelta: number | null;
};

/**
 * Tokens that carry no identifying signal in either a vendor export line or a
 * ledger row name. Kept deliberately small: over-stripping costs real overlap,
 * and overlap is only ever a grading hint.
 */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "pack",
  "pc",
  "pcs",
  "set",
  "the",
  "to",
  "with",
  "x",
]);

/** Lowercase alphanumeric tokens, stopwords and 1-character noise dropped. */
const tokenize = (value: string | null | undefined): Set<string> => {
  if (!value) return new Set();
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 1 && !STOPWORDS.has(token)),
  );
};

const countOverlap = (a: Set<string>, b: Set<string>): number => {
  let n = 0;
  for (const token of a) if (b.has(token)) n += 1;
  return n;
};

/**
 * Classify `cost / amount` against the tax rate.
 *
 * `exact` is an absolute cent comparison, not a ratio one — a one-cent gap is
 * exact at any magnitude, and rounding a float ratio would make the verdict
 * depend on where binary floating point happened to land (the same trap
 * `reconcilePurchase` documents).
 *
 * The tax bands are relative because they scale with the amount. Everything
 * else is `other` **on purpose**: the caller reads `amountDelta` and recognizes
 * a $9.99 or $12.50 residual as shipping. Do not add hypotheses here.
 */
const classifyRatio = (
  amountDelta: number | null,
  ratio: number | null,
  taxRate: number,
): ExpenseMatchRatioLabel => {
  if (amountDelta !== null && Math.round(Math.abs(amountDelta) * 100) <= 1)
    return "exact";
  if (ratio === null) return "other";
  const band = 0.005;
  if (Math.abs(ratio - (1 + taxRate)) <= band) return "plus_tax";
  if (Math.abs(ratio - 1 / (1 + taxRate)) <= band) return "pre_tax";
  return "other";
};

/**
 * Rank export lines against the ledger. One query for the whole batch.
 *
 * Every identifier is hand-qualified and every column explicitly cast: this is
 * raw SQL, so Drizzle's `mode: "string"` date mapping does not apply (pg's
 * default DATE parser would hand back a `Date` where the contract is a
 * `YYYY-MM-DD` string), and an untyped `VALUES` literal would infer `text` and
 * break the numeric and date comparisons silently.
 */
export const matchExpenses = async (
  db: Database,
  options: ExpenseMatchOptions,
): Promise<ExpenseMatchOut> => {
  const {
    rows,
    dayWindow,
    amountToleranceLow,
    amountToleranceHigh,
    amountFloor,
    taxRate,
    maxCandidatesPerRow,
  } = options;

  // The input batch as a typed VALUES list, built term by term.
  //
  // ⚠️ NOT `${rows.map(...)}` or any interpolated JS array: Drizzle emits an
  // array parameter as a ROW CONSTRUCTOR (`($1,$2)`), not a list — the
  // `drizzle-array-param-row-constructor` trap. `sql.join` is what produces a
  // real comma-separated VALUES list of individually-parameterized tuples.
  const values = sql.join(
    rows.map(
      (row) =>
        sql`(${row.key}::text, ${row.date}::date, ${row.amount}::double precision, ${row.orderId ?? null}::text, ${row.vendor ?? null}::text)`,
    ),
    sql`, `,
  );

  const res = await getDb(db).execute<MatchRow>(sql`
    WITH input("key", "inDate", "amount", "orderId", "vendor") AS (VALUES ${values}),
    -- Every live expense with its display joins resolved. Each join carries its
    -- own deletedAt guard: a soft-deleted charge is still a row, so without it
    -- an expense whose charge was deleted would keep reporting its old vendor.
    --
    -- Referenced by both arms, so Postgres materializes it — the whole ledger,
    -- four joins wide, scanned once. Deliberate at this scale (a few thousand
    -- rows against a batch capped at 200): one clear pass beats two arms that
    -- each re-derive the same join graph. Revisit if the ledger grows an order
    -- of magnitude.
    live AS (
      SELECT
        e."shortcode"   AS "expenseShortcode",
        e."name"        AS "name",
        e."cost"        AS "cost",
        e."date"        AS "date",
        e."future"      AS "future",
        e."notes"       AS "notes",
        p."orderId"     AS "orderId",
        v."name"        AS "vendorName",
        pr."name"       AS "projectName",
        pd."name"       AS "productName"
      FROM "Expense" e
      LEFT JOIN "Purchase" p
        ON p."id" = e."purchaseId" AND p."deletedAt" IS NULL
      LEFT JOIN "Vendor" v
        ON v."id" = p."vendorId" AND v."deletedAt" IS NULL
      LEFT JOIN "Project" pr
        ON pr."id" = e."projectId" AND pr."deletedAt" IS NULL
      LEFT JOIN "Product" pd
        ON pd."id" = e."productId" AND pd."deletedAt" IS NULL
      WHERE e."deletedAt" IS NULL
    ),
    arms AS (
      -- Arm 1: exact order id. No day window — a charge's lines can sit weeks
      -- from the order date, and this arm is precisely the one that finds the
      -- aggregate when you searched for a component (and vice versa).
      --
      -- ⚠️ An order id is only unique WITHIN a vendor: the charge table's
      -- "Purchase_vendorId_orderId_key" is UNIQUE(vendorId, orderId), and short
      -- ids genuinely collide across retailers (Tool Nirvana's "#11325"). So
      -- this join alone can return an unrelated vendor's expense — on the arm
      -- that ignores the day window and ranks first, i.e. dressed up as the
      -- highest-confidence candidate. That is the exact plausible-but-wrong
      -- failure this matcher exists to avoid.
      --
      -- The join stays permissive rather than adding "AND vendor = vendor",
      -- because vendor names are matched EXACTLY here and an export's spelling
      -- routinely differs from the roster's ("Amazon" vs "Amazon.com" are two
      -- real rows). A hard vendor predicate would drop TRUE matches on the one
      -- arm that finds what nothing else can. Instead the conflict is detected
      -- and used to DEMOTE — see "rankTier" below.
      SELECT i."key", i."inDate", i."amount", i."vendor", l.*, 0 AS "arm"
      FROM input i
      JOIN live l ON l."orderId" = i."orderId"
      WHERE i."orderId" IS NOT NULL

      UNION ALL

      -- Arm 2: the signed amount window, plus a day window.
      --
      -- The window is computed on the SIGNED amount, so a credit matches a
      -- credit: at amount = -96.67 the bounds are about [-111, -87], not a
      -- positive band. Credits are real here (refunds, and the family wedding
      -- contributions), and getting this wrong would silently break every
      -- disposal reconciliation.
      --
      -- Half-widths are max(relative, floor): relative because +/-$0.25 is
      -- sensible at $200 and meaningless at $1, floored because a purely
      -- relative band collapses to nothing at small amounts (a $0.93 order
      -- false-matched a $1.00 row once and had to be reverted).
      --
      -- Null cost and null date fall out of these comparisons by plain SQL
      -- semantics. That is intended, and asserted in the tests.
      SELECT i."key", i."inDate", i."amount", i."vendor", l.*, 1 AS "arm"
      FROM input i
      JOIN live l
        ON l."cost" >= CASE WHEN i."amount" >= 0
             THEN i."amount" - greatest(abs(i."amount") * ${amountToleranceLow}::double precision, ${amountFloor}::double precision)
             ELSE i."amount" - greatest(abs(i."amount") * ${amountToleranceHigh}::double precision, ${amountFloor}::double precision)
           END
       AND l."cost" <= CASE WHEN i."amount" >= 0
             THEN i."amount" + greatest(abs(i."amount") * ${amountToleranceHigh}::double precision, ${amountFloor}::double precision)
             ELSE i."amount" + greatest(abs(i."amount") * ${amountToleranceLow}::double precision, ${amountFloor}::double precision)
           END
       AND l."date" IS NOT NULL
       AND abs(l."date" - i."inDate") <= ${dayWindow}::int
    ),
    -- One export row can hit the same expense on both arms; keep the stronger.
    deduped AS (
      SELECT DISTINCT ON ("key", "expenseShortcode") *
      FROM arms
      ORDER BY "key", "expenseShortcode", "arm"
    ),
    -- Does the ledger row's vendor contradict the one on the export line?
    --
    -- Three states, and the difference matters: NULL when the export carried no
    -- vendor or the ledger row has no charge (nothing to compare — unknown, not
    -- clean), true when both are present and agree, false when they disagree.
    -- Compared case-folded and trimmed, which is looser than the roster's own
    -- exact matching on purpose: a case difference is a spelling variant, not a
    -- different counterparty.
    flagged AS (
      SELECT
        *,
        CASE
          WHEN "vendor" IS NULL OR "vendorName" IS NULL THEN NULL
          ELSE lower(btrim("vendor")) = lower(btrim("vendorName"))
        END AS "vendorMatchRaw"
      FROM deduped
    ),
    ranked AS (
      SELECT
        *,
        ("date" - "inDate") AS "dayDeltaRaw",
        ("cost" - "amount") AS "amountDeltaRaw",
        ROW_NUMBER() OVER (
          PARTITION BY "key"
          ORDER BY
            -- Tier, not raw "arm". An order-id hit earns the top slot because an
            -- identifier beats a guess — but ONLY while its vendor doesn't
            -- contradict the export line. A cross-vendor order-id collision is
            -- almost certainly the wrong row, so it sorts BELOW every amount+date
            -- candidate instead of above them. It is still returned, flagged, and
            -- never silently dropped: the vendor spellings may simply differ.
            CASE
              WHEN "arm" = 0 AND "vendorMatchRaw" IS NOT FALSE THEN 0
              WHEN "arm" = 1 THEN 1
              ELSE 2
            END,
            abs("date" - "inDate") NULLS LAST,
            abs("cost" - "amount") NULLS LAST
        ) AS "rn"
      FROM flagged
    )
    SELECT
      "key",
      "expenseShortcode",
      "name",
      "cost"::double precision AS "cost",
      "date"::text            AS "date",
      "future",
      "notes",
      "vendorName",
      "orderId",
      "projectName",
      "productName",
      CASE WHEN "arm" = 0 THEN 'order_id' ELSE 'amount_date' END AS "matchedOn",
      "vendorMatchRaw"                      AS "vendorMatch",
      "dayDeltaRaw"::int                    AS "dayDelta",
      "amountDeltaRaw"::double precision    AS "amountDelta",
      "rn"::int                             AS "rn"
    FROM ranked
    WHERE "rn" <= ${maxCandidatesPerRow}::int
    ORDER BY "key", "rn"
  `);

  const byKey = new Map<string, ExpenseMatchCandidate[]>();
  const rowByKey = new Map(rows.map((row) => [row.key, row]));

  for (const raw of res.rows) {
    const inputRow = rowByKey.get(raw.key);
    if (!inputRow) continue;

    const cost = raw.cost === null ? null : Number(raw.cost);
    const amountDelta =
      raw.amountDelta === null ? null : Number(raw.amountDelta);
    // Guarded rather than relying on IEEE division: at amount 0 the ratio is
    // meaningless, and `Infinity` would serialize as null through zod anyway.
    const ratio =
      cost === null || inputRow.amount === 0 ? null : cost / inputRow.amount;

    const candidate: ExpenseMatchCandidate = {
      expenseId: unsafeExpenseShortcode(raw.expenseShortcode),
      name: raw.name,
      cost,
      date: raw.date,
      future: raw.future,
      notes: raw.notes,
      vendorName: raw.vendorName,
      orderId: raw.orderId,
      projectName: raw.projectName,
      productName: raw.productName,
      matchedOn: raw.matchedOn,
      vendorMatch: raw.vendorMatch,
      dayDelta: raw.dayDelta === null ? null : Number(raw.dayDelta),
      amountDelta,
      ratio,
      ratioLabel: classifyRatio(amountDelta, ratio, taxRate),
      tokenOverlap: countOverlap(tokenize(inputRow.label), tokenize(raw.name)),
    };

    const existing = byKey.get(raw.key);
    if (existing) existing.push(candidate);
    else byKey.set(raw.key, [candidate]);
  }

  // Echo every input key back in its original order, so a caller can zip the
  // result against its own batch without re-keying.
  const matches = rows
    .filter((row) => byKey.has(row.key))
    .map((row) => ({ key: row.key, candidates: byKey.get(row.key) ?? [] }));

  return {
    matches,
    unmatched: rows.filter((row) => !byKey.has(row.key)).map((row) => row.key),
    summary: {
      rowsIn: rows.length,
      rowsWithCandidates: matches.length,
      exactOrderIdHits: matches.filter((m) =>
        m.candidates.some((c) => c.matchedOn === "order_id"),
      ).length,
    },
  };
};
