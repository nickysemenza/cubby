import { suggestionStatus } from "@cubby/schemas/ai";
import {
  type StatementTransactionJudgment,
  statementTransactionJudgment,
} from "@cubby/schemas/statement-suggestion";
import { suggestionFamily } from "@cubby/schemas/suggestion";
import { createLogger } from "@cubby/worker-tracing";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { requestedRows } from "~/server/db/helpers/requested";
import { transactionImportRecord } from "~/server/db/retained-tables";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import { suggestionField } from "~/server/domains/transaction-import/repo/statement-charge";
import { statementAttachCandidate } from "~/server/domains/transaction-import/repo/statement-charge";
import {
  type ChargeRef,
  chargeId,
  type StatementSuggestionScope,
} from "~/server/domains/transaction-import/repo/statement-input";
import {
  footprintAffects,
  STATEMENT_PAGE_RUN_CREATES,
  statementBatchAttach,
  statementBatchCandidate,
  type StatementFootprint,
  statementFootprint,
  statementNeighbours,
} from "~/server/domains/transaction-import/repo/statement-suggestion-apply";
import {
  completeStatementReceipts,
  regenerateCharges,
} from "~/server/domains/transaction-import/repo/statement-suggestions";
import type { KernelServicesFor } from "~/server/entity-kernel/adapter";
import type { AutomaticSelection } from "~/server/generic/suggestions/repo/automatic-application";

const log = createLogger("statement-settlement");

/** Worker clocks stamp both a step checkpoint and an application decision. */
const RECOVERY_CLOCK_SKEW_MS = 2_000;

/**
 * Finish what a page that stopped between its commits and its neighbour
 * refresh left undone. Applications decided after the step's last recorded
 * page belong to an attempt that never checkpointed, so on the normal path this
 * finds nothing; on a replay it re-derives exactly those writes' copies and
 * neighbours from the committed rows and their application decisions, whatever
 * the replay's own selection now holds (an empty terminal page, applied label
 * receipts, retried charges). The rows and their operation ids stay as they
 * are; only the advisory republication runs again.
 */
export async function recoverSettlementObligations(
  db: Database,
  input: {
    /** When the step recorded its last page; null skips recovery. */
    since: Date | null;
    scope?: StatementSuggestionScope;
    /**
     * Where the stopped attempt's applications can be: a generation page's
     * charge-key range, the import a label page settles, or retried charges.
     */
    within:
      | { kind: "range"; after: ChargeRef | null; through: ChargeRef | null }
      | { kind: "import"; importId: string }
      | { kind: "charges"; charges: readonly ChargeRef[] };
  },
) {
  if (!input.since) return 0;
  const since = new Date(input.since.getTime() - RECOVERY_CLOCK_SKEW_MS);
  const { within } = input;
  if (within.kind === "charges" && !within.charges.length) return 0;
  const key = sql`(${suggestionField("source")}, ${suggestionField("chargeKey")})`;
  const retried =
    within.kind === "charges"
      ? requestedRows(
          within.charges.map((charge) => ({ ...charge })),
          { source: "text", chargeKey: "text" },
          "recovered_charge",
        )
      : null;
  const where =
    within.kind === "import"
      ? // Membership alone: recovery only republishes, so a wider set is safe.
        sql`${key} IN (SELECT DISTINCT observation.source, owner.shortcode
          FROM ${transactionImportRecord} member
          JOIN "SourceTransactionRecord" observation ON observation.id = member."statementRowId"
          JOIN "SourceOccurrence" owner ON owner.id = observation."occurrenceId"
          WHERE member."importId" = ${within.importId}::uuid)`
      : retried
        ? sql`${key} IN (SELECT ${retried.col("source")}, ${retried.col("chargeKey")} FROM ${retried.from})`
        : within.kind === "range"
          ? sql`${within.after ? sql`${key} > (${within.after.source}, ${within.after.chargeKey})` : sql`true`}
          ${within.through ? sql`AND ${key} <= (${within.through.source}, ${within.through.chargeKey})` : sql``}`
          : sql`false`;
  const rows = await unwrapDb(db).execute<{
    source: string;
    chargeKey: string;
    judgment: unknown;
  }>(
    sql`SELECT ${suggestionField("source")} AS source, ${suggestionField("chargeKey")} AS "chargeKey", s.judgment
    FROM "Suggestion" s
    WHERE s.family = ${sqlEnumConstant(suggestionFamily, suggestionFamily.enum.statement_transaction)}
      AND s.status = ${sqlEnumConstant(suggestionStatus, suggestionStatus.enum.applied)}
      AND ${where}
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.decisions) decision
        WHERE decision->>'operationId' LIKE 'command-application:automatic:%'
          AND (decision->>'createdAt')::timestamptz >= ${since.toISOString()}::timestamptz)`,
    "objects",
  );
  const applied = rows.flatMap((row) => {
    const judgment = statementTransactionJudgment.safeParse(row.judgment);
    if (!judgment.success) return [];
    const target = statementAttachCandidate(judgment.data);
    return [
      {
        charge: { source: row.source, chargeKey: row.chargeKey },
        judgment: judgment.data,
        dates: [
          judgment.data.statementDate,
          ...[target?.transactionDate, target?.postedDate].filter(
            (date): date is string => Boolean(date),
          ),
        ],
      },
    ];
  });
  if (!applied.length) return 0;
  const neighbours = await statementNeighbours(
    db,
    applied,
    input.scope?.importId ?? undefined,
  );
  // The after-commit refresh publishes outside the page's scope, as here.
  await regenerateCharges(db, neighbours);
  log.info("Statement settlement recovery", {
    applications: applied.length,
    neighbours: neighbours.length,
  });
  return neighbours.length;
}

/** One published receipt or rule publication a page settles, in page order. */
export type SettlementEntry = {
  charge: ChargeRef;
  suggestionId: string;
  /** A label receipt's evidence fence; generation publications have none. */
  evidenceFingerprint: string | null;
};

/**
 * - `applied`: its money committed (or its operation's receipt replayed).
 * - `completed`: a no-action receipt cleared.
 * - `moved`: a label receipt a page write or a refusal moved; it wrote no
 *   money and relabels on current evidence.
 * - `unfinished`: the budget, the conflict bound or a replacement it could
 *   not admit stopped it; it keeps its receipt and an inclusive cursor.
 * - `none`: nothing to apply or complete.
 */
export type SettlementOutcome =
  | { kind: "applied" }
  | { kind: "completed" }
  | { kind: "moved" }
  | { kind: "unfinished" }
  | { kind: "out_of_scope" }
  | { kind: "none" }
  | { kind: "failed"; error: Error };

/** Outcomes that settle a charge's place in the page's application order. */
const PROVEN: ReadonlySet<SettlementOutcome["kind"]> = new Set([
  "applied",
  "completed",
  "out_of_scope",
]);

/**
 * How many times a generation page re-admits a charge whose own review
 * refused published terms and republished current ones.
 */
const ALONE_REPLACEMENTS = 1;

type Barrier = {
  accountId: string;
  /** Null for a write with no create descriptor: it bars its whole account. */
  footprint: StatementFootprint | null;
};

type Item = {
  entry: SettlementEntry;
  judgment: StatementTransactionJudgment | null;
  selection: AutomaticSelection | null;
  /** Its rule applies alone, through the single review. */
  solo: boolean;
};

const barrierOf = (judgment: StatementTransactionJudgment): Barrier => ({
  accountId: judgment.accountId,
  footprint: judgment.create ? statementFootprint(judgment) : null,
});

/**
 * Whether a write books spending the other charge's own booking plans against:
 * the same Purchase or the same Vendor, whose plan then changes.
 */
const sharesBooking = (write: Barrier, other: Barrier) =>
  Boolean(
    write.footprint &&
    other.footprint &&
    ((write.footprint.purchaseId &&
      write.footprint.purchaseId === other.footprint.purchaseId) ||
      (write.footprint.vendor &&
        write.footprint.vendor === other.footprint.vendor)),
  );

/** Whether either write can change what the other plans or writes. */
const affects = (left: Barrier, right: Barrier) =>
  left.footprint && right.footprint
    ? footprintAffects(left.footprint, right.footprint) ||
      footprintAffects(right.footprint, left.footprint)
    : left.accountId === right.accountId;

/**
 * Settle a statement page's published receipts: independent clusters of
 * as-is creates commit together, one dependency layer per SERIALIZABLE
 * transaction, so a create that depends on an earlier one in the page waits
 * for a fresh snapshot after it. Any other rule applies alone through its own
 * review in page order; creates it cannot affect may commit before it. Every
 * committed write republishes the page's charges it affects before they are
 * admitted, and the page's untouched no-action receipts complete in their own
 * SERIALIZABLE transaction. Planning only nominates: each commit rebuilds its
 * charges' current evidence under its locks.
 */
export async function settleStatementPage(
  db: Database,
  input: {
    mode: "generation" | "label";
    scope?: StatementSuggestionScope;
    servicesFor: KernelServicesFor;
    entries: readonly SettlementEntry[];
    /**
     * The cooperative page budget. A page settles at least one charge before
     * honouring it, counting `settledBefore` from the caller's earlier rounds.
     */
    budgetSpent?: () => boolean;
    settledBefore?: boolean;
    time?: <T>(phase: string, work: () => Promise<T>) => Promise<T>;
  },
): Promise<Map<string, SettlementOutcome>> {
  const automatic =
    await import("~/server/generic/suggestions/repo/automatic-application");
  const { selectAutomaticRule } = automatic;
  const time = input.time ?? (<T>(_: string, work: () => Promise<T>) => work());
  const settlement = true;
  const outcomes = new Map<string, SettlementOutcome>();
  const settle = (item: Item, outcome: SettlementOutcome): null => {
    outcomes.set(chargeId(item.entry.charge), outcome);
    return null;
  };
  // A generation page's publications are this page's own until it writes.
  let written = input.mode === "label";
  const open = (item: Item) => !outcomes.has(chargeId(item.entry.charge));

  /** The rows behind these entries, with each one's current rule. */
  const read = async (entries: readonly SettlementEntry[]): Promise<Item[]> => {
    if (!entries.length) return [];
    const ids = entries.map((entry) => entry.suggestionId);
    const selections = await automatic.selectAutomaticRules(db, ids, {
      settlement,
    });
    const judgments = new Map(
      (
        await unwrapDb(db).execute<{ id: string; judgment: unknown }>(
          sql`SELECT s.id, s.judgment FROM "Suggestion" s WHERE s.id = ANY(${uuidArrayParam(ids)})`,
          "objects",
        )
      ).map((row) => [
        row.id,
        statementTransactionJudgment.safeParse(row.judgment).data ?? null,
      ]),
    );
    return entries.map((entry) => {
      const judgment = judgments.get(entry.suggestionId) ?? null;
      const selection = selections.get(entry.suggestionId) ?? null;
      return {
        entry,
        judgment,
        selection,
        solo: Boolean(
          selection &&
          (!judgment ||
            !(
              statementBatchCandidate(judgment) ||
              statementBatchAttach(judgment)
            )),
        ),
      };
    });
  };

  /** Each charge's current live publication, after a rebuild replaced it. */
  const current = async (charges: readonly ChargeRef[]) => {
    if (!charges.length) return new Map<string, SettlementEntry>();
    const requested = requestedRows(
      charges.map((charge) => ({ ...charge })),
      { source: "text", chargeKey: "text" },
      "settled_charge",
    );
    const rows = await unwrapDb(db).execute<{
      id: string;
      source: string;
      chargeKey: string;
      evidenceFingerprint: string;
    }>(
      sql`SELECT s.id, ${suggestionField("source")} AS source, ${suggestionField("chargeKey")} AS "chargeKey",
        ${suggestionField("evidenceFingerprint")} AS "evidenceFingerprint"
      FROM "Suggestion" s
      WHERE s.family = ${sqlEnumConstant(suggestionFamily, suggestionFamily.enum.statement_transaction)} AND s.active
        AND s.status = ${sqlEnumConstant(suggestionStatus, suggestionStatus.enum.pending)}
        AND (${suggestionField("source")}, ${suggestionField("chargeKey")}) IN (
          SELECT ${requested.col("source")}, ${requested.col("chargeKey")} FROM ${requested.from})`,
      "objects",
    );
    return new Map(
      rows.map((row) => [
        chargeId(row),
        {
          charge: { source: row.source, chargeKey: row.chargeKey },
          suggestionId: row.id,
          evidenceFingerprint: row.evidenceFingerprint,
        },
      ]),
    );
  };

  const initial = await current(input.entries.map((entry) => entry.charge));
  let items = await time("statement_settlement_selection", () =>
    read(
      input.entries.map(
        (entry) => initial.get(chargeId(entry.charge)) ?? entry,
      ),
    ),
  );

  /**
   * The open charges these writes affect are never settled on what they
   * published. A generation page republishes and re-admits them. On a label
   * page a rule's receipt waits for the next transaction, whose locked
   * rebuild re-reads its evidence, unless the write booked its Vendor or
   * Purchase: that plan changes, so it relabels in the next round on current
   * evidence, fenced by the receipt it replaces, as does a no-action receipt,
   * which completion would clear without a rebuild.
   */
  const replan = async (
    writes: readonly Barrier[],
    causes: readonly Item[],
  ) => {
    const own = new Set(causes.map((item) => chargeId(item.entry.charge)));
    const affected = items.filter(
      (item) =>
        open(item) &&
        !own.has(chargeId(item.entry.charge)) &&
        item.judgment &&
        writes.some((write) => affects(write, barrierOf(item.judgment!))),
    );
    if (!affected.length) return;
    if (input.mode === "label") {
      for (const item of affected)
        if (
          !item.selection ||
          writes.some((write) =>
            sharesBooking(write, barrierOf(item.judgment!)),
          )
        )
          settle(item, { kind: "moved" });
      return;
    }
    await time("statement_settlement_replan", () =>
      regenerateCharges(
        db,
        affected.map((item) => item.entry.charge),
        input.scope,
      ),
    );
    const now = await current(affected.map((item) => item.entry.charge));
    const replaced: SettlementEntry[] = [];
    for (const item of affected) {
      const fresh = now.get(chargeId(item.entry.charge));
      if (fresh?.suggestionId === item.entry.suggestionId) continue;
      // A charge left without a publication has nothing to admit.
      if (fresh) replaced.push(fresh);
      else settle(item, { kind: "none" });
    }
    if (!replaced.length) return;
    const reread = new Map(
      (await read(replaced)).map((item) => [chargeId(item.entry.charge), item]),
    );
    items = items.map(
      (item) => reread.get(chargeId(item.entry.charge)) ?? item,
    );
  };

  /** The next transaction: the first open solo, or one independent layer. */
  const next = () => {
    const blocked: Barrier[] = [];
    const cluster: Item[] = [];
    for (const item of items) {
      if (!open(item) || !item.selection || !item.judgment) continue;
      const barrier = barrierOf(item.judgment);
      const hit = (other: Barrier) => affects(other, barrier);
      if (item.solo) {
        if (!cluster.length && !blocked.some(hit))
          return { solo: item, cluster: null };
        blocked.push(barrier);
        continue;
      }
      if (
        cluster.length < STATEMENT_PAGE_RUN_CREATES &&
        !blocked.some(hit) &&
        !cluster.some((other) => affects(barrierOf(other.judgment!), barrier))
      )
        cluster.push(item);
      else blocked.push(barrier);
    }
    return cluster.length ? { solo: null, cluster } : null;
  };

  /** Apply one rule alone through its own review, after rebuilding its charge. */
  const alone = async (item: Item): Promise<Item | null> => {
    // A create's terms ignore candidates, so a candidate that appeared since
    // publication (a member's Transaction) must reach the publication first.
    let target = item;
    if (written) {
      await regenerateCharges(db, [item.entry.charge], input.scope);
      const fresh = (await current([item.entry.charge])).get(
        chargeId(item.entry.charge),
      );
      if (!fresh)
        return settle(item, {
          kind: input.mode === "label" ? "moved" : "none",
        });
      if (
        fresh.suggestionId !== item.entry.suggestionId ||
        fresh.evidenceFingerprint !== item.entry.evidenceFingerprint
      ) {
        const [reread] = await read([fresh]);
        // A label receipt replaced by rule output waits for its next page.
        if (!reread?.selection)
          return settle(item, {
            kind: input.mode === "label" ? "unfinished" : "none",
          });
        target = reread;
      }
    }
    for (let replaced = 0; ; replaced++) {
      if (!target.selection) return settle(item, { kind: "none" });
      const outcome = await time("statement_application_alone", () =>
        automatic.applyAutomaticRules(db, [target.entry.suggestionId], {
          context: input.servicesFor,
          settlement,
          statementScope: input.scope,
        }),
      );
      if (outcome.applied.length) {
        written = true;
        settle(item, { kind: "applied" });
        return target;
      }
      if (!outcome.refused.length) {
        const fresh = (await current([item.entry.charge])).get(
          chargeId(item.entry.charge),
        );
        if (
          fresh &&
          fresh.suggestionId !== target.entry.suggestionId &&
          replaced < ALONE_REPLACEMENTS
        ) {
          const [reread] = await read([fresh]);
          if (reread) {
            target = reread;
            continue;
          }
        }
        if (!fresh) return settle(item, { kind: "none" });
        return settle(item, {
          kind: "failed",
          error: new Error(
            "Automatic statement application refused: current selection disappeared.",
          ),
        });
      }
      // A booking that drifted since publication republishes its current
      // terms; an unchanged refusal fails.
      await regenerateCharges(db, [item.entry.charge], input.scope);
      const fresh = (await current([item.entry.charge])).get(
        chargeId(item.entry.charge),
      );
      if (
        fresh?.suggestionId === target.entry.suggestionId &&
        fresh.evidenceFingerprint === target.entry.evidenceFingerprint
      )
        return settle(item, {
          kind: "failed",
          error: new Error(
            `Automatic statement application refused: ${JSON.stringify(outcome.refused)}`,
          ),
        });
      if (!fresh) return settle(item, { kind: "none" });
      // Re-admit one replacement in the original position; later movement waits.
      if (replaced === ALONE_REPLACEMENTS)
        return settle(item, { kind: "unfinished" });
      const [reread] = await read([fresh]);
      if (!reread) return settle(item, { kind: "unfinished" });
      target = reread;
    }
  };

  const stop = () =>
    input.budgetSpent?.() === true &&
    (input.settledBefore === true ||
      [...outcomes.values()].some(
        (outcome) => outcome.kind === "applied" || outcome.kind === "completed",
      ));
  for (let plan = next(); plan; plan = next()) {
    if (stop()) break;
    const { solo, cluster } = plan;
    if (solo) {
      const applied = await alone(solo);
      if (applied?.judgment)
        await replan([barrierOf(applied.judgment)], [solo]);
      continue;
    }
    if (!cluster) break;
    const page = await time("statement_application_page", () =>
      automatic.applyAutomaticRulePage(
        db,
        cluster.map((item) => item.selection!),
        { context: input.servicesFor, statementScope: input.scope },
      ),
    );
    const applied: Item[] = [];
    let conflicted = false;
    for (const item of cluster) {
      switch (page.outcomes.get(item.selection!.row.id)) {
        case "applied":
          settle(item, { kind: "applied" });
          applied.push(item);
          break;
        case "out_of_scope":
          settle(item, { kind: "out_of_scope" });
          break;
        case "unfinished":
          conflicted = true;
          settle(item, { kind: "unfinished" });
          break;
        case "retry":
          break;
        default:
          // Declined before any write: it applies alone in its own transaction.
          item.solo = true;
      }
    }
    if (applied.length) written = true;
    if (applied.length)
      await replan(
        applied.map((item) => barrierOf(item.judgment!)),
        applied,
      );
    // Conflicts that outlast the page's replay bound wait for a later page.
    if (conflicted) break;
  }
  for (const item of items)
    if (open(item) && item.selection) settle(item, { kind: "unfinished" });

  // No-action receipts complete together in their own transaction, only in
  // the page's proven prefix: an earlier charge that has not settled may
  // still write what they rest on, and a write on this page that affected
  // one already moved it.
  const receipts: {
    item: Item;
    entry: SettlementEntry & { evidenceFingerprint: string };
  }[] = [];
  for (const item of items) {
    const outcome = outcomes.get(chargeId(item.entry.charge));
    if (outcome && PROVEN.has(outcome.kind)) continue;
    const { evidenceFingerprint } = item.entry;
    if (outcome || evidenceFingerprint === null) break;
    receipts.push({ item, entry: { ...item.entry, evidenceFingerprint } });
  }
  if (input.mode === "label" && receipts.length && !stop()) {
    const page = await time("statement_application_receipts", () =>
      automatic.applyAutomaticRulePage(db, [], {
        context: input.servicesFor,
        statementScope: input.scope,
        settle: {
          ids: receipts.map(({ entry }) => entry.suggestionId),
          run: async (tx, rows, outside) => ({
            outside,
            settled: new Set(
              await completeStatementReceipts(
                tx,
                receipts.map(({ entry }) => entry),
                rows,
                outside,
                (row) => !selectAutomaticRule(row, { settlement }),
              ),
            ),
          }),
        },
      }),
    );
    for (const { item, entry } of receipts) {
      const id = entry.suggestionId;
      if (page.settled?.settled.has(id)) settle(item, { kind: "completed" });
      else if (page.settled?.outside.has(id))
        settle(item, { kind: "out_of_scope" });
      else settle(item, { kind: "unfinished" });
    }
  }
  for (const item of items)
    if (open(item))
      settle(item, {
        kind: input.mode === "label" && !item.selection ? "unfinished" : "none",
      });
  log.info("Statement settlement page", {
    mode: input.mode,
    entries: input.entries.length,
    outcomes: [...outcomes.values()].reduce<Record<string, number>>(
      (counts, outcome) => ({
        ...counts,
        [outcome.kind]: (counts[outcome.kind] ?? 0) + 1,
      }),
      {},
    ),
  });
  return outcomes;
}
