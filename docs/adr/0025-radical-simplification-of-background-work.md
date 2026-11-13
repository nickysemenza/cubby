# ADR 0025: Shrink Cubby's machinery in place on Workers and Neon

Status: Accepted by the owner 2026-11-04. Supersedes
[ADR 0015](0015-unified-durable-work-coordination.md) and
[ADR 0021](0021-derived-values.md), and amends
[ADR 0016](0016-shared-assessments-and-feedback.md) and
[ADR 0017](0017-subscription-funded-model-fallback.md). Each superseded mechanism
stays in force until the change that removes it ships.

## Context

In the week ending 2026-11-04, 152 PRs merged (+133k/-58k lines). By a title and
path classification, 79 patched or extended background machinery and 27 changed
something a member would notice. Production showed about 310,000 pending derived
refresh tickets, 60,195 Jobs (85 unfinished) and every open browser tab refetching
about every five seconds. Coordination, derived and AI-opinion tables made up 42
of 121 tables and 542 of 1,565 columns.

Two designers wrote blank-page replacements independently, then attacked each
other's designs against code-level findings. Both then rejected their own
platform. A whole-household SQLite Durable Object cannot cancel or time-bound a
query, keeps the 128 MB isolate limit, and would rewrite tested Postgres money
code. Moving to Render costs about $210 a month at the sizes proposed and strands
existing bindings. Both blank-page schemas lost distinctions that the code showed
were real: Run replay receipts, decisions held only in `AssessmentState`, money
evidence and photo-group decisions.

## Decision

1. **Neon Postgres is the single source of truth for household data.** Durable
   Object SQLite holds only data that can be rebuilt from Neon or fetched again,
   such as USDA releases. It holds no member facts, money, evidence or decisions,
   and no agent-supplied SQL runs against it.
2. **Workers only. Add no paid infrastructure.** No containers or Node processes.
   The scheduler Durable Object goes. Background domain work is woken by the
   Cloudflare Queue and by an hourly cron, which is the timer and the backstop.
   Durable Objects that own their own feature, such as calendar and the mail
   agent, keep their alarms.
3. **Background work has three forms.** Dirty scopes reconcile records, Asks own producer calls
   and retained Answers, and Passes own resumable work. One kernel claim module owns their
   deadlines, attempts, waits and cancellation. Run execution is a Pass keyed by the Run.
   Completed and cancelled Passes are pruned by retention.
   A Run is only a member- or agent-started session worth
   reviewing. Automatic AI evaluation and field refresh create no Run; automatic
   mailbox work keeps one: a `mail_discovery` Run started without a member, with
   each admitted import nested under it as a child Run (`parentRunId`).
   Image processing is owned by
   `ImageProcessingJob`, with the device wire unchanged.
4. **Derived values are views, typed snapshots and one scheduled bulk pass.** No
   per-value tickets, fan-out expansion, publication generations, stages or
   coverage. Background totals and search may lag by up to one hour. A member's
   own edit shows at once, and money and identity commands validate current data
   when they act.
5. **Review is one Suggestion table.** Evaluators are idempotent functions, and
   domain handlers revalidate when a suggestion is applied. Quality and Impact
   scores become plain lists of what is missing. Explicit member decisions,
   including those held only in `AssessmentState`, move to explicit owners before
   the old storage retires.
6. **Money has a canonical source occurrence.** Immutable observations belong to a
   proven occurrence, which owns its judgment, account resolution and explicit
   link to the accepted FinancialTransaction. External references become evidence
   aliases. Identity needs proof, and ambiguous history stays unresolved with its
   money unchanged. This may add tables; the goal is fewer authoritative facts and
   write paths, not fewer tables.
7. **Member-visible features stay, except those the owner removes by name.**
   Removals cover machinery and developer tools. The in-app mail agent stays.
   Amended 2026-11-06: the owner removed the AI smoke-test tab, automatic-rule
   switches (book spending and field additions always apply; attach is
   review-only), the duplicate transaction-transfer connection, "Compare with
   current inputs", tag-propagation suggestions, MCP entity preview cards, the
   Run-types page, the feature-routing harness and readable server-function URLs.
   The entity explorer, schema inspector, graph explorer and path search stay.
   Related records and reset previews stay as generic declarations: any entity
   that declares relatedness signals gets the related-records rail, and every
   resettable field previews its reset through the inheritance declarations. The
   native app keeps its other features; its wire follows the Suggestion rename
   (`assessmentId` becomes `suggestionId`) under a raised minimum write version,
   and unused generated Swift goes.
8. **AI funding stays as ordered pools.** The ChatGPT plan and provider subscriber
   credits come first, then paid API. The accounting around them may be simplified.
9. **Delivery shrinks the live system in place, with direct cutovers.** Relief ships
   first. There is no second application. A reshape of authoritative data is one
   breaking migration with its matching deploy, with no rehearsal, staged rollout
   or dual writers. The migration verifies preservation row by row and aborts the
   deployment on a mismatch.
10. **Proven machinery tables and columns may be dropped without an archive.** A
    table or column qualifies only when a hand trace shows it holds no member
    facts, money, evidence, decisions or unfinished paid or member-requested work.
    Amended 2026-11-06: the drop may ship in the same change that removes its last
    reader and writer, with no Neon snapshot; old requests may fail during the
    cutover. Authoritative tables replaced by a reshape, and the Assessment and
    Feedback ledgers, are retained under an archive name until the owner decides
    otherwise. Amended 2026-11-09: archived Feedback rows are deleted once
    decision-grading no longer reads them (the subset it reads is kept), and completed Passes older than eight days and cancelled Passes older than fourteen days are pruned. Unfinished work and Runs stay as cost evidence.
11. **Entity features are composable capabilities declared in the manifest.** Each
    capability has one owner and brings its own fields, list columns, detail slot,
    filters, MCP output and native presentation, so adopting it means declaring it
    on the entity. This extends the existing declarations rather than replacing
    their shape, and whatever replaces the removed engines is declared this way.

## Consequences

Members lose assessment coverage indicators, weighted scores, replayable AI opinion
history and automatic propagation of historical corrections. They gain a quiet
idle system and an Activity page that says only what needs them or what is stuck.

Workers limits remain a real constraint. Statement and mail work already press
against memory and CPU, and the quality pass alone is estimated at 105 to 540 CPU
seconds, so it must run across several invocations. All compute stays on Workers:
containers and separate Node processes are ruled out. Work that presses these
limits is split across invocations with committed cursors, or pushed down into
set-based SQL.

Stored field envelopes report the latest published value as fresh and idle, even
when source edits are awaiting the next pass. A value's `computedAt` records its
last content change, not the pass heartbeat; Activity and maintenance status expose
the pass's `finishedAt`. This deliberately permits mixed-age display for up to an
hour. Assignments and financial command validation still use current evidence.

Keeping every member feature, the native app and the mail agent limits the
reduction. The estimate is about 90 tables and 10 to 17 percent less production
code, plus large cuts to tests and docs. Going further means cutting product.

## Kept on purpose

These were reviewed for removal and kept. Do not propose cutting them again
without new evidence; low recent write counts do not show that reference data
is unused.

- **Cookbook**: most Recipes cite a cookbook as their source, and the import
  pipeline that fills them stays.
- **CalendarFeed Durable Object**: CalDAV and feed polling read its SQLite
  mirror, so calendar sync runs without waking Neon.
- **Derived snapshots and the hourly pass**: they keep list reads cheap; the pass
  runs as queue-permit pages.
- **Sweeps**: the member-started way to evaluate fields and statement charges.
- **Garden**: seasonal, so it is idle for months at a time.
- **Ledger transfers**: household contribution positions depend on them.
- **The financial evidence stack**: it holds statement history from before the
  Monarch sync.
- **Embeddings and Vectorize**: semantic search and the related-records rail use
  them.
- **The AI response cache**: replays avoid paying again for an identical call,
  including across Pass retries.
- **Funding objects** (`AiGatewayEgress`, `ChatGptPlan`): they admit calls and
  hold provider refusals for the funding ladder in
  [ADR 0027](0027-tier-routed-models-on-a-funding-first-ladder.md).
- **The Hyperdrive stale-read cache** (`HYPERDRIVE_CACHED` with `last_write`):
  close to half of cacheable reads hit it in production.
- **The database freshness socket** (`DatabaseFreshness`): it pushes
  `household.changed` so open pages update without polling.
- **The `product_pair` and `transfer_pair` Suggestion families**: statement review
  and import-time Product matching still use them; their AI producers are gone.
  Re-measure their use before proposing a further cut.

Rejected directions:

- **Splitting the Worker**: there is one application (decision 9), and a split
  does not lift the per-invocation memory and CPU limits that constrain work.
- **A Neon read replica**: Neon stays the single source of truth (decision 1);
  slow reads are fixed by rewriting the query first.
- **Containers or other non-Workers compute**: ruled out by decision 2.
- **Cloudflare Workflows**: the Queue and hourly cron already wake and back stop
  background work (decision 2).
- **Stateless CalDAV over Postgres**: every calendar poll would wake Neon, which
  the CalendarFeed Durable Object avoids.
