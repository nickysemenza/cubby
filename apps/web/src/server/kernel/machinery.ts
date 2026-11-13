/**
 * The `machinery` read (ADR 0029 section 10): a record's stage, gaps,
 * inputs and drift from one snapshot. Every source is checked against the
 * viewer (a hidden evidence row keeps its kind and status but loses its
 * code, time and author, and answers derived beside it lose their raw
 * error); raw errors are scrubbed and capped at 16 KB, collections at 50 with
 * `{ shown, total }`, and the response at 256 KB.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  FIELDS_SCOPE,
  QUALITY_SCOPE,
  recordScopeKey,
} from "@cubby/schemas/kernel/capability";
import {
  kernelJson,
  MACHINERY_COLLECTION_CAP,
  MACHINERY_RAW_ERROR_BYTES,
  MACHINERY_RESPONSE_BYTES,
  type Machinery,
  type MachineryGap,
  type MachineryInput,
  type ScopeInputRef,
} from "@cubby/schemas/kernel/machinery";
import {
  nextActor,
  resolveStage,
  type DecisionChannel,
  type DecisionKind,
  type KernelGap,
} from "@cubby/schemas/kernel/stage";
import { scrubErrorMessage } from "@cubby/worker-tracing/scrub-error-message";
import { getTableColumns, inArray, sql } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import {
  repositoryQueries,
  repositoryTransactionDatabase,
  type RepositoryQueryClient,
} from "~/server/db/repository-access.boundary";
import { isShortcodeEntity } from "~/server/entity-kernel/repo/entity-identity";
import { inheritedResetPreview } from "~/server/generic/field-explanation/repo/inherited-reset-preview";

import { askGapState, askIsStuck, askMemberGap } from "./ask-gap";
import { MAX_SCOPE_ATTEMPTS } from "./claim";
import { computeBatch } from "./compute";
import type { ColumnValues, Json, ScopeRef } from "./define";
import { resolveForRead } from "./identity";
import { recordSubject } from "./keys";
import { idColumn, KernelContractError } from "./reads";
import type { KernelRegistry } from "./registry";
import { isoText } from "./sql-time";
import { ASK, RECORD_WAITER } from "./vocab";
import { loadRunPasses } from "./work";

type Q = Pick<RepositoryQueryClient, "execute" | "select">;

/** Observations below this count give no ETA. */
const MIN_ETA_OBSERVATIONS = 5;

const scopeValues = (scopes: readonly ScopeRef[]) =>
  sql`(SELECT s.kind, s.key FROM jsonb_to_recordset(${JSON.stringify(scopes)}::jsonb) AS s(kind text, key text))`;

const capped = <T>(items: readonly T[]) => ({
  items: items.slice(0, MACHINERY_COLLECTION_CAP),
  shown: Math.min(items.length, MACHINERY_COLLECTION_CAP),
  total: items.length,
});

const rawText = (raw: string | null | undefined) => {
  if (!raw) return null;
  const scrubbed = scrubErrorMessage(raw);
  const bytes = new TextEncoder().encode(scrubbed);
  return bytes.byteLength <= MACHINERY_RAW_ERROR_BYTES
    ? scrubbed
    : new TextDecoder().decode(bytes.slice(0, MACHINERY_RAW_ERROR_BYTES));
};

const etaFrom = (position: number, medianMs: number | null) =>
  medianMs === null
    ? null
    : new Date(Date.now() + position * medianMs).toISOString();

/** The record's scopes in owning, fields, quality order. */
async function recordScopes(
  q: Q,
  registry: KernelRegistry,
  entity: string,
  id: string,
  field: string | undefined,
) {
  const capability = registry.machinery.get(entity);
  if (!capability)
    throw new KernelContractError(`${entity} declares no machinery capability`);
  const owned = await q.execute<{
    kind: string;
    key: string;
    rejected: boolean;
  }>(sql`
    SELECT DISTINCT "scopeKind" AS kind, "scopeKey" AS key, "rejectedAt" IS NOT NULL AS rejected
    FROM "RecordKey" WHERE entity = ${entity} AND "entityId" = ${id}::uuid
      AND "mergedAt" IS NULL
    ORDER BY kind, key`);
  const scopes: ScopeRef[] = [];
  if (!field)
    for (const row of owned.rows)
      if (
        !scopes.some(
          (scope) => scope.kind === row.kind && scope.key === row.key,
        )
      )
        scopes.push({ kind: row.kind, key: row.key });
  if (capability.fields)
    scopes.push({ kind: FIELDS_SCOPE, key: recordScopeKey(entity, id) });
  if (capability.quality && !field)
    scopes.push({ kind: QUALITY_SCOPE, key: recordScopeKey(entity, id) });
  return { scopes, rejected: owned.rows.some((row) => row.rejected) };
}

async function claimRanks(
  q: Q,
  registry: KernelRegistry,
  scopes: readonly ScopeRef[],
) {
  const kinds = [...registry.reconcilers.values()];
  if (!kinds.length || !scopes.length)
    return new Map<string, { position: number; of: number }>();
  const ranks = sql.join(
    kinds.map(
      (reconciler) =>
        sql`(${reconciler.scope}::text, ${registry.rank(reconciler.scope)}::int)`,
    ),
    sql`, `,
  );
  // Queue position is the order the runner claims: lane, upstream rank, availableAt, seq.
  const result = await q.execute<{
    kind: string;
    key: string;
    position: number;
    of: number;
  }>(sql`
    WITH ranks (kind, rank) AS (VALUES ${ranks}),
    queue AS (
      SELECT d."scopeKind" AS kind, d."scopeKey" AS key,
        row_number() OVER (PARTITION BY d.lane ORDER BY r.rank, d."availableAt", d.seq)::int AS position,
        count(*) OVER (PARTITION BY d.lane)::int AS of
      FROM "ScopeDirty" d JOIN ranks r ON r.kind = d."scopeKind"
      WHERE d.attempts < ${MAX_SCOPE_ATTEMPTS}
    )
    SELECT queue.* FROM queue JOIN ${scopeValues(scopes)} wanted
      ON wanted.kind = queue.kind AND wanted.key = queue.key`);
  return new Map(
    result.rows.map((row) => [
      `${row.kind}\u0000${row.key}`,
      { position: row.position, of: row.of },
    ]),
  );
}

export async function machinery(
  db: Database,
  registry: KernelRegistry,
  viewer: ActorContext,
  ref: { entity: string; id: string },
  options: { field?: string } = {},
): Promise<Machinery> {
  return repositoryTransactionDatabase(
    db,
    async (tx) => {
      const q = repositoryQueries(tx);
      const identity = isShortcodeEntity(ref.entity)
        ? await resolveForRead(tx, ref.id)
        : null;
      const { scopes, rejected } = await recordScopes(
        q,
        registry,
        ref.entity,
        ref.id,
        options.field,
      );
      const none = sql`SELECT NULL::text AS kind, NULL::text AS key WHERE false`;
      const wanted = scopes.length ? scopeValues(scopes) : sql`(${none})`;
      // Asks the record waits on directly (a Run's summary) join its scopes' asks.
      const recordWaiter = {
        kind: RECORD_WAITER,
        key: recordScopeKey(ref.entity, ref.id),
      };
      const waiting = scopeValues([...scopes, recordWaiter]);

      const [states, dirty, asks, drifts, ranks] = await Promise.all([
        q.execute<{
          kind: string;
          key: string;
          version: number;
          gaps: KernelGap[];
          inputs: ScopeInputRef[];
          stage: string;
          errorClass: string | null;
          error: string | null;
          reconciledAt: string | null;
          inputsChangedAt: string | null;
        }>(sql`
          SELECT s."scopeKind" AS kind, s."scopeKey" AS key, s.version, s.gaps, s.inputs, s.stage,
            s."errorClass", s.error, ${isoText(sql`s."reconciledAt"`)} AS "reconciledAt",
            ${isoText(sql`s."inputsChangedAt"`)} AS "inputsChangedAt"
          FROM "ScopeState" s JOIN ${wanted} w ON w.kind = s."scopeKind" AND w.key = s."scopeKey"`),
        q.execute<{
          kind: string;
          key: string;
          attempts: number;
          live: boolean;
          availableAt: string;
          updatedAt: string;
          lastError: string | null;
        }>(sql`
          SELECT d."scopeKind" AS kind, d."scopeKey" AS key, d.attempts,
            (d."claimToken" IS NOT NULL AND d."claimDeadline" > now()) AS live,
            ${isoText(sql`d."availableAt"`)} AS "availableAt", ${isoText(sql`d."updatedAt"`)} AS "updatedAt",
            d."lastError"
          FROM "ScopeDirty" d JOIN ${wanted} w ON w.kind = d."scopeKind" AND w.key = d."scopeKey"`),
        q.execute<{
          kind: string;
          key: string;
          inputHash: string;
          feature: string;
          state: string;
          attempts: number;
          maxAttempts: number;
          live: boolean;
          cancelled: boolean;
          availableAt: string;
          createdAt: string;
          lastError: string | null;
          position: number | null;
          of: number | null;
        }>(sql`
          WITH queue AS (
            SELECT id, row_number() OVER (ORDER BY "availableAt", "createdAt")::int AS position,
              count(*) OVER ()::int AS of
            FROM "Ask" WHERE state = ${ASK.queued} AND "cancelledAt" IS NULL AND attempts < "maxAttempts"
          )
          SELECT s."scopeKind" AS kind, s."scopeKey" AS key, a."inputHash", a.feature, a.state,
            a.attempts, a."maxAttempts", (a."claimToken" IS NOT NULL AND a."claimDeadline" > now()) AS live,
            a."cancelledAt" IS NOT NULL AS cancelled,
            ${isoText(sql`a."availableAt"`)} AS "availableAt", ${isoText(sql`a."createdAt"`)} AS "createdAt",
            a."lastError", queue.position, queue.of
          FROM "AskScope" s JOIN ${waiting} w ON w.kind = s."scopeKind" AND w.key = s."scopeKey"
          JOIN "Ask" a ON a.id = s."askId" LEFT JOIN queue ON queue.id = a.id`),
        q.execute<{
          kind: string;
          key: string;
          proposalHash: string;
          inputsHash: string;
          difference: unknown;
          askCount: number;
          estimatedCostMicros: string | number;
        }>(sql`
          SELECT p."scopeKind" AS kind, p."scopeKey" AS key, p."proposalHash", p."inputsHash", p.difference, p."askCount", p."estimatedCostMicros"
          FROM "Drift" p JOIN ${wanted} w ON w.kind = p."scopeKind" AND w.key = p."scopeKey" LIMIT 1`),
        claimRanks(q, registry, scopes),
      ]);

      const scopeKinds = [...new Set(scopes.map((scope) => scope.kind))];
      const askFeatures = [...new Set(asks.rows.map((row) => row.feature))];
      const [scopeMedians, askMedians] = await Promise.all([
        scopeKinds.length
          ? q.execute<{ kind: string; median: number | null; n: number }>(sql`
              SELECT "scopeKind" AS kind,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY "durationMs")::float8 AS median,
                count(*)::int AS n
              FROM "ScopeState" WHERE "durationMs" IS NOT NULL
                AND "scopeKind" IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(scopeKinds)}::jsonb))
              GROUP BY "scopeKind"`)
          : { rows: [] },
        askFeatures.length
          ? q.execute<{
              feature: string;
              median: number | null;
              n: number;
            }>(sql`
              SELECT feature,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM "answeredAt" - "sentAt") * 1000)::float8 AS median,
                count(*)::int AS n
              FROM "Ask" WHERE state = ${ASK.answered} AND "sentAt" IS NOT NULL
                AND feature IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(askFeatures)}::jsonb))
              GROUP BY feature`)
          : { rows: [] },
      ]);
      const median = (row: { median: number | null; n: number } | undefined) =>
        row && row.n >= MIN_ETA_OBSERVATIONS ? row.median : null;

      const stateOf = (scope: ScopeRef) =>
        states.rows.find(
          (row) => row.kind === scope.kind && row.key === scope.key,
        );
      const dirtyOf = (scope: ScopeRef) =>
        dirty.rows.find(
          (row) => row.kind === scope.kind && row.key === scope.key,
        );

      // Inputs, expanded with the viewer's access applied.
      const refs = scopes.flatMap((scope) => stateOf(scope)?.inputs ?? []);
      const evidenceIds = new Map<string, string[]>();
      for (const input of refs)
        if (input.kind === "evidence")
          evidenceIds.set(input.fact.kind, [
            ...(evidenceIds.get(input.fact.kind) ?? []),
            input.fact.id,
          ]);
      const evidenceRows = new Map<string, ColumnValues>();
      await Promise.all(
        [...evidenceIds].map(async ([kind, ids]) => {
          const evidence = registry.evidence.get(kind);
          if (!evidence) return;
          const rows: ColumnValues[] = await q
            .select()
            .from(evidence.table)
            .where(inArray(idColumn(evidence.table), ids));
          for (const row of rows)
            evidenceRows.set(`${kind}:${String(row.id)}`, row);
        }),
      );
      const decisionIds = refs.flatMap((input) =>
        input.kind === "decision" ? [input.id] : [],
      );
      const answerHashes = refs.flatMap((input) =>
        input.kind === "answer" ? [input.inputHash] : [],
      );
      const [decisions, answers, askStates] = await Promise.all([
        decisionIds.length
          ? q.execute<{
              id: string;
              channel: DecisionChannel;
              kind: DecisionKind;
              actorKind: string;
              at: string;
              supersededBy: string | null;
            }>(sql`
              SELECT d.id, d.channel, d.kind, d."actorKind", ${isoText(sql`d.at`)} AS at,
                (SELECT newer.id FROM "Decision" newer
                  WHERE newer.subject = d.subject AND newer.channel = d.channel AND newer.slot = d.slot
                    AND (newer.at, newer.id) > (d.at, d.id)
                  ORDER BY newer.at, newer.id LIMIT 1) AS "supersededBy"
              FROM "Decision" d
              WHERE d.id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(decisionIds)}::jsonb))`)
          : { rows: [] },
        answerHashes.length
          ? q.execute<{
              inputHash: string;
              model: string | null;
              tier: string | null;
              costMicros: string | number | null;
              createdAt: string;
            }>(sql`
              SELECT "inputHash", model, tier, "costMicros", ${isoText(sql`"createdAt"`)} AS "createdAt"
              FROM "Answer"
              WHERE "inputHash" IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(answerHashes)}::jsonb))`)
          : { rows: [] },
        answerHashes.length
          ? q.execute<{
              inputHash: string;
              state: string;
              attempts: number;
              maxAttempts: number;
              lastError: string | null;
            }>(sql`
              SELECT "inputHash", state, attempts, "maxAttempts", "lastError" FROM "Ask"
              WHERE "inputHash" IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(answerHashes)}::jsonb))`)
          : { rows: [] },
      ]);

      let hidden = false;
      const inputs: MachineryInput[] = refs.map((input): MachineryInput => {
        if (input.kind === "evidence") {
          const row = evidenceRows.get(`${input.fact.kind}:${input.fact.id}`);
          const evidence = registry.evidence.get(input.fact.kind);
          // SAFETY: the row was selected from this evidence kind's own table.
          const owner =
            row && evidence?.owner ? evidence.owner(row as never) : null;
          const visible = !owner || owner === viewer.userId;
          if (!visible) hidden = true;
          const shortcode =
            row && "shortcode" in getTableColumns(evidence!.table)
              ? row.shortcode
              : null;
          const createdAt =
            row?.createdAt instanceof Date ? row.createdAt.toISOString() : null;
          return {
            kind: "evidence",
            status: row ? "decided" : "skipped",
            source: visible && typeof shortcode === "string" ? shortcode : null,
            at: visible ? createdAt : null,
            by: null,
            answer: null,
            decision: null,
          };
        }
        if (input.kind === "decision") {
          const row = decisions.rows.find(
            (candidate) => candidate.id === input.id,
          );
          return {
            kind: "decision",
            status: row?.supersededBy ? "skipped" : "decided",
            source: null,
            at: row?.at ?? null,
            by: row?.actorKind ?? null,
            answer: null,
            decision: row
              ? {
                  channel: row.channel,
                  kind: row.kind,
                  supersededBy: row.supersededBy,
                }
              : null,
          };
        }
        const row = answers.rows.find(
          (candidate) => candidate.inputHash === input.inputHash,
        );
        const ask = askStates.rows.find(
          (candidate) => candidate.inputHash === input.inputHash,
        );
        const blocked =
          !row &&
          !!ask &&
          (ask.state === "unknown" || ask.attempts >= ask.maxAttempts);
        return {
          kind: "answer",
          status: row ? "decided" : blocked ? "blocked" : "gap",
          source: null,
          at: row?.createdAt ?? null,
          by: null,
          answer: {
            model: row?.model ?? null,
            tier: row?.tier ?? null,
            costMicros: row?.costMicros == null ? null : Number(row.costMicros),
            inputHash: input.inputHash,
            rawError: rawText(ask?.lastError),
          },
          decision: null,
        };
      });
      if (hidden)
        for (const input of inputs)
          if (input.answer) input.answer.rawError = null;

      // An answer Cubby cannot settle alone reads as the member's gap, live.
      const memberGap = (gap: KernelGap) => {
        const ask = gap.inputHash
          ? asks.rows.find((row) => row.inputHash === gap.inputHash)
          : undefined;
        return (ask && askMemberGap(ask, gap.input, gap.since)) ?? gap;
      };
      const recordAsks = asks.rows.filter(
        (row) => row.kind === recordWaiter.kind && row.key === recordWaiter.key,
      );
      const askGaps: { scope: ScopeRef; gap: KernelGap }[] = recordAsks.flatMap(
        (row) => {
          const label = registry.asks.get(row.feature)?.label ?? row.feature;
          if (row.state === "answered") return [];
          return [
            {
              scope: recordWaiter,
              gap: askMemberGap(row, label, row.createdAt) ?? {
                kind: "answer" as const,
                input: label,
                actor: "cubby" as const,
                since: row.createdAt,
                until: null,
                actions: [],
                inputHash: row.inputHash,
              },
            },
          ];
        },
      );
      const gaps: MachineryGap[] = [
        ...scopes.flatMap((scope) =>
          (stateOf(scope)?.gaps ?? []).map((gap) => ({
            scope,
            gap: memberGap(gap),
          })),
        ),
        ...askGaps,
      ].map(({ scope, gap }): MachineryGap => {
        const ask = gap.inputHash
          ? asks.rows.find((row) => row.inputHash === gap.inputHash)
          : undefined;
        const scopeDirty = dirtyOf(scope);
        const rank = ranks.get(`${scope.kind}\u0000${scope.key}`);
        const queue =
          gap.kind === "time" && gap.until
            ? { position: 1, of: 1, eta: gap.until, basis: "timer" as const }
            : ask?.position && ask.of
              ? (() => {
                  const ms = median(
                    askMedians.rows.find((row) => row.feature === ask.feature),
                  );
                  return {
                    position: ask.position,
                    of: ask.of,
                    eta: etaFrom(ask.position, ms),
                    basis:
                      ms === null
                        ? ("insufficient-history" as const)
                        : ("claim-order" as const),
                  };
                })()
              : rank && gap.actor !== "you"
                ? (() => {
                    const ms = median(
                      scopeMedians.rows.find((row) => row.kind === scope.kind),
                    );
                    return {
                      position: rank.position,
                      of: rank.of,
                      eta: etaFrom(rank.position, ms),
                      basis:
                        ms === null
                          ? ("insufficient-history" as const)
                          : ("claim-order" as const),
                    };
                  })()
                : null;
        const state = stateOf(scope);
        return {
          ...gap,
          askState: ask ? askGapState(ask) : null,
          queue,
          attempts: ask
            ? {
                n: ask.attempts,
                max: ask.maxAttempts,
                nextAt: ask.availableAt,
              }
            : scopeDirty
              ? {
                  n: scopeDirty.attempts,
                  max: MAX_SCOPE_ATTEMPTS,
                  nextAt: scopeDirty.availableAt,
                }
              : null,
          lastError: ask?.lastError
            ? {
                class: "ask",
                raw: hidden ? "" : (rawText(ask.lastError) ?? ""),
              }
            : state?.error
              ? {
                  class: state.errorClass ?? "failed",
                  raw: rawText(state.error) ?? "",
                }
              : null,
        };
      });

      // Only entities with public identity rows can be absorbed or deleted there.
      const ended =
        rejected ||
        (isShortcodeEntity(ref.entity) &&
          (!identity || identity.absorbed !== null));
      const passes =
        ref.entity === "run" && !options.field
          ? await loadRunPasses(q, ref.id)
          : [];
      const stuck =
        dirty.rows.some((row) => row.attempts >= MAX_SCOPE_ATTEMPTS) ||
        states.rows.some((row) => row.stage === "stuck") ||
        asks.rows.some(askIsStuck) ||
        passes.some((row) => row.stage === "stuck");
      const working =
        dirty.rows.some((row) => row.live) ||
        asks.rows.some((row) => row.live) ||
        passes.some((row) => row.stage === "working");
      const resolved = resolveStage({ ended, stuck, working, gaps });
      const stage =
        resolved === "done" && passes.some((row) => row.stage === "waiting")
          ? "waiting"
          : resolved;
      const times = (values: readonly (string | null | undefined)[]) =>
        values
          .filter((value): value is string => !!value)
          .sort()
          .at(-1) ?? null;
      const proposal = drifts.rows[0];
      const result: Machinery = {
        stage,
        nextActor: nextActor(gaps),
        computedAt: times(states.rows.map((row) => row.reconciledAt)),
        inputsChangedAt: times([
          ...states.rows.map((row) => row.inputsChangedAt),
          ...dirty.rows.map((row) => row.updatedAt),
        ]),
        scopes: scopes.map((scope) => {
          const state = stateOf(scope);
          return {
            kind: scope.kind,
            key: scope.key,
            reconciledAt: state?.reconciledAt ?? null,
            version: state?.version ?? null,
            error: state?.error
              ? {
                  class: state.errorClass ?? "failed",
                  raw: rawText(state.error) ?? "",
                }
              : null,
          };
        }),
        gaps: capped(gaps),
        inputs: capped(inputs),
        drift: proposal
          ? {
              scope: { kind: proposal.kind, key: proposal.key },
              proposalHash: proposal.proposalHash,
              inputsHash: proposal.inputsHash,
              // SAFETY: the column stores the JSON the sweep wrote.
              difference: proposal.difference as Json,
              askCount: proposal.askCount,
              estimatedCostMicros: Number(proposal.estimatedCostMicros),
            }
          : null,
        passes,
        totalCostMicros: answers.rows.reduce(
          (sum, row) =>
            sum + (row.costMicros == null ? 0 : Number(row.costMicros)),
          0,
        ),
        resetPreview: options.field
          ? await resetPreview(tx, registry, ref, options.field)
          : null,
        truncated: false,
      };
      return fitResponse(result);
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * What "Let Cubby decide" would make the field, computed without writing:
 * the field's declared reset (its resolution source or inheritance chain)
 * when it has one, otherwise the record's `fields` scope derived with the
 * member's assignment on the field released.
 */
async function resetPreview(
  db: Database,
  registry: KernelRegistry,
  ref: { entity: string; id: string },
  field: string,
): Promise<Machinery["resetPreview"]> {
  if (Object.hasOwn(entityFieldModels, ref.entity)) {
    // SAFETY: the own-property check above narrows the manifest key.
    const entity = ref.entity as Entity;
    const declared = await inheritedResetPreview(db, entity, field, ref.id);
    if (declared)
      return { source: "resolution", result: declared, pendingAnswers: 0 };
  }
  const capability = registry.machinery.get(ref.entity);
  const reconciler = registry.reconcilers.get(FIELDS_SCOPE);
  if (!capability?.fields || !reconciler) return null;
  const [computed] = await computeBatch(
    repositoryQueries(db),
    registry,
    reconciler,
    [{ kind: FIELDS_SCOPE, key: recordScopeKey(ref.entity, ref.id) }],
    {
      locked: false,
      hideBaseline: false,
      released: [{ subject: recordSubject(ref.entity, ref.id), field }],
    },
  );
  if (!computed?.desired) return null;
  const patched = computed.desired.patches.find(
    (patch) => patch.id === ref.id && Object.hasOwn(patch.values, field),
  );
  const value = patched
    ? kernelJson.parse(patched.values[field] ?? null)
    : null;
  return {
    source: "derivation",
    result: {
      kind: "live",
      decision: {
        outcome:
          value === null
            ? { kind: "empty", reason: "unset" }
            : { kind: "value", value },
        provenance: value === null ? null : { kind: "computed" },
      },
    },
    pendingAnswers: computed.missing.length,
  };
}

/** Drop trailing inputs, then gaps, until the response fits 256 KB. */
function fitResponse(result: Machinery): Machinery {
  const size = (value: Machinery) =>
    new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const fitted = {
    ...result,
    gaps: { ...result.gaps, items: [...result.gaps.items] },
    inputs: { ...result.inputs, items: [...result.inputs.items] },
  };
  while (
    size(fitted) > MACHINERY_RESPONSE_BYTES &&
    (fitted.inputs.items.length || fitted.gaps.items.length)
  ) {
    if (fitted.inputs.items.length) fitted.inputs.items.pop();
    else fitted.gaps.items.pop();
    fitted.inputs.shown = fitted.inputs.items.length;
    fitted.gaps.shown = fitted.gaps.items.length;
    fitted.truncated = true;
  }
  return fitted;
}
