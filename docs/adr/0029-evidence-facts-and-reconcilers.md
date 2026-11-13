# ADR 0029: Records are reconciled from evidence, answers and decisions

Status: Accepted by the owner 2026-11-12. Supersedes items 3 and 5 of
[ADR 0025](0025-radical-simplification-of-background-work.md) and item 2 of
[ADR 0028](0028-cubby-acts-first.md). Items 1, 2, 4 and 6 to 11 of ADR 0025, the
rest of ADR 0028 and all of
[ADR 0026](0026-source-occurrence-and-accepted-evidence.md) stay in force.

## Context

Booking a statement charge decided identity, candidate uniqueness, receipt
matching, classification, ownership and money inside one serializable
transaction. Statement import and Mail import each created spending, and a
convergence policy stopped them double counting. Six tables each carried their
own lease, attempt and backoff columns. No layer owned concurrency, so each
domain added a lock when production showed contention: 55 serializable sites
and about 51 advisory-lock sites. A record's progress was spread over the Run
that held it, a Suggestion and several status fields, in about 18 vocabularies,
and Cubby's automatic work showed no per-record stage.

The owner's direction: evidence may arrive in any order and each piece creates
what it can prove; Cubby keeps re-deriving everything it computed; a member's
decision is an input the derivation respects, never a freeze; every record
shows all of its machinery.

## Decision

### 1. Three append-only inputs

1. **Evidence** is what a source said: statement rows, Emails, photos, vendor
   exports, shipment captures, and records a member typed in. Evidence tables
   are insert-only. A correction or withdrawal is a new evidence row.
2. **Answers** are what a producer computed from a declared input: a model, an
   embedding, an image job or a source fetch. `Answer` is keyed by `inputHash`,
   the hash of the declared input and the ask's `promptVersion`, and nothing
   else. The prompt builder can read only the declared input.
3. **Decisions** are what a member or agent said. `Decision` holds
   `(subject, field, kind, value, actor, at)`. Kinds: `set`, `none`,
   `release`, `veto`, `same`, `distinct`, `reject`. The newest decision for a
   subject and field is in force. `release` hands the field or record back to
   the derivation.

Authority comes from provenance: a value that came from an Answer is Cubby's,
and a value that came from a Decision is a person's. `AuditLog.authority`,
`AuditLog.automationPending` and `fieldAuthority` go.

### 2. Reconcilers write the reconciled tables

A reconciler owns one kind of scope. For one scope it loads its inputs through
keyed reads, runs a pure function that returns the records that should exist
and the gaps that remain, and the kernel applies the difference to what is
stored in one short transaction.

| Scope           | Lane    | Reads                                            | Writes                                       |
| --------------- | ------- | ------------------------------------------------ | -------------------------------------------- |
| `bankEvent`     | money   | source occurrence observations, account          | FinancialTransaction                         |
| `paymentMatch`  | money   | payment atoms by amount, order and tender        | evidence-to-event bindings                   |
| `purchaseEvent` | money   | evidence bound to one event                      | Purchase, Expense, allocations, attributions |
| `transferPair`  | money   | bank events that may be one transfer             | LedgerTransfer                               |
| `shipment`      | catalog | shipment captures and observations               | Shipment                                     |
| `emailState`    | catalog | Email, order mail, bindings                      | Email relevance and link fields              |
| `fields`        | catalog | one record of an entity that declares AI fill-in | that record's `apply: "auto"` fields         |
| `quality`       | catalog | one record's declared quality checks             | nothing; its output is gaps                  |

Only the kernel's apply step writes a table a reconciler owns. Repositories,
commands, imports and MCP tools write evidence and decisions. The repository
boundary rejects a direct write to a reconciled table or field.

Adding a scope kind needs a measured reason. One reconciler per derived field
is ADR 0021's engine again and is not allowed; derived values stay views,
typed snapshots and the hourly pass (ADR 0025 item 4).

Recipes, Meals, Tasks, Projects, Locations, garden records and Inventory counts
are authored. They stay plain writes with no reconciler.

### 3. The kernel API

```ts
defineEvidence<T>(spec: { kind: string; table: PgTable; keys(row: T): Key[] }): EvidenceKind<T>;

defineAsk<I, O>(spec: {
  feature: string;
  producer: "model" | "embedding" | "image" | "source";
  promptVersion: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
}): AskKind<I, O>;

defineReconciler<In>(spec: {
  scope: string;
  lane: "money" | "catalog";
  version: number;
  after?: string[];
  load(reads: Reads, keys: readonly string[]): Promise<Map<string, In>>;
  reconcile(input: In, c: Pure): Desired;
}): Reconciler;

defineModule(spec: {
  entities: EntityDefinition[];
  edges: EdgeDefinition[];
  evidence: EvidenceKind<unknown>[];
  asks: AskKind<unknown, unknown>[];
  reconcilers: Reconciler[];
}): DomainModule;

append(db: Db, rows: EvidenceRow[], o?: { runId?: RunId }): Promise<FactRef[]>;
decide(db: Db, actor: Actor, decisions: DecisionInput[]): Promise<DecisionRef[]>;
reconcileNow(db: Db, scopes: ScopeRef[], o?: { waitMs?: number }): Promise<Outcome[]>;
machinery(db: Db, ref: EntityRef, o?: { field?: string }): Promise<Machinery>;
```

`load` takes every key of a batch and issues a fixed number of statements for
the batch. Each read through `Reads` records its key, including a read that
returns no rows. `reconcile` has no database, clock or network access. Inside
it, `c.answer(kind, input)` returns the Answer or `Missing`, and `Missing`
files an Ask; `c.decision(subject, field)` returns the decision in force;
`c.record(entity, naturalKey, values)` declares a desired record;
`c.bind(fact, event)` binds evidence to an event; `c.gap.evidence`,
`c.gap.answer`, `c.gap.decision` and `c.gap.time` declare what is missing and
who supplies it. `after` declares the scope order; the generator rejects a
cycle.

### 4. Kernel tables

| Table             | Holds                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `Decision`        | Member and agent decisions.                                                                                         |
| `Answer`          | One producer result per `inputHash`, with model, tier, cost and the raw response.                                   |
| `Ask`             | One owed producer call per `inputHash`: state, claim, attempts, `availableAt`, last raw error.                      |
| `AskScope`        | Which scopes wait on which ask.                                                                                     |
| `FactKey`         | The keys each evidence, answer or decision row is read by.                                                          |
| `ScopeDirty`      | One row per scope that must run: lane, sequence, reason, claim, attempts, `availableAt`.                            |
| `ScopeDep`        | The keys a scope read on its last run.                                                                              |
| `ScopeState`      | The last outcome per scope: reconciler version, revision, gaps, stage, next actor, duration, error, `reconciledAt`. |
| `RecordKey`       | `(scope, naturalKey) → entityId`, with `aliasOf` after a merge.                                                     |
| `EvidenceBinding` | Which evidence belongs to which purchase event, and on what basis.                                                  |

`ScopeDirty` can never hold more rows than there are scopes. A new fact inserts
its `FactKey` rows and upserts `ScopeDirty` for every scope whose `ScopeDep`
holds one of those keys, in the statement that inserts the fact.

Answers, asks and decisions live in Neon. Durable Object SQLite holds only what
can be rebuilt or fetched again (ADR 0025 item 1).

### 5. One write gate, one claim

Every transaction that writes a money-lane table first takes
`pg_advisory_xact_lock(HOUSEHOLD_WRITE)` and runs at read committed. This is
the only advisory lock in the server, and there are no serializable
transactions. Loading, matching, planning and producer calls happen before the
transaction opens. The apply compares each scope's `ScopeState.revision` with
the one it loaded; a changed revision leaves the scope dirty and writes
nothing. Background money applies yield the gate after 1.5 seconds. A member's
write sets `lock_timeout` to 2 seconds and reports a timeout as a retryable
wait.

Catalog scopes take no gate. Their apply is a compare-and-set on the record's
revision.

Evidence appends and decision inserts take no gate. Unique constraints on
source identity decide a race between two writers of the same evidence.

One module owns claiming for both `ScopeDirty` and `Ask`: a claim token, a
deadline, an attempt count, `availableAt` backoff and the single failure
classifier. A claim that outlives its deadline cannot publish. The `Job`
table, `AiEvaluation` and `AiEvaluationRequest`, the embedding scheduling
columns, `ImageProcessingAttempt`, `DerivedRebuild`, `WorkItem`,
`WorkPublication`, `CoordinatorTurn` and the drains go. Queue permits and the
hourly cron stay as the wake and the backstop (ADR 0025 item 2).

A source fetch (a mailbox page, a statement file parse, device image work) is
an Ask with `producer: "source"` or `"image"` whose result is appended as
evidence. The device wire for image work keeps its shape.

### 6. Paid producer calls

An Ask moves `queued → sent → answered`, or to `unknown`. The row is marked
`sent` in Neon before the request leaves. The response-cache Durable Object is
the single in-flight point for every producer call on every transport,
including ChatGPT-plan traffic: it holds the claim for an `inputHash`, sends
the request itself, and stores the response before any caller sees it. The
egress and plan objects keep funding admission (ADR 0027).

A `sent` ask whose claim lapses without a stored response becomes `unknown`.
An `unknown` ask is never sent again automatically: it is a gap whose actor is
the member, with the raw situation shown, unless the provider offers an
idempotency key or a result lookup that settles it. Escalation to a higher
tier is a different `inputHash` and pays again by design.

### 7. Identity

A reconciled record's id and shortcode come from `RecordKey` and never from
its contents. New evidence binds to an existing record when identity is
proven; a new id is minted only when no existing record fits. When two records
prove to be one, the older survives and the other becomes an alias that still
resolves. A delete is a `reject` decision: the record is tombstoned and stays
deleted when its evidence arrives again. A record with decisions and no
remaining evidence stays, with an `unsupported` gap.

Ambiguous identity is a gap for the member with `same` and `distinct`
actions. It stays unbooked until decided (ADR 0025 item 6).

### 8. Stage and the machinery read

Stage is not stored on any record. `ScopeState` caches the last computed
stage so lists can sort and filter on it; the reconciler's gaps are the truth.
The first gap decides the stage.

| Stage     | Meaning                                                         |
| --------- | --------------------------------------------------------------- |
| Needs you | The first gap is a decision or an input only a member supplies. |
| Waiting   | The first gap waits on a source, an agent, a queue or time.     |
| Working   | A claim on the scope or one of its asks is live.                |
| Stuck     | Attempts are exhausted, or an ask is `unknown`.                 |
| Done      | No gaps.                                                        |
| Ended     | Rejected, superseded, or out of scope by decision.              |

Actors are `you`, `Cubby`, `an agent`, a named source, and `time`. Member copy
follows one shape: `{Stage} · {waiting|working} for {input} from {actor}`,
then queue position and ETA when the actor is a queue or time. Finer outcomes
(for example an Email's Unrelated or Not imported) stay ordinary filterable
fields.

`machinery(ref, { field? })` returns, from one snapshot:

- `stage`, `nextActor`, `computedAt`, `inputsChangedAt`;
- `gaps[]` in reconciler order, each with a member-facing `input`, `actor`,
  `since`, `actions[]` (decision kinds and write targets),
  `queue { position, of, eta | null, basis }`, `attempts { n, max, nextAt }`
  and `lastError { class, raw }` with the raw text whole;
- `inputs[]` in the order the reconciler used them, each with `kind`
  (evidence, answer, decision, default), `status` (decided, skipped, gap,
  blocked), `source` as a public shortcode, `at`, `by`; answers add `model`,
  `tier`, `costMicros`, `inputHash`, `rawError`; decisions add their kind and
  `supersededBy`;
- `totalCost`, and `{ shown, total }` on every collection, capped at 50.

An ETA is the queue position times the lane's median duration, and is null
when there are too few observations. Labels come from the twin presentation
owners; no client derives a stage or humanizes a key. A batched list projection
supplies stage, actor, first-gap label and ETA for a page of records with no
per-row reads.

Field scope uses the same read and adds the reset preview. "Why this stage"
and "Why this value" are one panel over the field-resolution contract in
[Field resolution and overrides](../entities.md#field-resolution-and-overrides):
`current` and `result` stay, inherit, explicit value and explicit none stay
distinct, precedence stays on the server, and exact reset previews stay. The
one reset action is "Let Cubby decide", which records `release`.

A detail header is three lines: the stage line, the first gap as one sentence
with its action, and a count line that opens the panel. Everything else,
including Cubby's routine work, is in the panel.

Needs you is the set of gaps whose actor is a member. A Run is the set of
facts that carry its `runId`; its page summarizes those scopes. Runs stay as
cost evidence and as the workspace for Sweeps and photo review.

### 9. Changes that would rewrite history

A reconcile triggered by new evidence, a new answer or a decision applies its
difference. A reconcile triggered by a reconciler `version` change or a
`promptVersion` change does not: it records a drift item on the scope with the
exact difference, and for a prompt change the count and cost of the asks it
would issue. A member approves drift by item or by class, and approval applies
it.

At cutover each money scope's stored records are its baseline. Where the
derivation disagrees with the baseline, the scope keeps its stored records and
shows the same drift item.

### 10. Relationships and modules

Each relationship has one `defineEdge` declaration that states its storage,
endpoints, cardinality, inverse, ownership, and delete and merge behavior. The
generator emits the link catalog, edge owners and edge overrides from it.
Money and merge policies stay explicit functions that the declaration names.

A domain is a compile-time module: one `defineModule` per domain folder
registers its entities, edges, evidence kinds, asks and reconcilers. Nothing
loads at runtime.

### 11. Money amounts

`Expense.cost` is stored as integer minor units with its currency, like
Purchase stated totals.

## Consequences

- One purchase event has one spending writer, so the statement-versus-Email
  convergence policy and the batch dependency rules go.
- A wrong rule can no longer silently rewrite past records, and a correct one
  needs an approval to do so.
- Background money work runs one scope batch at a time. An edit to a hub
  record (an account, a Vendor, a category) can dirty thousands of scopes and
  takes minutes to settle; the panel shows the queue.
- A member's edit can wait up to 2 seconds behind a background apply.
- An `unknown` paid call waits for a member rather than risk paying twice.
- A merge can turn one shortcode into an alias of another.
- The dirty queue and the dependency index bring back mark-and-drain. The
  bound on scope kinds in section 2 is what keeps it from growing into the
  engine ADR 0025 removed.

## Rejected

- **Declared pipelines with a stored stage per item.** Same runtime, but each
  domain still writes an imperative apply and declares its dependencies by
  hand, and order-agnostic evidence depends on one planner getting it right.
- **A generated model layer with a unit of work.** It improves how entities
  and edges are written and is adopted for edges (section 10). It does not
  change how money decisions are made.
- **Rules in SQL functions and live views.** Matching policy in PL/pgSQL is
  hard to review and test, and live views over money risk the wide rewrites
  ADR 0021 and ADR 0025 were written to prevent.
- **SQLite in a Durable Object as the household store.** ADR 0025's objections
  stand.
