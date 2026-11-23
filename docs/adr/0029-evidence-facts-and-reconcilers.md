# ADR 0029: Records are reconciled from evidence, answers and decisions

Status: Accepted by the owner 2026-11-12. Supersedes items 3 and 5 of
[ADR 0025](0025-radical-simplification-of-background-work.md), items 2 and 6 of
[ADR 0028](0028-cubby-acts-first.md), the lock protocol of
[ADR 0026](0026-source-occurrence-and-accepted-evidence.md) and the "no alias
read" rule of [ADR 0024](0024-repository-read-declaration.md). It amends item 1
of ADR 0028 for one case (section 9). Everything else in those ADRs stays in
force, including ADR 0026's occurrence, head-selection and proof rules.

The implemented money scopes are `bankEvent`, `purchaseEvent`, `transferPair`
and `emailState`. Purchase events accept statement and Order/Email evidence.
Payment matching is a phase of `purchaseEvent`, not a second binding writer:
payment keys plan bindings and bank/order keys publish money. Order and payment evidence creates matching scopes. Bank publication raises payment keys to invalidate existing consumers without creating matching scopes for amounts that have no order evidence. Bank rows discover transfer pairing only for the transfer kinds that the pairing policy accepts; authored transfer evidence discovers its own scope. `shipment`,
`fields` and the catalog scopes retain their declared owners. Product identity
continues using its existing publication and review path.

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
   relevance, link and outcome columns belong to `emailState`). A system header
   update with the current values is a no-op; changing back to an earlier value
   appends a new observation rather than replaying the older one.

   The traced repository boundary refuses updates, including conflict updates,
   to these observation columns, even inside a kernel apply:

   - `ManualEntry`, `Decision`, `ConnectionCandidateEvidence`,
     `PhotoInventoryEvidence` and `ImageEvidence`: every column.
   - `Answer`: `inputHash`, `feature`, `producer`, `promptVersion`, `output`,
     `model`, `tier`, `costMicros`, `raw`, `createdAt`. The Ask association,
     claim token, executor and Run association are mutable acceptance state.
   - `SourceTransactionRecord`: `factFingerprint`, `batchId`, `source`,
     `rowPosition`, `providerTransactionId`, `providerAccountId`, `providerData`,
     `accountDescriptor`, `statementDate`, `amount`, `providerAmount`, `merchant`,
     `rawDescription`, `sourceCategory`, `providerStatus`, `providerNotes`, `createdAt`.
   - `SourceOccurrence`: `source`, `identityKind`, `identityScope`,
     `providerIdentity`, `physicalImportId`, `physicalPosition`, `createdAt`.
   - `Email`: `provider`, `mailboxId`, `messageId`, `sender`, `subject`,
     `receivedAt`, `threadId`, `checksum`, `createdAt`.

   `SourceTransactionRecord.occurrenceId` is mutable identity attribution owned
   by the occurrence merge path; `deletedAt` is lifecycle state.
   `SourceOccurrence.currentObservationId`, `accountId`, `disposition`,
   `dispositionReason`, `dispositionNote`, `supersededByOccurrenceId`,
   `replacementObservationId`, `withdrawnAt`, `withdrawalImportId`,
   `lastObservedAt`, `acceptedTransactionId`, `reviewState`, `version`,
   `identityProof`, `updatedAt` and `deletedAt` are mutable acceptance and
   lifecycle state owned by the acceptance, identity and reconciliation paths.
   Email classification, status, ownership, history checkpoint and Run association
   are mutable import state; raw retrieved bodies and attachments remain in
   their retained source storage. Image metadata and processing state are mutable;
   the immutable image observations are `ImageEvidence`. The boundary covers
   application SQL on traced pools; migrations and direct database clients
   remain outside that application boundary.

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

| Scope           | Lane    | Scope key                                        | Owns                                                                                                   |
| --------------- | ------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `bankEvent`     | money   | one source occurrence, or one manual transaction | FinancialTransaction                                                                                   |
| `purchaseEvent` | money   | a payment key, bank event, or order identity     | EvidenceBinding, Purchase, Expense, allocations, attributions, and booking-created Vendors and aliases |
| `transferPair`  | money   | one unordered pair of bank events                | LedgerTransfer                                                                                         |
| `shipment`      | catalog | one shipment identity                            | Shipment                                                                                               |
| `emailState`    | money   | one Email                                        | Email relevance and its typed link/outcome snapshot                                                    |
| `fields`        | catalog | one record of an entity that declares AI fill-in | that record's `apply: "auto"` columns not owned by another reconciler                                  |
| `quality`       | catalog | one record of an entity that declares checks     | nothing; its output is gaps                                                                            |

Each reconciler declares the tables and columns it reads and the tables and
columns it writes. The kernel's registry build, checked by a unit test in CI,
rejects two reconcilers that write one column,
a `fields` scope that claims a column another reconciler owns, and a cycle in
the read-write graph between scope kinds. Only the kernel's apply step writes a
column a reconciler owns; the repository boundary rejects any other write.
Repositories, commands, imports and MCP tools write evidence and decisions.

Catalog inference may declare `source.history(table, columns)` for committed
money history. It retains the ordinary read revisions, fences and invalidations,
but introduces no derivation ordering dependency: an inferred Vendor default may
inform a new purchase while committed purchases inform that default. The registry
rejects history reads in a money lane or of Catalog-owned columns. Current-value
sources retain the acyclic read-write rule.

A reconciled record has its identity recorded in `RecordKey`. Multiple bank
occurrences may attach to one accepted transaction without minting or rewriting
it; an unresolved accepted identity remains a gap and retains its stored link. Its desired output carries each record's provenance, its
relationship effects, and an explicit disposition for a record that should no
longer exist (section 9).

An explicit Purchase assignment applies even when an order has no payment
facts. Its order-key reconciliation binds the accepted evidence to the existing
Purchase owner; absent payment evidence never invents a bank movement. Priced
itemization cannot add spending beside an aggregate still owned by another
event. That ownership change requires review before the aggregate is retired.
An unlinked positive-quantity item Expense matching a selected Product, date
and price also requires reviewed correspondence before an order can add spending.
Disposal and reversal quantities are not acquisition candidates.
A held capture can publish its Purchase header and financial review while retaining
all recorded spending. The review proves the member, canonical source identity
and live Purchase owner from the capture and its economic event. Its source claim
tracks the review Run; the immutable capture retains its original Run provenance. Applying a review reuses its proven capture and publishes payment evidence from those bytes. Product and line choices are Decisions, without another source capture. Historical provenance retains the first capture independently of the current accepted head. A source review records which previously accepted captures its selected head supersedes, retaining earlier reviewed supersessions. This choice applies only while the selected capture remains a current source head; later unreviewed captures still participate in conflict detection.
Publishing a review does not advance an accepted source association.
The import commit counts member decision and unsupported gaps as findings;
pending bank evidence stays visible as background settlement work.
When a review attaches an independently recorded Expense, its original event
applies the record Decisions and remains its sole writer. The order keeps an
accepted-record reference and refuses contradictory item facts; it does not mint
a replacement Expense or take over the original event.

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
the batch. Reads issued in the same tick coalesce into one statement per
table, and a row read once serves the rest of the batch. `load` may read
Answers through `reads.answers`, so a scope whose inputs depend on an Answer
reconciles in its first round. Apply reads the union of input revisions and locks the dirty claims once,
then writes each table as a set. Identity reservations, RecordKeys, bindings,
audits, dependencies and cached scope outcomes are batch writes. Kernel publication
alone audits owned column changes; domain receipts describe independent source
operations. Audit rows
retain their individual scope provenance. Derived audit entries use the system
actor and cite their evidence and Decisions; those inputs retain their originating
Run and member authorship. Authored source changes retain their actor and Run.
A batch is one coherent input
snapshot: its output notifications exclude every completed scope in that
batch and still notify other dependent scopes. Each read through `Reads` records its key, including a read that
returns no rows, and `Reads` reaches only the sources the reconciler declared.
A batch-level read records its keys for every scope of the batch, so a scope
reads the rows it owns through `reads.for(key)`. A shared projection over
several scopes is fenced per scope: before it runs, each scope records the keys
of every row the projection can read for it.
`reconcile` has no database, clock or network access. Inside it,
`c.answer(kind, input)` returns the Answer or `Missing`, and `Missing` files an
Ask; `c.decision(channel, subject, field)` returns the decision in force;
`c.identityDecisions(subject)` reads the in-force identity slots under the same
subject revision, including when there are no decisions;
`c.record(entity, naturalKey, values)` declares a desired record;
`c.stored(target, naturalKey)` returns the stored row of a record the scope owns;
`c.bind(fact, event)` binds evidence to an event; `c.emit(scopeRef)` starts a
downstream scope; `c.gap.evidence`, `c.gap.answer`, `c.gap.decision` and
`c.gap.time` declare what is missing and who supplies it.

Saved-field questions share canonical selected-detail reads by entity within
the load batch. Each scope records its own row and roster revisions before
the shared preparation reads data; returned records are matched by public id,
and each field keeps only its policy's basis and resolution context. Preparation
checks stored basis rows as a batch; a missing or changed record contributes no
questions. A changed source is refused by the
publication fence. Text-only choice rosters load identities, labels and ranking facts without
display media. Their candidate cap is applied in SQL after purchase-count and
name ordering, so discarded roster rows never enter the Worker heap. Each question
has its own provider-free input capture;
the actual producer checks the stored row and frozen questions again before
any model transport.
Semantic query embeddings are durable Answers owned by the embedding module.
Provider-free field preparation records each scope's Answer revision before
using its vector; missing vectors become Ask dependencies rather than empty
candidate answers. The query producer runs outside publication transactions.
Read-only Answer lookup never claims work or invokes a provider. An incomplete
empty semantic scan cannot establish that no candidate exists; current matches
remain usable when unrelated corpus work is pending. Stored field envelopes
and the producer's frozen-question check remain unchanged.
Frozen questions compare canonical JSON: JSONB may reorder object keys, while
array order, values and output policy remain part of the fence. A mismatch
declares a pre-send refusal to the produce ledger. The ledger re-queues only
when no transport left during the entire call; an earlier transmission still
leaves the outcome unknown.
Precedent candidates load together per entity under the same declared column
revisions. Each field keeps separate corrected and ordinary candidate sets and
the existing per-parent limit. Precedents rank corrected values first, then
newest update at millisecond precision and record identity, so batching fields
or records cannot reorder tied peers.

A Catalog target with no owned columns may declare `coalesceCreation(values)`
to combine equal natural keys in the same batch. In canonical scope-key order,
the first new declaration reserves the shared id; every participating scope
keeps a RecordKey to it. Existing RecordKeys always retain their ids. The
coalescer supplies creation values only; member edits remain authored.

`c.record` returns the record's UUID. Its `authored` option marks a member-created record as ineligible for a proof merge. For an existing `RecordKey` it returns
the retained id; for a new natural key it derives a UUID v8 from the scope
kind, scope key, table and natural key using SHA-256. Contents never enter
that identity. Other records declared in the same reconcile use that UUID as
a foreign key. Apply preserves it, orders inserts by foreign-key dependency
(one statement per table, in waves within a table that links to its own new
rows, and in row waves when only the tables form a cycle), and commits the reserved entity shortcode inside its transaction. `c.identity`
returns the same id and public shortcode before a record is declared; shortcode
collisions re-run the scope with an unreserved code while retaining its id. A conflicted or failed
apply leaves no identity, shortcode or `RecordKey` reservation. A cycle between
new rows is refused before any record is inserted.

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
| `KeyRev`          | One revision counter per raised key, the serialization point between mutation and dependency registration.          |

Answers, asks and decisions live in Neon. Durable Object SQLite holds only what
can be rebuilt or fetched again (ADR 0025 item 1).

### 5. Dirtying and order

Every mutation of an input dirties the scopes it affects in the transaction
that makes it. That covers evidence appends, new answers, decisions, a
reconciler's own applied output, and a write to any authored or catalog column
a reconciler declares in `reads` (the generator adds the key emission to that
entity's writer; generic removal, detach and merge-repoint writes report their
rows with their values before the write, after taking the gate ahead of their
first row lock). The statement inserts the row's `FactKey` rows and upserts
`ScopeDirty`, raising `seq`, for:

- every scope the row `discovers`, which is how a scope starts with no
  `ScopeDep` yet; and
- every scope whose `ScopeDep` holds one of the row's keys.

A purchase-event payment scope uses the payment fact key itself. Evidence
discovers it directly; its binding output dirties the bank/order scopes that
consume those bindings. There is one EvidenceBinding column owner throughout.

Registration and mutation serialize through `KeyRev(key, rev)` and the
household write gate (section 6). An input mutation raises `rev` for each of
its keys with an upsert, inserting a new key at 1, before it reads
`ScopeDep`. Only a raise writes a `KeyRev` row; a key with no row reads 0
everywhere. A load records the `rev`
it saw for every key it read and reads it in the same statement as the rows,
so both come from one snapshot. A read returns its shared revision map once,
including when no data rows match. An apply admits the gate in one statement,
then reads the revisions of its keys in a later statement of the same
transaction and compares each with the one its load saw. A statement's
snapshot at read committed predates a gate wait inside it, so the read never
shares the gate's statement. Both sides hold the gate: either the mutation
committed before the apply was admitted, and the apply's later read sees its
raise and leaves the scope dirty, or the apply registers its `ScopeDep` rows
and commits before the mutation is admitted, and the mutation sees them and
raises `ScopeDirty.seq`.

`ScopeDirty` can never hold more rows than there are scopes. Implicit output
invalidations never dirty their applying scopes, including writes a delete
policy, repoint or merge makes inside the apply. An own-scope `emit` or an
`emit(scope, { when: "changed" })` schedules a follow-up when a nonempty
difference is published. This includes targets in the applying batch. A
no-op or fully held proposal schedules no such follow-up. Scheduling
advances `seq` before claim settlement, retaining queue age and releasing
applying targets for another fenced turn.
A scope dirtied again by another writer during its run is also released still
dirty.

The fields reconciler requests that follow-up when a written column is a
declared basis of another field. The next turn prepares questions from the
newly stored basis, so applying a category can admit its dependent ingredient
question without an unrelated write or a manual refresh.

Dirtying keeps an already-due scope's earlier `availableAt`, so repeated input
changes cannot move it to the back of the queue. A new input makes a delayed
scope due now, as before; failure settlement still owns backoff. Coalescing
raises `seq` without changing an active claim, so its publication fence still
rejects work computed before the input changed.

Correctness comes from dirtying, not from order. `after` is a scheduling
preference that avoids rework: scope kinds take turns in claim order, money
lane first and upstream kinds first, one batch per turn, continuing after the
kind served last. No kind waits on another's backlog, so upstream work that
keeps arriving cannot hold downstream work back. The
graph is `bankEvent → purchaseEvent → transferPair` and
`purchaseEvent → emailState`; `shipment`, `fields` and `quality` have no upstream.

Predicate reads record declared index membership keys, including empty reads.
Catalog rosters track the declared columns they consume. The registry rejects
a table-wide dependency on any reconciled table. A matching authored or
catalog mutation raises that key, including when the previous predicate read
was empty, and so do an evidence append to a table with declared read
indexes and a Decision insert. A write that moves a row between memberships raises the key it left
and the key it joined. A publication and a repoint derive both from the row
before and after. An authored writer reports after its write, so the kernel
stores each indexed row's membership as `index:<table>` `FactKey` rows, every
writer of the row replaces them, and the stored keys stand for the row before
an authored write. A migration that adds a read index over values a writer can
change, or changes an index's values, rebuilds those rows from the table; an
index over columns set once at insert has no before image to store. A plain
insert into an indexed table outside `append` reports its new rows through the
writer's key emission. Reviewed evidence-association changes
replace the affected `FactKey` entries and raise both the old and the new keys
in their transaction. Raw source observations remain insert-only. Every
change to a record's `RecordKey` ownership (an insert, delete, rejection or
its clearing, a merge, or a move to a surviving scope) raises
`owner:<entity>:<id>`, so a read of a record's owners depends on that key.

A lookup value carries only the columns that select rows. A component every
scope enumerates, such as each live account, belongs in the consumer's filter:
it multiplies `ScopeDep` and `KeyRev` rows without narrowing any read.
`KeyRev` and `ScopeDep` reject the retired `transaction.accountAmount` and
`manualTransaction.accountMerchant` index families, so a Worker built before
their replacement fails instead of registering keys no current writer raises.

### 6. One write gate, one input fence

Every transaction that writes a money-lane column first takes
`pg_advisory_xact_lock(HOUSEHOLD_WRITE)` and runs at read committed. This is
the household write gate. Every other transaction that raises or fences a
`KeyRev` revision or upserts a `ScopeDirty` row holds it too: each kernel
statement that raises a revision or locks a dirty row carries the gate, a
revision fence reads after a statement that admitted it, and a writer that
locks records ahead of its kernel writes takes the gate before them. Transactions that mutate
kernel inputs therefore never interleave their kernel locks, including a member
transaction that decides, reconciles and writes again. Claim partitions use separate short
admission locks shared by Ask and Pass claims; producer calls happen after
those transactions close. Money applies use no serializable transactions. A synchronous reconcile inside a
member transaction returns waiting immediately for a claim held by another
worker; it never sleeps while holding the gate. Every gate entry, including
the gate a kernel statement carries, sets `lock_timeout`, `statement_timeout`,
`idle_in_transaction_session_timeout` and `transaction_timeout` with `SET LOCAL`
when the transaction has none yet, so Postgres releases the gate when a Worker
dies. Loading, matching, planning and producer calls
happen before the transaction opens. The lock timeout stays below the transaction
timeout, including for locked fallback runs, so contention is a retryable lock
wait rather than a terminated session. A nested writer that already holds the
gate retains the outer transaction's timeouts and does not reset its budget.

A locked background fallback tries the gate without waiting before it reads
inside the transaction. Busy admission releases its claim as a conflict,
retains the dirty work and makes it claimable again after a short delay, so a
gate wait cannot consume the budget needed for recomputation and a busy gate
does not drive a recompute loop. Admitted work keeps every revision and sequence fence. Member
work retains its bounded gate wait. A failed locked load settles its original
cause before issuing another query on that transaction.

Standalone background applies group heavy batches into separate transactions.
Scopes that publish the same record or binding stay in one group. Each group
takes the write gate and checks its input revisions and claims before writing.
Within the transaction, publication batches dependency replacement, scope
state, cleared Drift and claim settlement after downstream invalidation.
Unchanged dependency edges stay in place; removed and inserted edges are disjoint.
Claim cleanup still compares the exact claimed sequence and token, including
follow-up work raised by publication. Ask filing removes stale links before
state reads, so active scopes with no missing questions need no Ask-state query;
held baselines retain their links and are always read.

The fence is `ScopeDirty.seq`. A run reads the scope's `seq` when it claims,
loads and computes outside any transaction, then in the apply transaction
locks the scope's `ScopeDirty` row and compares. A changed `seq` means an input
changed after the load: the apply writes nothing for that scope and it stays
dirty. An unchanged `seq` applies the difference and, in the same transaction,
writes the output, the scope's `ScopeDep` rows and `ScopeState`, verifies the
claim token, and deletes the `ScopeDirty` row only at that `seq`. A mutation
that commits later raises `seq` again and the scope runs again.

A member decision that invokes an authored field writer opens `householdWrite`
before inserting its Decisions, so the writer enters with the gate held.

Order inside an apply is the gate, admitted in the transaction's first
statement, then the revision read in a later statement, then the `ScopeDirty`
row lock, then the record rows. A writer that takes the gate
ahead of its row locks takes it as its first lock, and the gate entry refuses a
transaction that already holds a row or advisory lock. A Pass publication, a
member publication and an external Ask settlement take the gate before their
Pass, record or Ask row; a Run transaction locks the Run row before its Pass
row. Money writes read after the gate at read committed, so they see every
writer the gate serialized before them. The gate binds that order: a
transaction holding it may raise revisions after dirty or record locks
without a cycle, because no other kernel writer runs beside it. A
conflict on `seq` or `rev`, a deadlock or a serialization failure does not
count as a failed attempt. After three
conflicts in a row the runner makes an exception to loading outside the
transaction: it discovers the read set, takes the gate,
reads the revisions of the union of input and planned output keys, 0 for an
absent key, then reloads against those revisions, computes and fences the
dirty row in that bounded transaction. A newly needed key, one outside that
union, retries without spending an attempt. Producer calls stay outside it.

Catalog scopes use the same fence and take the gate in the apply
transaction's first statement, with its limits. A catalog apply also
compares the target record's revision, so a member's concurrent edit of the
same record wins and the scope reruns.

Background money applies commit after each bounded batch of at most 64 scopes,
before the next batch can take the gate. A batch's set-based writes publish
atomically; session timeouts bound in-flight statements. Each record update
also compares the columns it sets with the values its load saw, and a changed
value is a conflict; timestamps compare at the millisecond precision a loaded
value carries. A member's write
uses a 2 second `lock_timeout` and reports a lock timeout as a retryable
wait.

The kernel's input writers own the gate for their inputs: evidence appends,
decision inserts and answer inserts take it before they insert, so a writer
never holds a source-identity or decision row while it waits for the gate. A
rejection that invokes a money entity's deletion policy takes the gate before that policy
runs; unique constraints on source identity decide a race between two writers of the same
evidence. A writer that inserts a new record before raising its revisions
takes the gate with that raise; until then it holds only the new row and
key-share locks on the records it references.

### 7. Three work forms, one claim

Background work is a dirty scope, an Ask or a Pass. One module owns claiming
and reads each scope kind's oldest claimable row from the claim index, so the
queue's size does not enter a claim or the next-wake read. The claim module also owns the shared lease protocol
for all three: a claim token, a deadline with renewal, an attempt count,
`availableAt` backoff, a wait cause, cancellation, and the single failure
classifier. Scopes that share a transient failure release their claims and
store the error in one statement under the same claim tokens. They keep their
attempt counts and use their own retry delays. A claim that outlives its
deadline cannot publish. Queue permits
and the hourly cron stay as the wake and the backstop (ADR 0025 item 2); the
next wake is the least `availableAt` across the three tables. Exactly one
future wake is pending, in the single `KernelWake` row: an offer for time T
sends a delayed permit carrying T only when it sets the row's `at` to T, which
it may when the row is empty, already due or later than T. A delivery clears
the row while it still holds its own permit's `at`, runs, and offers the global
next deadline (with the alert minimum) by the same rule, so duplicate and stale
permits end without a successor. The offer is one statement after the caller's
commit, never inside a gated transaction. Immediate commit wakes and device ring
wakes do not touch the row. A delivery whose budget ended with work due sends
an immediate continuation; a drained one that still sees due work offers a
short retry instead. A lost permit costs the time until its `at` passes and
another offer wins, or the hourly cron. Commit wakes and
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

A `kernel.pass.page` trace measures one claim attempt through page execution,
publication and failure settlement. It records the registered pass name, whether
a page was claimed, its completion result and the existing database activity
metrics. It exports no pass key, cursor or source input.

Synchronous `reconcileNow` returns one final outcome per requested scope.
Input-fence conflicts that are retried within the call are intermediate results.

### 8. Paid producer calls

An Ask moves `queued → sent → answered`, or to `unknown`. Funding admission
comes first; a refusal or a failure proven to have sent nothing leaves the ask
`queued` with a wait cause. The row is marked `sent` in Neon, in one statement
for a batch, before the request leaves. The `Answer` row is committed in Neon
before the result is applied anywhere; a streamed agent turn may be displayed
as it arrives and is an Answer only when the whole turn is stored. A failed
response is never an Answer. Every transport, including the agent host's,
records in the produce ledger what it sent and what refused before sending,
so a hosted turn proves unsent the same way.

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

A member may explicitly ask again, accepting that the original call may have
been charged. The same Ask and response-cache identity remain: a retained
answer replays without another call, and a live in-flight claim defers the retry.
Giving up does not erase an unknown outcome or its repeat-charge warning.
Only a member actor may authorize that retry; agents and automatic work cannot.

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
record's `RecordKey` rows repoint to the survivor, the older record survives unless a member decision explicitly names the survivor, and the absorbed scope's remaining child RecordKeys transfer to the surviving scope,
and the absorbed id and shortcode keep resolving to the survivor on reads.
Explicit member merges and implicit Purchase folds use the same kernel merge
operation, including domain-specific metadata and attribution preservation.
Writes addressed to an absorbed id are refused and name the survivor. Audit
and evidence rows keep the identity they were written with. Web, native caches
and MCP resolve through the same function.

A delete is a `reject` decision. It runs the entity's existing transactional
delete policy and search cleanup, and marks the `RecordKey` rejected so the
record is not created again when its evidence returns. Public repository deletion records this rejection even when its policy has already soft-deleted the row. Derivation retirement runs the policy without adding a member rejection. An explicit import can create a replacement Purchase through a record Decision while retaining the rejected identity. Automatic reuse requires the same previously accepted immutable capture and a unique surviving source-owned Expense for every line. It preserves Expense identities and cents and changes only their Purchase assignment; moved, missing, independently owned or ambiguous items remain for review. Background replay does not request this replacement. Repeating the rejection
retains its first timestamp and resolves the same owner and delete policy. Rejecting one row of
evidence removes its record only when no other evidence, merge or allocation
holds the record. A record with decisions
and no remaining evidence stays, with an `unsupported` gap.

Reconcilers resolve retained decision and manual-entry references through
`c.reference(entity, idOrShortcode, { format })` resolves an id by default or a public shortcode when requested. Every batch loads the identity roster, including binding-only consumers. It follows redirects from the identity
snapshot loaded for the batch, returns the live survivor only for the requested
entity kind, and does not alter the retained input.

Member gaps on scopes keyed by a payment or identity pair appear on the public records named by their actions. Needs you, record machinery and list machinery use the same action endpoints even before that scope creates an output.

### 10. Stage and the machinery read

Stage is not stored on any record. `ScopeState` caches the last computed
stage and next actor so lists can filter and sort on them through declared SQL
projections; the reconciler's gaps are the truth.

A record's scopes are its owning scope, the consumer scopes declared by its
`MachineryCapability.scopes`, its `fields` scope and its `quality` scope, in
that order. Consumer scopes use the input record UUID as their key, so a
source or bank event exposes its gaps before a consumer creates an output.
Machinery deduplicates shared evidence, answers and decisions across scopes. Its stage is the first that applies:

| Stage     | Applies when                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------- |
| Ended     | The record is rejected, absorbed, or out of scope by decision.                                            |
| Stuck     | A scope or ask has exhausted its attempts, or an ask is `unknown`.                                        |
| Working   | A claim on one of its scopes or asks is live. Read from the claim, not cached.                            |
| Needs you | The first gap is a decision or an input only a member supplies.                                           |
| Waiting   | The first gap waits on a source, an agent, a queue or time; or a scope is dirty before a gap is computed. |
| Done      | No gaps.                                                                                                  |

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
16 KB and the response at 256 KB. Stored raw errors put the deepest driver
cause before wrapping messages, so a large SQL statement cannot consume the
cap before its SQLSTATE and reason. Labels come from the twin presentation
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

A version change dirties a scope only when filing asks is its whole change, as
below. Otherwise `ScopeDirty` rows come only from input mutations, so a scope
runs under the current rules only when one of its own inputs changed.

After a deploy that changes a reconciler `version` or a `promptVersion`, a
`version.sweep` Pass visits each scope whose `ScopeState.version` is older. It
computes the desired output from existing answers only and issues no asks.
With no record difference and no missing answer it advances the scope's
version and refreshes its gaps, input provenance and dependencies under the
input revision fence. This metadata refresh creates no dirty work or asks.
With no record difference and only missing answers that fill a value no
accepted record holds (asks the reconciler marks `fill`, such as a blank
field's), it dirties the scope, and the scope's normal run files them.
Otherwise it writes a `Drift` proposal: the exact difference, the number of
asks the change would issue and their estimated cost. The scope then carries
the member gap a held apply records, so it reads Needs you until an approval
or a later run replaces its gaps. Each ask costs the
median of the most recent priced Answers for its feature and requested tier,
else its ask kind's declared estimate; a source ask is free. The estimate is
unknown, stored as NULL, when any ask has neither, and it stays outside the
proposal hash. Approval is a decision
bound to the proposal hash, by item or by class. Approval recomputes the scope
with the baseline released and applies the difference and files the asks only
when that computation re-derives the approved hash under the proposal's rules;
otherwise it stores the recomputed proposal, which must be approved again.

The sweep loads and computes a page outside any transaction, then publishes it
with its cursor in the pass's fenced transaction: that transaction admits
the write gate first, then reads the page's input revisions once and writes
its scope states, dependencies and proposals as sets. A scope
whose revisions moved retains its previous version, dependencies and
proposal; one that went dirty retains its version and dependencies.

At cutover every scope gets `ScopeState` at version 0 and its stored records
enter as inputs: `EvidenceBinding` rows with basis `baseline`, and for each
reconciled value a `set` decision when a person holds it or a legacy Answer
when Cubby does. The derivation treats a baseline binding as fixed, below a
member decision and above automatic matching. Accepted order identity requires
an effective binding to its Purchase owner; a captured Purchase pointer alone
is not acceptance. Accepted history retains rejected owners with their deletion status; active linkage requires a live owner. An accepted identity without a captured extraction retains
its source key, owner and checksum with explicitly unreadable evidence, without
reconstructing prices or lines from mutable records. A value Cubby held stands
without an ask while its basis and value are unchanged and no person has
since ruled that value out on another record of the entity, so a
correction's recheck asks again. The first sweep then proposes
drift wherever the derivation without the baseline disagrees, files the asks
for blank fields, and approving that drift releases the baseline for that
scope. A scope with no stored
records gets version 0 and an empty baseline.

An input-triggered reconcile also protects accepted baselines. An automatic
difference records a Drift proposal, computed as approval computes it, and
applies no record changes or new asks. Decision changes still apply above the
baseline, also while the scope has a gap, and are not part of the proposal: a
field assignment on a record or patch whose exact proposed value cites the
current Decision as its provenance, a new record whose supplied values all cite current
Decisions or a member's explicit accept or book Decision for that record, and a decision-basis binding with the decision binding it replaces.
They do not authorize other automatic differences. Creation authority applies
to those immutable decision values; it does not authorize later changes
derived from new observations.
Reference merge and removal policies use `columnOwner` and
`repointOwnedReference` for owned foreign keys. The kernel takes the money
gate for a money-owned reference. Callers take it before acquiring other
record locks. Repointing raises table, row and declared index keys for the
rows before and after it, including for scopes whose earlier predicate found
no matching row.
`c.disagree(input)` records unresolved drift when accepted inputs contradict
one another and no automatic replacement is justified. It applies only the decision changes
above, and files no asks. Its proposal is computed with the baseline in force,
and approval cannot bypass the unresolved disagreement; evidence or a decision
must first resolve it.

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
   their requester receipts; on requester collisions the highest sequence
   wins, including when a prompt change re-keys a queued Ask;
5. carries unfinished work: a queued evaluation becomes a cancelled Ask,
   because its legacy envelope names no current producer, and its record's
   `fields` scope is dirtied so it asks again from current inputs; one for a
   record no scope owns stays cancelled; one that was sent with no stored
   result becomes `unknown`, never queued; Run
   checkpoints become Pass cursors whose `legacyJobs` source receipts survive
   cursor publication and restart; member-started Sweeps and imports in
   progress become Pass rows;
6. verifies preservation row by row and aborts on a mismatch (ADR 0025 item
   9), then drops the tables section 7 retires.

Undecided Suggestions and rebuildable derived state are dropped.

The Order/Email follow-up carries the retained source identities into FactKey,
baseline order/payment bindings and the existing purchase owner. The migration
keeps all six money tables unchanged and verifies retained extraction bytes.
Accepted line-to-record identities become baseline `line-record` decisions;
source snapshots and existing RecordKey natural keys remain intact. An old
payment receives a baseline bank binding only for one complete, unambiguous
stored allocation. A retained payment without a direct observation link keeps
its source-claim and Purchase identity; a direct observation link takes priority.
Unexplained current payment evidence retains recorded settlement as a disagreement.
An explicitly reviewed cost correction carries its unchanged bank associations
as identity Decisions, so a partial settlement survives a corrected total without
enabling new automatic partial-payment matches. Read-back verifies that source
review changes neither the accepted bank allocations nor its exact reviewed spend.
A reviewed split reuses each selected Expense once; additional lines receive their
own identities while retaining the reviewed beneficiary and funder cent totals.
Allocation Decisions load their referenced bank movements and all existing slices
under tracked reads before validating conservation, including newly named movements
that have no stored allocation to the Purchase.
Ambiguity remains visible. Email links, reviews and reviewed
account facts retain their ids, times and payloads in Decision slots. Existing
transfers become authored baseline inputs, never newly inferred transfers.

Import preparation persists immutable `ImportPreparedOrder` and
`ImportPreparedLine` records and the public operation result. It publishes no
money. Commit reads the same stored shape for every preparation, validates the
original target and evidence fingerprints, and only then appends accepted source
facts and member Decisions. Retained preparations need no re-extraction or
internal JSON-handle conversion.

Import preparation and commit take the household gate, then the Run row lock,
then the operation row lock, matching cancellation's lock order. A completed
operation replays before the active-Run check; a new write re-reads ownership,
purpose, Vendor scope and Run status while holding the lock. Commit fingerprints
exclude transport execution context and keep the original operation argument
order. A member's Email/Purchase dismissal remains authoritative across later
source events, Purchase merges and inferred order matches. Link projections
resolve Purchase redirects, require live targets, and keep event-specific pointers
for Emails containing several orders. A later member choice supersedes the
canonical target's pre-merge choices; automatic publishers preserve them. Removed
Email targets detach from retained decisions. A refused commit rolls back its
money and evidence writes together.

An order without a printed order id includes the immutable source kind and
source key in its economic event identity. Distinct originals at one Vendor stay
separate unless payment evidence or a member links them. Request handles never
participate in that identity; the retained receipt section key stays intact.

Preparation line handles identify a request, not source facts. Accepted line
identities use canonical line contents and a duplicate occurrence ordinal, so
replaying the same source with new request handles creates no evidence or
payment duplicates. Commit maps request handles back to accepted line identities.
A merged Vendor's source replay retains the original order key and observation
Vendor identity only when the durable redirect proves the current Vendor is its
survivor. Exact retained observations are reused before appending new evidence.
Member line/default decisions use the stable source event and follow its bank
purchase after convergence. A reviewed `line-record` assignment names the retained Expense; an explicit
`none` creates a new item instead of guessing correspondence. Reviewed removals
use the existing per-record rejection Decision and owned delete policy.
Reviewed record values and attribution weights enter the owning scope as authored
`record` assignments; exact costs and member-selected references retain Decision
provenance. The accepted-line read uses those same correspondence Decisions and active
RecordKeys. Product receipt claims require that live Expense association; raw
unresolved Product bindings alone never become catalog claims. Derived claim
identities retain the UUID version and variant contract.
Accepted-source new Product review shares the original-preparation lookup and
line freeze with source reconciliation. The lookup checks member, source, checksum,
extraction and Vendor identity; the line freeze checks prepared candidates and
explicit distinct-from identities. Ledger-owned or ambiguous item Expenses
require accounting review before Product creation. Product review validates the
complete accepted item roster, including untouched lines and ledger claims,
before both initial application and replay. Other accepted sources use
the same item ownership and contradiction policy. Product-only commit reads back
Purchase and Expense money and ownership, attribution, bank allocations, linked
transactions and transfers in its transaction; any change outside the Product
association rolls back the command. An accepted import retains an explicitly unresolved Product choice as a Run
finding. A held financial conflict retains that work when reviewed accounting
applies. Replay preserves the finding without creating stock.

Retained-original review verifies the owned current preparation and canonical
source family before accepting new evidence. The historical original snapshot
stays unchanged; the current association and audit receipt identify the member's
accepted review. An accepted capture advances only the canonical source cursor
and its current observation pointer. Historical aliases keep their captured bytes
and first-seen identity. A subject-free observation proves retained ownership
through its canonical source family and effective Purchase binding; held or failed
proposals do not advance the accepted association. Prepared import choices and accepted-source Product reviews use the existing
identity resolver, issuer locks and identifier learner before capture. The immutable
capture records the resolved Product bindings. Explicit Product choices can fill
a uniquely matched, unclaimed item roster through record Decisions while keeping
its money unchanged. Ambiguous or source-owned rosters require review before
Product creation. Identified incomplete orders keep
a Purchase header and source/Product identity while missing financial evidence
prevents Expense, stock and bank movement creation. Confirmation dates prefer the
printed household day, then the linked Purchase date, then the retained original
Email receipt day. Receipt-time fallback records its provenance in the Purchase
notes; lifecycle mail supplies no receipt-time order date. Creating a Product for an
already accepted item requires its source review; ordinary replay retains the item
and exposes that decision gap. The accepted-source audit receipt preserves replay
through catalog merges. Observation creation records capture time rather than
transaction-start time, avoiding transaction-wide timestamp ties between
successive snapshots. Verifiable stored accepted originals are promoted with unknown
Run and document provenance left null. Repeated source capture reuses the exact
original extraction and document attachments when it supplies no Product binding
review; internal binding representation does not create another source fact.
A fresh request for the same immutable original reuses its proven Product binding,
including after catalog redirects, while preserving the captured identity. Deleted
identities and contradictory distinct-from evidence require review. Incomplete
orders retain an editable Purchase/Product link without money or quantity; active
identifier claims follow that link, while original source evidence survives its removal.
Orphan suggestions and transactional deletion share the canonical projection of
retained line bindings and immutable capture references, including catalog redirects.

A Product binding review appends its accepted binding snapshot and line
correspondence Decisions while retaining the original extraction. Binding
snapshots reuse payment evidence only for the same member, Vendor, source
identity, order key, checksum and entire extraction. Direct observation links
and retained claim/Purchase links keep their original identities. A retained
subject carries its unchanged frozen payment list across capture revisions;
changed payment facts require their own evidence. Subject-free snapshots with a
different original or extraction cannot inherit that payment evidence. Synchronous settling
includes payment keys from related accepted originals. Across original heads,
complete accounting evidence supplies money while partial lifecycle sources
retain their corroborating bindings; the latest head within each original
still owns that original's evidence.

Original source correspondences retain record
identities and later member overrides; matching against current mutable values
alone cannot undo a member's rename or cost decision.
Explicitly supplemental Expense records use the `supplemental:` natural-key
namespace and remain under their own retained facts or Decisions; they do not
become unexplained lines in the source's itemization comparison. Ordinary manual
spending remains eligible for source correspondence and review. Source changes
still require complete correspondence.

Attachment reuse is fenced by the retained original's checksum. A new original
captures its own attachment bytes even when its part labels match the previous
original; the previous original and its attachments remain unchanged.
Automatic candidate extraction admits only the checksum-bound retained original;
a refreshed capture with a different checksum stays retained without being
silently admitted under the Email's first-observation identity.

Email classification observations retain each change in source or request proof;
consecutive identical publications replay. An observation alone grants no routing
authority: its application marker publishes the effective classification, while
member Decisions retain classification, reason and version precedence. A member
resolution keeps its reviewed checksum; retaining the original Email identity
does not append another prediction at that identity's checksum.
Routing status and retained-content updates do
not append another classifier result. Contradictions against accepted sources stay
independent observations and preserve the accepted original.

Email link history retains superseded receipts and their original producer and
review metadata. Current links follow canonical Purchase identities and preserve
each event pointer, including several events that refer to the same Purchase.
Automatic exact-order links use the shared eligibility policy; amount/date matches
remain suggestions. Superseded extraction events retire automatic links;
member link and dismissal Decisions survive a later extraction.

Email evidence reads, link filters and link state consume the same typed
relationship result after it exists. A pending computation keeps its live
candidate read; it cannot downgrade an already computed exact link to a
suggestion. Current account-owner eligibility still gates both read paths.

Order reads follow only the event's facts, bindings and stored money graph.
Payment matching follows the connected set of payment amounts so all competing
orders and each complete payment set participate. Each scope follows its own
set through its own reads; its charges, Vendor aliases and member allocations
are read by amount, merchant and transaction index keys, a charge a member
chose for its Orders by row, and the owners of the Purchases its Orders name
by owner keys after following merge redirects. An amount scope discovers
Order events through extracted keys and through retained payments linked to an
observation or to the latest capture for its source claim and Purchase. The
claim/Purchase lookup carries that pair's revision even when empty. The event's accepted facts
determine its payment set. Each retained payment binds on its amount scope.
Charge and Order payment review publishes through amount scopes when they
exist. Every planning scope holds its own output during a baseline disagreement.
An Order observation keeps its existing proof owner while that scope can still
route the event through the extracted keys. A new Order proof uses the first
retained payment's amount key when present among those keys, then the first
extracted amount key in lexical order, then the payment order or source key.
Email snapshots fetch only
their originals, decisions, order records and operations. These bounded reads
retain revision fences for empty results and current membership.

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
