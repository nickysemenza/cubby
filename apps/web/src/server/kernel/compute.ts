/**
 * Load and compute for one batch of scopes of one kind (ADR 0029 sections 2
 * and 3). `load` runs first; `reconcile` then runs as a pure function. When
 * it asks for answers or decisions the batch has not loaded, the kernel loads
 * them for the whole batch in one statement each and runs `reconcile` again,
 * so a batch issues a bounded number of statements however many scopes it has.
 */
import type { KernelActor, KernelGap } from "@cubby/schemas/kernel/stage";
import { sourceActor } from "@cubby/schemas/kernel/stage";
import { and, inArray, sql } from "drizzle-orm";

import { textArrayParam } from "~/server/db/helpers/array-param";
import { answer, evidenceBinding, recordKey } from "~/server/db/kernel-schema";
import type { RepositoryQueryClient } from "~/server/db/repository-access.boundary";

import type {
  AskKind,
  Binding,
  ColumnRef,
  ColumnValues,
  DecisionInForce,
  Desired,
  DesiredRecord,
  FactRef,
  Json,
  Key,
  Pure,
  Reconciler,
  ScopeRef,
} from "./define";
import { lockKeyRevs, readKeyRevs } from "./dirty";
import {
  askEnvelope,
  envelopeText,
  inputHashOf,
  type AskEnvelope,
} from "./envelope";
import { answerKey, decisionKey, hashCanonical, VETO_SEPARATOR } from "./keys";
import {
  createReads,
  idColumn,
  KernelContractError,
  KeyLedger,
  type ReadMode,
} from "./reads";
import { bindingWrites, type KernelRegistry } from "./registry";
import { isoText } from "./sql-time";

type Q = Pick<RepositoryQueryClient, "select" | "execute">;

/** Rounds of demand-driven loading before a scope is failed as unstable. */
const MAX_ROUNDS = 4;

type OwnedRecord = {
  target: ColumnRef;
  naturalKey: string;
  entityId: string;
  minted: boolean;
  rejected: boolean;
  /** The stored row the load saw; the apply compares against it. */
  stored: ColumnValues | null;
};

type MissingAnswer = {
  kind: AskKind;
  envelope: AskEnvelope;
  inputHash: string;
};

type UsedAnswer = {
  kind: AskKind;
  inputHash: string;
};

export type Computed = {
  scope: ScopeRef;
  reconciler: Reconciler;
  /** Every key the scope read, with the revision each saw. */
  keys: ReadonlyMap<Key, number>;
  desired: Desired | null;
  error: unknown;
  owned: readonly OwnedRecord[];
  storedBindings: readonly Binding[];
  /** Evidence facts the load read, in read order. */
  facts: readonly FactRef[];
  /** Stored rows of records the scope patches, by table name then id. */
  patched: ReadonlyMap<string, ReadonlyMap<string, ColumnValues>>;
  missing: readonly MissingAnswer[];
  answers: readonly UsedAnswer[];
  decisions: readonly { subject: string; id: string }[];
  inputsHash: string;
  durationMs: number;
};

export type ComputeMode = ReadMode;

/** The record key's entity column: the manifest entity, or the table name. */
export const recordEntity = (target: ColumnRef) => target.entity ?? target.name;

type DecisionRow = {
  id: string;
  channel: string;
  subject: string;
  slot: string;
  kind: string;
  value: Json | null;
  at: string;
};

type Tracked = {
  answers: Map<string, { kind: AskKind; envelope: AskEnvelope }>;
  subjects: Set<string>;
};

export async function computeBatch(
  q: Q,
  registry: KernelRegistry,
  reconciler: Reconciler,
  scopes: readonly ScopeRef[],
  mode: ComputeMode,
): Promise<Computed[]> {
  const started = performance.now();
  const ledger = new KeyLedger();
  const scopeKeys = scopes.map((scope) => scope.key);
  const revisions = (keys: readonly Key[]) =>
    mode.locked ? lockKeyRevs(q, keys) : readKeyRevs(q, keys);
  const reads = createReads(q, reconciler, scopeKeys, ledger, mode);

  let inputs: Map<string, unknown>;
  let owned: Map<string, OwnedRecord[]>;
  let storedBindings: Map<string, Binding[]>;
  try {
    [inputs, owned, storedBindings] = await Promise.all([
      reconciler.load(reads, scopeKeys),
      loadOwned(q, reconciler, scopes),
      loadStoredBindings(q, reconciler, scopes),
    ]);
  } catch (error) {
    return scopes.map((scope) =>
      failed(scope, reconciler, error, performance.now() - started),
    );
  }

  /** Answers by envelope text: the row's output, or null once known missing. */
  const answers = new Map<string, { inputHash: string; output: Json | null }>();
  const decisions = new Map<string, DecisionRow[]>();
  const loadedSubjects = new Set<string>();
  const usedBy = new Map<string, Tracked>(
    scopes.map((scope) => [
      scope.key,
      { answers: new Map(), subjects: new Set<string>() },
    ]),
  );

  let results = new Map<string, { desired: Desired | null; error: unknown }>();
  for (let round = 0; ; round++) {
    results = new Map();
    const wantedAnswers = new Map<
      string,
      { kind: AskKind; envelope: AskEnvelope; scopes: Set<string> }
    >();
    const wantedSubjects = new Map<string, Set<string>>();
    for (const scope of scopes) {
      const tracked = usedBy.get(scope.key)!;
      if (!inputs.has(scope.key)) {
        results.set(scope.key, {
          desired: null,
          error: new KernelContractError(
            `Reconciler ${reconciler.scope} loaded no input for scope ${scope.key}`,
          ),
        });
        continue;
      }
      const pure = createPure(registry, reconciler, {
        owned: owned.get(scope.key) ?? [],
        answers,
        decisions,
        tracked,
      });
      try {
        results.set(scope.key, {
          desired: reconciler.reconcile(inputs.get(scope.key), pure),
          error: null,
        });
      } catch (error) {
        results.set(scope.key, { desired: null, error });
      }
      for (const [text, request] of tracked.answers)
        if (!answers.has(text)) {
          const wanted = wantedAnswers.get(text) ?? {
            ...request,
            scopes: new Set<string>(),
          };
          wanted.scopes.add(scope.key);
          wantedAnswers.set(text, wanted);
        }
      for (const subject of tracked.subjects)
        if (!loadedSubjects.has(subject)) {
          const wanted = wantedSubjects.get(subject) ?? new Set<string>();
          wanted.add(scope.key);
          wantedSubjects.set(subject, wanted);
        }
    }
    if (!wantedAnswers.size && !wantedSubjects.size) break;
    if (round + 1 >= MAX_ROUNDS) {
      for (const scope of scopes)
        results.set(scope.key, {
          desired: null,
          error: new KernelContractError(
            `Reconciler ${reconciler.scope} kept requesting new inputs after ${MAX_ROUNDS} rounds`,
          ),
        });
      break;
    }
    await Promise.all([
      loadAnswers(q, wantedAnswers, answers, ledger, revisions),
      loadDecisions(
        q,
        wantedSubjects,
        decisions,
        loadedSubjects,
        ledger,
        revisions,
      ),
    ]);
  }

  const patched = await loadPatched(q, [...results.values()]);
  const durationMs = performance.now() - started;
  return Promise.all(
    scopes.map(async (scope): Promise<Computed> => {
      const result = results.get(scope.key)!;
      const tracked = usedBy.get(scope.key)!;
      const keys = ledger.of(scope.key);
      const missing: MissingAnswer[] = [];
      const used: UsedAnswer[] = [];
      for (const [text, request] of tracked.answers) {
        const known = answers.get(text);
        if (!known) continue;
        if (known.output === null)
          missing.push({ ...request, inputHash: known.inputHash });
        else used.push({ kind: request.kind, inputHash: known.inputHash });
      }
      const decided = [...tracked.subjects].flatMap((subject) =>
        (decisions.get(subject) ?? []).map((row) => ({ subject, id: row.id })),
      );
      return {
        scope,
        reconciler,
        keys,
        desired: result.desired,
        error: result.error,
        owned: owned.get(scope.key) ?? [],
        storedBindings: storedBindings.get(scope.key) ?? [],
        facts: ledger.factsOf(scope.key),
        patched,
        missing,
        answers: used,
        decisions: decided,
        inputsHash: await hashCanonical(
          [...keys].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ),
        durationMs,
      };
    }),
  );
}

function failed(
  scope: ScopeRef,
  reconciler: Reconciler,
  error: unknown,
  durationMs: number,
): Computed {
  return {
    scope,
    reconciler,
    keys: new Map(),
    desired: null,
    error,
    owned: [],
    storedBindings: [],
    facts: [],
    patched: new Map(),
    missing: [],
    answers: [],
    decisions: [],
    inputsHash: "",
    durationMs,
  };
}

/** The stored rows a batch's patches target, read before the apply compares them. */
async function loadPatched(
  q: Q,
  results: readonly { desired: Desired | null }[],
): Promise<Map<string, Map<string, ColumnValues>>> {
  const byTable = new Map<string, { target: ColumnRef; ids: Set<string> }>();
  for (const result of results)
    for (const patch of result.desired?.patches ?? []) {
      const entry = byTable.get(patch.target.name) ?? {
        target: patch.target,
        ids: new Set<string>(),
      };
      entry.ids.add(patch.id);
      byTable.set(patch.target.name, entry);
    }
  const patched = new Map<string, Map<string, ColumnValues>>();
  await Promise.all(
    [...byTable].map(async ([name, { target, ids }]) => {
      const rows: ColumnValues[] = await q
        .select()
        .from(target.table)
        .where(inArray(idColumn(target.table), [...ids]));
      patched.set(name, new Map(rows.map((row) => [String(row.id), row])));
    }),
  );
  return patched;
}

async function loadAnswers(
  q: Q,
  wanted: ReadonlyMap<
    string,
    { kind: AskKind; envelope: AskEnvelope; scopes: Set<string> }
  >,
  answers: Map<string, { inputHash: string; output: Json | null }>,
  ledger: KeyLedger,
  revisions: (keys: readonly Key[]) => Promise<Map<Key, number>>,
) {
  if (!wanted.size) return;
  const hashed = await Promise.all(
    [...wanted].map(async ([text, request]) => ({
      text,
      request,
      inputHash: await inputHashOf(request.envelope),
    })),
  );
  const keys = hashed.map((entry) => answerKey(entry.inputHash));
  const revs = await revisions(keys);
  const rows = await q
    .select({ inputHash: answer.inputHash, output: answer.output })
    .from(answer)
    .where(
      inArray(
        answer.inputHash,
        hashed.map((entry) => entry.inputHash),
      ),
    );
  const found = new Map(rows.map((row) => [row.inputHash, row.output]));
  for (const entry of hashed) {
    answers.set(entry.text, {
      inputHash: entry.inputHash,
      output: found.get(entry.inputHash) ?? null,
    });
    for (const scope of entry.request.scopes)
      ledger.record(scope, revs, [answerKey(entry.inputHash)]);
  }
}

async function loadDecisions(
  q: Q,
  wanted: ReadonlyMap<string, Set<string>>,
  decisions: Map<string, DecisionRow[]>,
  loaded: Set<string>,
  ledger: KeyLedger,
  revisions: (keys: readonly Key[]) => Promise<Map<Key, number>>,
) {
  if (!wanted.size) return;
  const subjects = [...wanted.keys()];
  const revs = await revisions(subjects.map(decisionKey));
  // The newest row per (subject, channel, slot) is in force; an identity
  // decision is stored once under its first subject and read from both.
  // The text column is not named `at`: ORDER BY would sort by it instead of
  // the microsecond column.
  const result = await q.execute<
    Omit<DecisionRow, "at"> & { other: string | null; atText: string }
  >(sql`
    SELECT DISTINCT ON (d.subject, d.channel, d.slot)
      d.id, d.channel, d.subject, d.slot, d.other, d.kind, d.value,
      ${isoText(sql`d.at`)} AS "atText"
    FROM "Decision" d
    WHERE d.subject = ANY(${textArrayParam(subjects)}) OR d.other = ANY(${textArrayParam(subjects)})
    ORDER BY d.subject, d.channel, d.slot, d.at DESC, d.id DESC`);
  for (const subject of subjects) {
    loaded.add(subject);
    decisions.set(subject, []);
  }
  for (const { atText, ...rest } of result.rows) {
    const row = { ...rest, at: atText };
    if (decisions.has(row.subject)) decisions.get(row.subject)!.push(row);
    if (row.other && decisions.has(row.other))
      decisions
        .get(row.other)!
        .push({ ...row, subject: row.other, slot: row.subject });
  }
  for (const [subject, scopes] of wanted)
    for (const scope of scopes)
      ledger.record(scope, revs, [decisionKey(subject)]);
}

async function loadOwned(
  q: Q,
  reconciler: Reconciler,
  scopes: readonly ScopeRef[],
): Promise<Map<string, OwnedRecord[]>> {
  const owned = new Map<string, OwnedRecord[]>();
  const targets = reconciler.writes.filter(
    (ref) => ref.name !== bindingWrites.name,
  );
  if (!targets.length || !scopes.length) return owned;
  const byEntity = new Map(
    targets.map((target) => [recordEntity(target), target]),
  );
  const keys = await q
    .select()
    .from(recordKey)
    .where(
      and(
        sql`${recordKey.scopeKind} = ${reconciler.scope}`,
        inArray(
          recordKey.scopeKey,
          scopes.map((scope) => scope.key),
        ),
        inArray(recordKey.entity, [...byEntity.keys()]),
      ),
    );
  const storedByTable = new Map<string, Map<string, ColumnValues>>();
  await Promise.all(
    targets.map(async (target) => {
      const ids = keys
        .filter((row) => row.entity === recordEntity(target))
        .map((row) => row.entityId);
      const rows: ColumnValues[] = ids.length
        ? await q
            .select()
            .from(target.table)
            .where(inArray(idColumn(target.table), ids))
        : [];
      storedByTable.set(
        target.name,
        new Map(rows.map((row) => [String(row.id), row])),
      );
    }),
  );
  for (const row of keys) {
    const target = byEntity.get(row.entity)!;
    const list = owned.get(row.scopeKey) ?? [];
    list.push({
      target,
      naturalKey: row.naturalKey,
      entityId: row.entityId,
      minted: row.minted,
      rejected: row.rejectedAt !== null,
      stored: storedByTable.get(target.name)?.get(row.entityId) ?? null,
    });
    owned.set(row.scopeKey, list);
  }
  return owned;
}

async function loadStoredBindings(
  q: Q,
  reconciler: Reconciler,
  scopes: readonly ScopeRef[],
): Promise<Map<string, Binding[]>> {
  const stored = new Map<string, Binding[]>();
  if (!reconciler.writes.some((ref) => ref.name === bindingWrites.name))
    return stored;
  const rows = await q
    .select()
    .from(evidenceBinding)
    .where(
      and(
        sql`${evidenceBinding.scopeKind} = ${reconciler.scope}`,
        inArray(
          evidenceBinding.scopeKey,
          scopes.map((scope) => scope.key),
        ),
      ),
    );
  for (const row of rows) {
    const list = stored.get(row.scopeKey) ?? [];
    list.push({
      fact: { kind: row.factKind, id: row.factId },
      eventKey: row.eventKey,
      basis: row.basis,
      scope: { kind: row.scopeKind, key: row.scopeKey },
    });
    stored.set(row.scopeKey, list);
  }
  return stored;
}

const askActor = (kind: AskKind): KernelActor =>
  kind.producer === "source" ? sourceActor(kind.label) : "cubby";

/** The pure context for one scope's reconcile run. */
function createPure(
  registry: KernelRegistry,
  reconciler: Reconciler,
  state: {
    owned: readonly OwnedRecord[];
    answers: ReadonlyMap<string, { inputHash: string; output: Json | null }>;
    decisions: ReadonlyMap<string, readonly DecisionRow[]>;
    tracked: Tracked;
  },
): Pure {
  const records: DesiredRecord[] = [];
  const patches: Desired["patches"][number][] = [];
  const retired: Desired["retired"][number][] = [];
  const bindings: Desired["bindings"][number][] = [];
  const merges: Desired["merges"][number][] = [];
  const emits: ScopeRef[] = [];
  const gaps: KernelGap[] = [];
  const asks: Desired["asks"][number][] = [];
  const declaredAsks = new Set(reconciler.asks.map((kind) => kind.feature));
  const declaredWrites = new Map(
    reconciler.writes.map((ref) => [ref.name, ref]),
  );
  const writesBindings = declaredWrites.has(bindingWrites.name);
  const rejected = new Set(
    state.owned
      .filter((record) => record.rejected)
      .map((record) => `${record.target.name}\u0000${record.naturalKey}`),
  );

  const requireTarget = (target: ColumnRef) => {
    const declared = declaredWrites.get(target.name);
    if (!declared)
      throw new KernelContractError(
        `Reconciler ${reconciler.scope} writes undeclared table ${target.name}`,
      );
    return declared;
  };
  const gap = (
    kind: KernelGap["kind"],
    input: string,
    actor: KernelActor,
    options: {
      since?: Date | null;
      until?: Date | null;
      actions?: readonly KernelGap["actions"][number][];
      inputHash?: string | null;
    } = {},
  ) =>
    gaps.push({
      kind,
      input,
      actor,
      since: options.since?.toISOString() ?? null,
      until: options.until?.toISOString() ?? null,
      actions: [...(options.actions ?? [])],
      inputHash: options.inputHash ?? null,
    });

  const inForce = (
    rows: readonly DecisionRow[],
    channel: string,
    slot: string | null,
  ): DecisionInForce | null => {
    if (channel === "veto") {
      const prefix = `${slot ?? ""}${VETO_SEPARATOR}`;
      const vetoes = rows.filter(
        (row) =>
          row.channel === "veto" &&
          row.slot.startsWith(prefix) &&
          row.kind === "veto",
      );
      if (!vetoes.length) return null;
      const newest = vetoes.reduce((a, b) => (a.at >= b.at ? a : b));
      return {
        id: newest.id,
        kind: "veto",
        value: null,
        values: vetoes.map((row) => row.value),
        at: new Date(newest.at),
      };
    }
    const row = rows.find(
      (candidate) =>
        candidate.channel === channel && candidate.slot === (slot ?? ""),
    );
    if (!row || row.kind === "release") return null;
    return {
      id: row.id,
      // SAFETY: the column's CHECK holds this value to the decision kinds.
      kind: row.kind as DecisionInForce["kind"],
      value: row.value,
      values: [],
      at: new Date(row.at),
    };
  };

  return {
    answer(kind, input) {
      if (!declaredAsks.has(kind.feature))
        throw new KernelContractError(
          `Reconciler ${reconciler.scope} reads undeclared ask ${kind.feature}`,
        );
      const untyped: AskKind = kind;
      const envelope = askEnvelope(untyped, input);
      const text = envelopeText(envelope);
      state.tracked.answers.set(text, { kind: untyped, envelope });
      const known = state.answers.get(text);
      if (known && known.output !== null)
        return {
          status: "answered",
          output: kind.output.parse(known.output),
          inputHash: known.inputHash,
        };
      if (known)
        gap("answer", untyped.label, askActor(untyped), {
          inputHash: known.inputHash,
        });
      asks.push({ kind: untyped, input });
      return { status: "missing", inputHash: null };
    },
    decision(channel, subject, slot) {
      state.tracked.subjects.add(subject);
      return inForce(state.decisions.get(subject) ?? [], channel, slot ?? null);
    },
    existing(target) {
      const declared = requireTarget(target);
      return state.owned
        .filter(
          (record) => record.target.name === declared.name && !record.rejected,
        )
        .map((record) => record.naturalKey);
    },
    recordId(target, naturalKey) {
      const declared = requireTarget(target);
      return (
        state.owned.find(
          (record) =>
            record.target.name === declared.name &&
            record.naturalKey === naturalKey,
        )?.entityId ?? null
      );
    },
    patch(target, id, values) {
      const declared = requireTarget(target);
      for (const column of Object.keys(values))
        if (!declared.columns.includes(column))
          throw new KernelContractError(
            `Reconciler ${reconciler.scope} writes undeclared column ${declared.name}.${column}`,
          );
      patches.push({ target: declared, id, values: { ...values } });
    },
    record(target, naturalKey, values, options) {
      const declared = requireTarget(target);
      for (const column of Object.keys(values))
        if (!declared.columns.includes(column))
          throw new KernelContractError(
            `Reconciler ${reconciler.scope} writes undeclared column ${declared.name}.${column}`,
          );
      // A rejected record is not created again when its evidence returns.
      if (rejected.has(`${declared.name}\u0000${naturalKey}`)) return;
      records.push({
        target: declared,
        naturalKey,
        values: { ...values },
        provenance: { ...options?.provenance },
      });
    },
    retire(target, naturalKey, disposition) {
      retired.push({ target: requireTarget(target), naturalKey, disposition });
    },
    bind(fact, eventKey, basis = "proven") {
      if (!writesBindings)
        throw new KernelContractError(
          `Reconciler ${reconciler.scope} binds evidence without declaring bindingWrites`,
        );
      bindings.push({ fact, eventKey, basis });
    },
    merge(target, survivor, absorbed, basis) {
      const declared = requireTarget(target);
      if (!declared.merge)
        throw new KernelContractError(
          `${declared.name} declares no merge policy for reconciler ${reconciler.scope}`,
        );
      merges.push({ target: declared, survivor, absorbed, basis });
    },
    emit(scope) {
      registry.laneOf(scope.kind);
      emits.push(scope);
    },
    gap: {
      evidence: (input, actor, options) =>
        gap("evidence", input, actor, options),
      answer: (input, actor, options) => gap("answer", input, actor, options),
      decision: (input, options) => gap("decision", input, "you", options),
      time: (input, until, options) =>
        gap("time", input, "time", { ...options, until }),
      unsupported: (input, options) =>
        gap("unsupported", input, "you", options),
    },
    done: () => ({
      records,
      patches,
      retired,
      bindings,
      merges,
      emits,
      gaps,
      asks,
    }),
  };
}
