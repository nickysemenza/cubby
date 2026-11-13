# ADR 0029: Records are reconciled from evidence, answers and decisions

Status: Accepted by the owner 2026-11-12. Supersedes items 3 and 5 of
[ADR 0025](0025-radical-simplification-of-background-work.md), items 2 and 6 of
[ADR 0028](0028-cubby-acts-first.md), the lock protocol of
[ADR 0026](0026-source-occurrence-and-accepted-evidence.md) and the "no alias
read" rule of [ADR 0024](0024-repository-read-declaration.md). It amends item 1
of ADR 0028 for one case (section 9). Everything else in those ADRs stays in
force, including ADR 0026's occurrence, head-selection and proof rules.

Where an older ADR conflicts with this one, this one wins, and the older ADR
is edited or reduced to a stub as [the index](README.md) describes.

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
   exports, shipment captures, and a record a member typed in (a manual
   FinancialTransaction or Purchase is a `manualEntry` evidence row). Evidence
   rows are insert-only. A correction or withdrawal is a new evidence row. A
   table that holds both a source observation and mutable state splits them:
   the observation columns are insert-only and the state columns belong to a
   reconciler (for Email: headers, body and attachments are evidence;
   relevance, link and outcome columns belong to `emailState`).
2. **Answers** are what a producer computed from a declared input: a model, an
   embedding, an image job or a source fetch. `Answer` is keyed by `inputHash`,
   the hash of a canonical envelope: feature, producer, requested tier or model
   policy, output-schema revision, producer parameters (for example embedding
   dimensions), `promptVersion` and the declared input. A funding-route
   substitution keeps the hash; a deliberate tier escalation changes it. A
   source fetch includes its checkpoint or revision in the input, so a later
   poll is a different ask. The prompt builder can read only the declared
   input.
3. **Decisions** are what a member or agent said. `Decision` holds
   `(channel, subject, field, kind, value, actor, at)` in four independent
   channels, each resolved by its newest row:
   - `assignment`, per subject and field: `set`, `none`, `release`;
   - `veto`, per subject, field and value: `veto`, `release`;
   - `identity`, per unordered pair of subjects: `same`, `distinct`, `release`;
   - `rejection`, per record: `reject`, `release`.

   A later assignment never removes a veto, and one identity decision never
   removes another pair's. `release` names the channel it releases.

Authority comes from provenance: a value that came from an Answer is Cubby's,
and a value that came from a Decision is a person's. `AuditLog.authority`,
`AuditLog.automationPending` and `fieldAuthority` go. A decision on a field of
an authored entity is applied by that entity's ordinary writer in the same
transaction.

### 2. Reconcilers write the reconciled tables

A reconciler owns one kind of scope. For one scope it loads its inputs through
keyed reads, runs a pure function that returns the records that should exist
and the gaps that remain, and the kernel applies the difference to what is
stored in one short transaction.

| Scope           | Lane    | Scope key                                        | Owns                                                                                         |
| --------------- | ------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `bankEvent`     | money   | one source occurrence, or one manual transaction | FinancialTransaction                                                                         |
| `paymentMatch`  | money   | one payment key: amount, order number or tender  | `EvidenceBinding`                                                                            |
| `purchaseEvent` | money   | one purchase event id                            | Purchase, Expense, allocations, attributions, and the Vendor and alias a booking must create |
| `transferPair`  | money   | one unordered pair of bank events                | LedgerTransfer                                                                               |
| `shipment`      | catalog | one shipment identity                            | Shipment                                                                                     |
| `emailState`    | catalog | one Email                                        | Email relevance, link and outcome columns                                                    |
| `fields`        | catalog | one record of an entity that declares AI fill-in | that record's `apply: "auto"` columns not owned by another reconciler                        |
| `quality`       | catalog | one record of an entity that declares checks     | nothing; its output is gaps                                                                  |

Each reconciler declares the tables and columns it reads and the tables and
columns it writes. The kernel's registry build, checked by a unit test in CI,
rejects two reconcilers that write one column,
a `fields` scope that claims a column another reconciler owns, and a cycle in
the read-write graph between scope kinds. Only the kernel's apply step writes a
column a reconciler owns; the repository boundary rejects any other write.
Repositories, commands, imports and MCP tools write evidence and decisions.

A reconciled record belongs to exactly one owning scope, recorded in
`RecordKey`. Its desired output carries each record's provenance, its
relationship effects, and an explicit disposition for a record that should no
longer exist (section 9).

Adding a scope kind needs a measured reason. One reconciler per derived field
is ADR 0021's engine again and is not allowed; derived values stay views,
typed snapshots and the hourly pass (ADR 0025 item 4).

A reconciler that must create an authored catalog record declares its initial
values in `writes(..., { createOnly: [...] })`. Those values are supplied only
on insertion, are excluded from column ownership and the read-write graph, and
are never changed on recomputation. Existing catalog writers retain their
authored responsibility. A booking can create a Vendor and its aliases without
claiming the names and aliases of the household's whole Vendor catalog.

Recipes, Meals, Tasks, Projects, Locations, garden records and Inventory counts
are authored. They stay plain writes with no money or state reconciler; an
authored entity that declares AI fill-in has a `fields` scope for those
columns only.

### 3. The kernel API

```ts
defineEvidence<T>(spec: {
  kind: string;
  table: PgTable;
  keys(row: T): Key[];
  discovers(row: T): ScopeRef[];
}): EvidenceKind<T>;

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
  reads: SourceRef[];
  writes: ColumnRef[];
  load(reads: Reads, keys: readonly string[]): Promise<Map<string, In>>;
  reconcile(input: In, c: Pure): Desired;
}): Reconciler;

definePass(spec: {
  name: string;
  key?(input: unknown): string;
  run(db: Db, cursor: Json | null, claim: Claim): Promise<{ cursor: Json | null; done: boolean; availableAt?: Date }>;
}): Pass;

defineModule(spec: {
  entities: EntityDefinition[];
  edges: EdgeDefinition[];
  evidence: EvidenceKind<unknown>[];
  asks: AskKind<unknown, unknown>[];
  reconcilers: Reconciler[];
  passes: Pass[];
}): DomainModule;

append(db: Db, rows: EvidenceRow[], o?: { runId?: RunId }): Promise<FactRef[]>;
decide(db: Db, actor: Actor, decisions: DecisionInput[]): Promise<DecisionRef[]>;
reconcileNow(db: Db, scopes: ScopeRef[], o?: { waitMs?: number }): Promise<Outcome[]>;
machinery(db: Db, viewer: Actor, ref: EntityRef, o?: { field?: string }): Promise<Machinery>;
```

`load` takes every key of a batch and issues a fixed number of statements for
the batch. Apply locks the union of input revisions and dirty claims once,
then writes each table as a set. Identity reservations, RecordKeys, bindings,
audits, dependencies and cached scope outcomes are batch writes. Audit rows
retain their individual scope provenance. A batch is one coherent input
snapshot: its output notifications exclude every completed scope in that
batch and still notify other dependent scopes. Each read through `Reads` records its key, including a read that
returns no rows, and `Reads` reaches only the sources the reconciler declared.
`reconcile` has no database, clock or network access. Inside it,
`c.answer(kind, input)` returns the Answer or `Missing`, and `Missing` files an
Ask; `c.decision(channel, subject, field)` returns the decision in force;
`c.record(entity, naturalKey, values)` declares a desired record;
`c.bind(fact, event)` binds evidence to an event; `c.emit(scopeRef)` starts a
downstream scope; `c.gap.evidence`, `c.gap.answer`, `c.gap.decision` and
`c.gap.time` declare what is missing and who supplies it.

A Catalog target with no owned columns may declare `coalesceCreation(values)`
to combine equal natural keys in the same batch. In canonical scope-key order,
the first new declaration reserves the shared id; every participating scope
keeps a RecordKey to it. Existing RecordKeys always retain their ids. The
coalescer supplies creation values only; member edits remain authored.

`c.record` returns the record's UUID. For an existing `RecordKey` it returns
the retained id; for a new natural key it derives a UUID v8 from the scope
kind, scope key, table and natural key using SHA-256. Contents never enter
that identity. Other records declared in the same reconcile use that UUID as
a foreign key. Apply preserves it, orders inserts by foreign-key dependency,
and commits the reserved entity shortcode inside its transaction. `c.identity`
returns the same id and public shortcode before a record is declared; shortcode
collisions re-run the scope with an unreserved code while retaining its id. A conflicted or failed
apply leaves no identity, shortcode or `RecordKey` reservation. A cycle between
new rows in different tables is refused before any record is inserted.

### 4. Kernel tables

| Table             | Holds                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `Decision`        | Member and agent decisions, by channel.                                                                             |
| `Answer`          | One producer result per `inputHash`: parsed output, model, tier, cost, and the raw response up to 256 KB.           |
| `Ask`             | One owed producer call per `inputHash`: state, claim, attempts, `availableAt`, wait cause, last raw error.          |
| `AskScope`        | Which scopes, and which Run if any, wait on which ask.                                                              |
| `FactKey`         | The keys each evidence, answer, decision or readable authored row is read by.                                       |
| `ScopeDirty`      | One row per scope that must run: lane, `seq`, reason, claim, attempts, `availableAt`.                               |
| `ScopeDep`        | The keys a scope read on its last run.                                                                              |
| `ScopeState`      | The last outcome per scope: reconciler version, gaps, cached stage and next actor, duration, error, `reconciledAt`. |
| `RecordKey`       | `(scope, naturalKey) → entityId`, and a rejected mark.                                                              |
| `EvidenceBinding` | Which evidence belongs to which purchase event, and on what basis (`proven`, `decision`, `baseline`).               |
| `Pass`            | One row per registered pass instance: cursor, claim, attempts, `availableAt`.                                       |
| `Drift`           | One proposal per scope: proposal hash, inputs hash, exact difference, ask count, estimated cost.                    |
| `KeyRev`          | One revision counter per key, the serialization point between mutation and dependency registration.                 |

Answers, asks and decisions live in Neon. Durable Object SQLite holds only what
can be rebuilt or fetched again (ADR 0025 item 1).

### 5. Dirtying and order

Every mutation of an input dirties the scopes it affects in the transaction
that makes it. That covers evidence appends, new answers, decisions, a
reconciler's own applied output, and a write to any authored or catalog column
a reconciler declares in `reads` (the generator adds the key emission to that
entity's writer). The statement inserts the row's `FactKey` rows and upserts
`ScopeDirty`, raising `seq`, for:

- every scope the row `discovers`, which is how a scope starts with no
  `ScopeDep` yet; and
- every scope whose `ScopeDep` holds one of the row's keys.

A scope whose key is itself a fact key (`paymentMatch`) is discovered by that
key.

Registration and mutation serialize per key through `KeyRev(key, rev)`. An
input mutation raises `rev` for each of its keys with an upsert before it reads
`ScopeDep`. A load records the `rev` it saw for every key it read, 0 for a key
with no row. An apply takes the same rows with the same upsert form, which
creates a row for an absent key, and compares each `rev` with the one its load
saw. Because both sides lock the same row, either the apply sees the committed
mutation and leaves the scope dirty, or the mutation sees the committed
`ScopeDep` row and raises `ScopeDirty.seq`.

`ScopeDirty` can never hold more rows than there are scopes. A reconciler's
output never dirties its own scope.

Correctness comes from dirtying, not from order. `after` is a scheduling
preference that avoids rework: the runner does not claim a scope of a kind
while a claimable dirty scope of an upstream kind exists in the same lane. The
graph is `bankEvent → paymentMatch → purchaseEvent`, `bankEvent →
transferPair`, and across lanes `purchaseEvent → emailState`; `shipment`,
`fields` and `quality` have no upstream.

Predicate reads also record a table-membership key. A matching authored or
catalog mutation raises that key, including when the previous predicate read
was empty. Reviewed evidence-association changes replace the affected
`FactKey` entries and raise both the old and the new keys in their transaction.
Raw source observations remain insert-only.

### 6. One write gate, one input fence

Every transaction that writes a money-lane column first takes
`pg_advisory_xact_lock(HOUSEHOLD_WRITE)` and runs at read committed. This is
the only advisory lock in the server, and there are no serializable
transactions. The transaction sets `lock_timeout`, `statement_timeout` and
`idle_in_transaction_session_timeout` with `SET LOCAL`, so Postgres releases
the gate when a Worker dies. Loading, matching, planning and producer calls
happen before the transaction opens.

The fence is `ScopeDirty.seq`. A run reads the scope's `seq` when it claims,
loads and computes outside any transaction, then in the apply transaction
locks the scope's `ScopeDirty` row and compares. A changed `seq` means an input
changed after the load: the apply writes nothing for that scope and it stays
dirty. An unchanged `seq` applies the difference and, in the same transaction,
writes the output, the scope's `ScopeDep` rows and `ScopeState`, verifies the
claim token, and deletes the `ScopeDirty` row only at that `seq`. A mutation
that commits later raises `seq` again and the scope runs again.

Lock order inside an apply is the gate, then the `KeyRev` rows in key order,
then the `ScopeDirty` row, which is the order a mutation takes them in. A
conflict on `seq` or `rev`, a deadlock or a serialization failure does not
count as a failed attempt. After three
conflicts in a row the runner makes an exception to loading outside the
transaction: it takes the gate when the lane is money, locks the dirty row,
then loads, computes and applies in that one bounded transaction. Producer
calls stay outside it.

Catalog scopes use the same fence without the gate. A catalog apply also
compares the target record's revision, so a member's concurrent edit of the
same record wins and the scope reruns.

Background money applies commit after each bounded batch of at most 64 scopes,
before the next batch can take the gate. A batch's set-based writes publish
atomically; session timeouts bound in-flight statements. A member's write
uses a 2 second `lock_timeout` and reports a timeout as a retryable wait.
Evidence appends and decision inserts take no gate; a rejection that invokes
a money entity's deletion policy takes the gate before that policy runs; unique constraints on
source identity decide a race between two writers of the same evidence.

### 7. Three work forms, one claim

Background work is a dirty scope, an Ask or a Pass. One module owns claiming
for all three: a claim token, a deadline with renewal, an attempt count,
`availableAt` backoff, a wait cause, cancellation, and the single failure
classifier. A claim that outlives its deadline cannot publish. Queue permits
and the hourly cron stay as the wake and the backstop (ADR 0025 item 2); the
next wake is the least `availableAt` across the three tables. Commit wakes and
`household.changed` freshness notifications stay with `generic/changes`, and a
kernel apply emits the same change record as any other write.

The `Job` table, `AiEvaluation`, `AiEvaluationRequest`, the embedding
scheduling columns, `ImageProcessingAttempt`, `DerivedRebuild`, `WorkItem`,
`WorkPublication`, `CoordinatorTurn` and the drains go. Each responsibility
they held has this owner:

| Today                                                            | Owner                                                                                                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.execute`: Sweep and maintenance steps, mail discovery pages | A Pass keyed by the Run. Its cursor is the Run's checkpoint; `RunStep` stays as its ledger; the Run's status is its cancellation fence.                                   |
| `purchase.dispatch`, purchase-agent and mail-agent turns         | A Pass keyed by the Run dispatches; each agent turn is a model Ask that Pass waits on. The mail agent's Durable Object keeps its alarms.                                  |
| `run.funding-resume`                                             | No row. An Ask refused for funding waits with cause `funding` until the window ends; a funding reset clears those waits in one statement.                                 |
| Location description refresh                                     | A model Ask read by the Location's `fields` scope.                                                                                                                        |
| Location inventory detection                                     | A model Ask whose result is appended as photo evidence.                                                                                                                   |
| Run summary write and its drain                                  | A model Ask read by the Run's `fields` scope.                                                                                                                             |
| Image metadata extraction, cloud image work                      | Image Asks whose results are appended as Image evidence.                                                                                                                  |
| Device image work                                                | An image Ask a device claims. The wire's `jobId` is the Ask id and `attemptId` is the claim token; renew, release, cancel, result replay and source-revision checks stay. |
| Embedding refresh and cleanup                                    | An embedding Ask per search-document revision, and a `vectorize.sync` Pass that uploads, confirms visibility and deletes, keeping its receipts on `EntityEmbedding`.      |
| AI evaluation drain and requester receipts                       | Model Asks; `AskScope` records the waiting scopes and the requesting Run.                                                                                                 |
| Derived rebuild and the hourly snapshot pass                     | A `derived.snapshot` Pass with a resumable cursor.                                                                                                                        |
| Email purchase discovery                                         | Dirtying: an Email evidence row discovers its `emailState` scope and its `paymentMatch` keys.                                                                             |
| Mailbox discovery                                                | A source Ask per mailbox whose input carries `MailboxCursor`.                                                                                                             |
| `maintenance.purchase-discovery`                                 | A `purchase.discovery` Pass that owns sender-attribution learning, retained-Email import admission and mailbox-discovery admission; `senderAfter` is in its cursor.       |
| Field automation events                                          | `fields` scopes dirtied by keys.                                                                                                                                          |
| Re-asking after a model, prompt or policy revision               | The version sweep (section 11).                                                                                                                                           |
| Stopped-execution reconciliation                                 | Claim expiry in the claim module, and a `runs.reconcile` Pass for Run status.                                                                                             |
| Retention and pruning                                            | A `retention` Pass.                                                                                                                                                       |
| The Needs-you publication                                        | The list projection over `ScopeState` (section 10).                                                                                                                       |
| Calendar invalidation                                            | The post-commit fast path stays; a failed mark persists a `calendar.invalidate` Pass keyed by origin that retries the idempotent `markDirty` call.                        |

Synchronous `reconcileNow` returns one final outcome per requested scope.
Input-fence conflicts that are retried within the call are intermediate results.

### 8. Paid producer calls

An Ask moves `queued → sent → answered`, or to `unknown`. Funding admission
comes first; a refusal or a failure proven to have sent nothing leaves the ask
`queued` with a wait cause. The row is marked `sent` in Neon, in one statement
for a batch, before the request leaves. The `Answer` row is committed in Neon
before the result is applied anywhere; a streamed agent turn may be displayed
as it arrives and is an Answer only when the whole turn is stored.

The response-cache Durable Object is the single in-flight claim for every
producer call on every transport, including ChatGPT-plan traffic and agent
turns: one claim per `inputHash`, renewed by the Worker that makes the call. It
keeps completed responses as a replay cache that can be rebuilt from `Answer`.
The egress and plan objects keep funding admission (ADR 0027).

A `sent` ask whose claim lapses with no `Answer` becomes `unknown`; the claim
module's expiry finds it. An `unknown` ask is never sent again automatically:
it is a gap whose actor is the member, with the raw situation shown, unless
the provider offers an idempotency key or a result lookup that settles it. A
receipt that arrives late may settle the original attempt but never authorizes
an apply against inputs that have since changed.

### 9. Identity, merge and delete

A reconciled record's id and shortcode come from `RecordKey` and never from
its contents. Every record that exists at cutover gets an immutable
`legacy:<uuid>` key. New evidence binds to an existing record when identity is
proven; a new id is minted only when no existing record fits.

Ambiguous identity is a gap for the member with `same` and `distinct`
actions, and stays unbooked until decided (ADR 0025 item 6). When two existing
records prove to be one, the kernel merges them without asking only if the
proof is a unique complete payment match and the record that would be absorbed
was created by Cubby and carries no decision; this is the one case in which
Cubby merges on its own, amending ADR 0028 item 1. Every other case is a gap.

A merge runs the declared merge policy inside the apply transaction: foreign
keys, `EntityLink`, `EntityExternalId`, attachments and collision rules, as
`generic/merge` does today, and search artifacts are retired. The absorbed
record's `RecordKey` rows repoint to the survivor, the older record survives,
and the absorbed id and shortcode keep resolving to the survivor on reads.
Writes addressed to an absorbed id are refused and name the survivor. Audit
and evidence rows keep the identity they were written with. Web, native caches
and MCP resolve through the same function.

A delete is a `reject` decision. It runs the entity's existing transactional
delete policy and search cleanup, and marks the `RecordKey` rejected so the
record is not created again when its evidence returns. A record with decisions
and no remaining evidence stays, with an `unsupported` gap.

Reconcilers resolve retained decision and manual-entry references through
`c.reference(entity, idOrShortcode)`. It follows redirects from the identity
snapshot loaded for the batch, returns the live survivor only for the requested
entity kind, and does not alter the retained input.

### 10. Stage and the machinery read

Stage is not stored on any record. `ScopeState` caches the last computed
stage and next actor so lists can filter and sort on them through declared SQL
projections; the reconciler's gaps are the truth.

A record's scopes are its owning scope, the consumer scopes declared by its
`MachineryCapability.scopes`, its `fields` scope and its `quality` scope, in
that order. Consumer scopes use the input record UUID as their key, so a
source or bank event exposes its gaps before a consumer creates an output.
Machinery deduplicates shared evidence, answers and decisions across scopes. Its stage is the first that applies:

| Stage     | Applies when                                                                   |
| --------- | ------------------------------------------------------------------------------ |
| Ended     | The record is rejected, absorbed, or out of scope by decision.                 |
| Stuck     | A scope or ask has exhausted its attempts, or an ask is `unknown`.             |
| Working   | A claim on one of its scopes or asks is live. Read from the claim, not cached. |
| Needs you | The first gap is a decision or an input only a member supplies.                |
| Waiting   | The first gap waits on a source, an agent, a queue or time.                    |
| Done      | No gaps.                                                                       |

Actors are `you`, `Cubby`, `an agent`, a named source, and `time`. Member copy
follows one shape: `{Stage} · {waiting|working} for {input} from {actor}`,
then queue position and ETA when the actor is a queue or time. Finer outcomes
(for example an Email's Unrelated or Not imported) stay ordinary filterable
fields.

`machinery(viewer, ref, { field? })` returns, from one snapshot:

- `stage`, `nextActor`, `computedAt`, `inputsChangedAt`;
- `gaps[]` in order, each with a member-facing `input`, `actor`, `since`,
  `actions[]` (decision channel, kind and write target),
  `queue { position, of, eta | null, basis }`, `attempts { n, max, nextAt }`
  and `lastError { class, raw }`;
- `inputs[]` in the order the reconciler used them, each with `kind`
  (evidence, answer, decision, default), `status` (decided, skipped, gap,
  blocked), `source` as a public shortcode, `at`, `by`; answers add `model`,
  `tier`, `costMicros`, `inputHash`, `rawError`; decisions add channel, kind
  and `supersededBy`;
- `drift`, when a proposal exists;
- `totalCost`, and `{ shown, total }` on every collection, capped at 50.

Queue position is the item's rank in the order the runner actually claims:
lane, upstream rank, `availableAt`, `seq`. An ETA is that rank times the median
duration of that queue, or `availableAt` for a timer, and is null with too few
observations. Every source is checked against the viewer's access (Email
evidence is viewer-owned); credentials are scrubbed; a raw error is capped at
16 KB and the response at 256 KB. Labels come from the twin presentation
owners; no client derives a stage or humanizes a key.

The capability is declared in the entity's domain module and supplies the
record-to-scope membership, the stage and actor SQL projections for filters
and sorts, and a batched scaffold binding that adds stage, actor, first-gap
label and ETA to a page of records with no per-row reads (ADR 0024).

Field scope uses the same read and adds the reset preview. "Why this stage"
and "Why this value" are one panel over the field-resolution contract in
[Field resolution and overrides](../entities.md#field-resolution-and-overrides):
`current` and `result` stay, inherit, explicit value and explicit none stay
distinct, precedence stays on the server, and exact reset previews stay. The
one reset action is "Let Cubby decide", which records `release` on the
assignment channel.

A detail header is three lines: the stage line, the first gap as one sentence
with its action, and a count line that opens the panel. Everything else,
including Cubby's routine work, is in the panel.

Needs you is the set of gaps whose actor is a member. A Run is the set of
facts and asks that carry its `runId`; its page summarizes those scopes. Runs
stay as cost evidence and as the workspace for Sweeps and photo review.

### 11. Changes that would rewrite history

A version change never dirties a scope. `ScopeDirty` rows come only from input
mutations, so a scope runs under the current rules only when one of its own
inputs changed.

After a deploy that changes a reconciler `version` or a `promptVersion`, a
`version.sweep` Pass visits each scope whose `ScopeState.version` is older. It
computes the desired output from existing answers only and issues no asks.
With no record difference and no missing answer it advances the scope's
version and refreshes its gaps, input provenance and dependencies under the
input revision fence. This metadata refresh creates no dirty work or asks.
Otherwise it writes a `Drift` proposal: the exact difference, the number of
asks the change would issue and their estimated cost. Approval is a decision
bound to the proposal hash, by item or by class; approval applies the
difference and files the asks. A proposal whose inputs hash no longer matches
is recomputed before it can be approved.

At cutover every scope gets `ScopeState` at version 0 and its stored records
enter as inputs: `EvidenceBinding` rows with basis `baseline`, and for each
reconciled value a `set` decision when a person holds it or a legacy Answer
when Cubby does. The derivation treats a baseline binding as fixed, below a
member decision and above automatic matching. The first sweep then proposes
drift wherever the derivation without the baseline disagrees, and approving
that drift releases the baseline for that scope. A scope with no stored
records gets version 0 and an empty baseline.

An input-triggered reconcile also protects accepted baselines. An automatic
difference records a Drift proposal and applies no record changes or new asks.
A field assignment with the current Decision as its provenance may update that
field above the baseline; it does not authorize other automatic differences.
A new record whose supplied values all cite current Decisions may be added to
an accepted scope. Creation authority applies to those immutable decision
values; it does not authorize later changes derived from new observations.
Reference merge and removal policies use `columnOwner` and
`repointOwnedReference` for owned foreign keys. The kernel takes the money
gate for a money-owned reference. Callers take it before acquiring other
record locks. Repointing raises table and row
keys, including for scopes whose earlier predicate found no matching row.
`c.disagree(input)` records unresolved drift when accepted inputs contradict
one another and no automatic replacement is justified. It applies no records
or asks, and approval cannot bypass the unresolved disagreement; evidence or
a decision must first resolve it.

### 12. Cutover migration

One committed migration, applied by the existing CI runner before the new
Worker starts, with no running Worker and no producer call. It succeeds on a
fresh database and on synthetic predecessor data. It:

1. creates the kernel tables;
2. writes `RecordKey`, purchase events and baseline bindings from stored
   records and their existing links;
3. writes `Decision` rows from decided Suggestions, Email purchase decisions
   and reviews, Email financial associations, source-observation annotations,
   purchaser and Expense overrides, manual allocations, and every reconciled
   value a person holds or confirmed;
4. writes `Answer` rows from retained paid results, and `AskScope` rows from
   their requester receipts;
5. carries unfinished work: a queued evaluation becomes a queued Ask; one that
   was sent with no stored result becomes `unknown`, never queued; Run
   checkpoints become Pass cursors; member-started Sweeps and imports in
   progress become Pass rows;
6. verifies preservation row by row and aborts on a mismatch (ADR 0025 item
   9), then drops the tables section 7 retires.

Undecided Suggestions and rebuildable derived state are dropped.

### 13. Relationships and modules

Each relationship has one `defineEdge` declaration that states its storage,
endpoints, cardinality, inverse, ownership, and delete and merge behavior. The
generator emits the link catalog, edge owners and edge overrides from it.
Money and merge policies stay explicit functions that the declaration names.

A domain is a compile-time module: one `defineModule` per domain folder
registers its entities, edges, evidence kinds, asks, reconcilers and passes.
Nothing loads at runtime.

### 14. Money amounts

Expense cost is stored as signed exact minor units in `costMinor`, in USD.
Conversion requires an exactly representable value and refuses any other row.
Original foreign amounts stay in source evidence. Wires, boundaries and
retained fingerprints keep dollar numbers, as
[Money representation](../import-evidence-convergence.md#money-representation)
states for the other settled amounts.

## Consequences

- One purchase event has one spending writer, so the statement-versus-Email
  convergence policy and the batch dependency rules go.
- A rule or prompt change alone never alters a record. A scope that receives
  new evidence or a decision is recomputed whole under the current rules.
- Background money work runs one scope batch at a time. An edit to a hub
  record (an account, a Vendor, a category) can dirty thousands of scopes and
  takes minutes to settle; the panel shows the queue.
- A member's edit can wait up to 2 seconds behind a background apply.
- Every uncached producer call adds two Neon commits, `sent` and the Answer.
- An `unknown` paid call waits for a member rather than risk paying twice.
- A merge can turn one shortcode into a redirect to another.
- The dirty queue and the dependency index bring back mark-and-drain. The
  bound on scope kinds in section 2 is what keeps it from growing into the
  engine ADR 0025 removed.

## Rejected

- **Declared pipelines with a stored stage per item.** Same runtime, but each
  domain still writes an imperative apply and declares its dependencies by
  hand, and order-agnostic evidence depends on one planner getting it right.
- **A generated model layer with a unit of work.** It improves how entities
  and edges are written and is adopted for edges (section 13). It does not
  change how money decisions are made.
- **Rules in SQL functions and live views.** Matching policy in PL/pgSQL is
  hard to review and test, and live views over money risk the wide rewrites
  ADR 0021 and ADR 0025 were written to prevent.
- **SQLite in a Durable Object as the household store.** ADR 0025's objections
  stand.
- **The response-cache object executing every producer call itself.** It would
  need a serializable adapter for every transport, agent turn and device
  dispatch. Holding the claim there and the state in Neon gives the same
  guarantee.
