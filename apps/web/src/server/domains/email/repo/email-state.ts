import {
  emailImportOutcomeDetail,
  MAIL_IMPORT_GAP_EXECUTOR,
  MAIL_IMPORT_GAP_OUTCOME,
} from "@cubby/schemas/email-fields";
import {
  emailRelationshipResult,
  emailPurchaseFact,
} from "@cubby/schemas/email-relationship-facts";
import { entitySchema } from "@cubby/schemas/entity";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { decisionChannel } from "@cubby/schemas/kernel/stage";
import { sourceActor } from "@cubby/schemas/kernel/stage";
import { mailImportOutcome } from "@cubby/schemas/suggestion";
import { sql, eq, inArray, and, isNull } from "drizzle-orm";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import { entityIdentity } from "~/server/db/entity-identity-schema";
import {
  columnArrayParam,
  textArrayParam,
} from "~/server/db/helpers/array-param";
import { canonicalUuids, uuidArrayParam } from "~/server/db/helpers/query";
import { decision } from "~/server/db/kernel-schema";
import { recordKey } from "~/server/db/kernel-schema";
import { emailReadSnapshot } from "~/server/db/read-snapshot-schema";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import type { emailPurchaseDecision } from "~/server/db/retained-tables";
import {
  email,
  emailClassificationObservation,
  orderMailEvent,
  sourceOrderObservation,
  purchase,
  vendorAccount,
  ledgerParty,
  runOperation,
  run,
  orderMail,
} from "~/server/db/schema";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import {
  emailLinkDecisionsForEmailsSql,
  emailLinkDecisionsReadForEmails,
} from "~/server/domains/email/repo/email-decision-sql";
import {
  foldScopedEmailPurchaseFacts,
  strongestLinkState,
  emailSuggestedEvidenceSql,
  readExactOrderLinkCandidates,
} from "~/server/domains/email/repo/email-purchase-links";
import {
  emailEvidence,
  orderEvidence,
} from "~/server/domains/purchase-import/repo/order-evidence";
import {
  defineEvidence,
  defineReadIndex,
  effectiveBindings,
  defineReconciler,
  columnKey,
  indexKey,
  rowKey,
  source,
  writes,
  recordSubject,
  type Binding,
  type Pure,
} from "~/server/kernel/api";
import { decisionKey } from "~/server/kernel/keys";

export const emailPredictionEvidence = defineEvidence({
  kind: "email.prediction",
  table: emailClassificationObservation,
  keys: (row) => [
    rowKey("Email", row.emailId),
    rowKey("EmailClassificationObservation", row.id),
  ],
  discovers: (row) => [{ kind: "emailState", key: row.emailId }],
  owner: (row) => row.emailId,
  async resolveOwners(db, keys) {
    const { repositoryQueries } =
      await import("~/server/db/repository-access.boundary");
    const rows = await repositoryQueries(db)
      .select({ id: email.id, owner: ledgerParty.userId })
      .from(email)
      .innerJoin(
        ledgerParty,
        and(
          eq(ledgerParty.id, email.ledgerPartyId),
          isNull(ledgerParty.deletedAt),
        ),
      )
      .where(
        inArray(
          email.id,
          keys.map((key) => parseEntityId("email", key)),
        ),
      );
    return new Map(rows.map((row) => [row.id, row.owner]));
  },
});
/**
 * Per-Email read indexes. Each indexed column is set once at insert and never
 * updated, so a row never moves between memberships.
 */
/** Matches `EmailClassificationObservation_email_idx`. */
const emailPredictions = defineReadIndex(emailClassificationObservation, {
  name: "emailPrediction.email",
  values: (row) => [row.emailId],
  where: (values) =>
    sql`${emailClassificationObservation.emailId} = ANY(${columnArrayParam(values)})`,
});
/** Matches `SourceOrderObservation_email_idx`. */
const emailOrderObservations = defineReadIndex(sourceOrderObservation, {
  name: "orderObservation.email",
  values: (row) => (row.emailId ? [row.emailId] : []),
  where: (values) =>
    sql`${sourceOrderObservation.emailId} = ANY(${columnArrayParam(values)})`,
});
/** Matches the leading column of `OrderMailEvent_source_key`. */
const originalEvents = defineReadIndex(orderMailEvent, {
  name: "orderMailEvent.original",
  values: (row) => [row.orderMailId],
  where: (values) =>
    sql`${orderMailEvent.orderMailId} = ANY(${columnArrayParam(values)})`,
});
/**
 * Matches `RunOperation_mail_outcome_email_idx`; outcomeFor reads only these
 * rows. Only a string target can equal an Email id, so other JSON values join
 * no membership.
 */
/**
 * Purchase search memberships: equal order ids, and the Vendor's Purchases for
 * the amount and date branch. Values include deleted Purchases, so a deletion
 * raises the same key. Matches `Purchase_orderId_gin_idx` and
 * `Purchase_vendorId_idx`.
 */
const orderPurchaseCandidates = defineReadIndex(purchase, {
  name: "purchase.order",
  values: (row) => (row.orderId !== null ? [row.orderId] : []),
  where: (values) => sql`${purchase.orderId} = ANY(${textArrayParam(values)})`,
});
const vendorPurchaseCandidates = defineReadIndex(purchase, {
  name: "purchase.vendor",
  values: (row) => (row.vendorId !== null ? [row.vendorId] : []),
  where: (values) =>
    sql`${purchase.vendorId} = ANY(${columnArrayParam(values)})`,
});
const purchaseColumns = [
  "vendorId",
  "orderId",
  "vendorAccountId",
  "statedTotal",
  "date",
  "deletedAt",
] as const;
const recordKeyColumns = [
  "scopeKind",
  "scopeKey",
  "entity",
  "entityId",
  "mergedAt",
] as const;
const outcomeTarget = z.object({ target: z.object({ entityId: z.string() }) });
const emailOutcomes = defineReadIndex(runOperation, {
  name: "runOperation.mailOutcome",
  values: (row) => {
    const result = row.result;
    if (
      row.kind !== "target_outcome" ||
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      !Object.hasOwn(result, "mailOutcome")
    )
      return [];
    const parsed = outcomeTarget.safeParse(result);
    return parsed.success ? [parsed.data.target.entityId] : [];
  },
  where: (values) =>
    sql`${runOperation.kind} = 'target_outcome' AND ${runOperation.result}->'mailOutcome' IS NOT NULL
      AND ${runOperation.result} #>> '{target,entityId}' = ANY(${textArrayParam(values)})`,
});

export const emailStateColumns = [
  "classification",
  "classificationStage",
  "classificationReason",
  "classificationVersion",
] as const;
const emailStateRecords = writes(email, emailStateColumns);
const emailStateSnapshot = writes(
  emailReadSnapshot,
  [
    "relationshipFacts",
    "relationshipFactsComputedAt",
    "relationshipFactsDecision",
    "relationshipFactsSort",
  ],
  { projection: true },
);
type Input = {
  key: string;
  row: typeof email.$inferSelect | undefined;
  predictions: (typeof emailClassificationObservation.$inferSelect)[];
  observations: (typeof sourceOrderObservation.$inferSelect)[];
  events: (typeof orderMailEvent.$inferSelect)[];
  purchases: (typeof purchase.$inferSelect)[];
  accounts: (typeof vendorAccount.$inferSelect)[];
  owners: (typeof recordKey.$inferSelect)[];
  bindings: Binding[];
  links: (typeof emailPurchaseDecision.$inferSelect)[];
  suggestions: {
    emailId: string;
    purchaseId: string;
    eventId: string;
    automatic: boolean;
  }[];
  snapshot: typeof emailReadSnapshot.$inferSelect | undefined;
  at: Date;
  operations: (typeof runOperation.$inferSelect)[];
  runs: (typeof run.$inferSelect)[];
};

function outcomeFor(
  input: Input,
  row: NonNullable<Input["row"]>,
  c: Pure,
  choices: ReturnType<Pure["assignments"]>,
  classification: NonNullable<Input["row"]>["classification"],
  accepted: boolean,
  linked: boolean,
) {
  const recorded = z.object({
    target: z.object({ entityId: z.string() }),
    mailOutcome: z.object({
      checksum: z.string(),
      judgment: mailImportOutcome,
    }),
  });
  const operation = input.operations
    .filter((operation) => operation.kind === "target_outcome")
    .sort(
      (a, b) =>
        (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0),
    )
    .flatMap((operation) => {
      const parsed = recorded.safeParse(operation.result);
      return parsed.success &&
        parsed.data.target.entityId === row.id &&
        parsed.data.mailOutcome.checksum === row.checksum
        ? [{ operation, value: parsed.data.mailOutcome.judgment }]
        : [];
    })[0];
  const chosenOutcome = choices.get("outcome");
  const selectedOutcome =
    chosenOutcome?.kind === "set"
      ? mailImportOutcome.safeParse(chosenOutcome.value)
      : null;
  const judgment = selectedOutcome?.success
    ? selectedOutcome.data
    : operation?.value;
  const holder = input.runs.find(
    (run) =>
      run.id === row.runId && !run.deletedAt && run.purpose === "mail_import",
  );
  const held = holder && !operation;
  const active =
    holder &&
    ["pending", "running", "queued", "paused_offline"].includes(holder.status);
  const outcomeKind = accepted
    ? "imported"
    : classification === "unrelated" && choices.has("classification")
      ? "unrelated"
      : held && active
        ? "importing"
        : linked
          ? "linked"
          : held
            ? "failed"
            : judgment?.kind === "unresolved"
              ? MAIL_IMPORT_GAP_OUTCOME[
                  MAIL_IMPORT_GAP_EXECUTOR[judgment.category]
                ]
              : (judgment?.kind ??
                (classification === "unrelated"
                  ? "unrelated"
                  : "not_imported"));
  const unresolved =
    judgment?.kind === "unresolved" && !accepted && !linked ? judgment : null;
  const waiting = unresolved?.waitingOn;
  const waitingOn =
    waiting?.kind === "email"
      ? (() => {
          const id = c.reference("email", waiting.emailId, {
            format: "shortcode",
          });
          return id ? { kind: "email", emailId: id } : null;
        })()
      : waiting?.kind === "order"
        ? {
            kind: "order",
            orderId: waiting.orderId,
            vendorId: waiting.vendorId
              ? c.reference("vendor", waiting.vendorId, { format: "shortcode" })
              : null,
          }
        : null;
  return emailImportOutcomeDetail.parse({
    outcome: outcomeKind,
    category: unresolved?.category ?? null,
    executor: unresolved ? MAIL_IMPORT_GAP_EXECUTOR[unresolved.category] : null,
    reason:
      unresolved?.reason ??
      (judgment?.kind === "unrelated" ? judgment.reason : null),
    waitingOn,
    runId:
      holder?.shortcode ??
      (operation
        ? c.reference("run", operation.operation.runId, { format: "shortcode" })
        : null),
  });
}

export const emailState = defineReconciler<Input>({
  scope: "emailState",
  lane: "money",
  version: 1,
  after: ["purchaseEvent"],
  reads: [
    source.evidence(emailEvidence),
    source.evidence(orderEvidence),
    source.evidence(emailPredictionEvidence),
    source.bindings,
    source.table(decision, ["subject", "slot", "field", "kind", "value", "at"]),
    source.table(entityIdentity, ["kind", "deletedAt", "mergedIntoId"]),
    source.table(ledgerParty, ["kind", "userId", "deletedAt"]),
    source.table(email, [
      "checksum",
      "ledgerPartyId",
      "orderMailId",
      "deletedAt",
    ]),
    source.table(
      emailClassificationObservation,
      [
        "emailId",
        "classification",
        "stage",
        "reason",
        "classificationVersion",
        "application",
        "conflict",
        "checksum",
        "createdAt",
      ],
      [emailPredictions],
    ),
    source.table(
      sourceOrderObservation,
      ["emailId", "vendorId", "checksum", "extraction", "purchaseId"],
      [emailOrderObservations],
    ),
    source.table(
      orderMailEvent,
      ["orderMailId", "orderId", "amount", "supersededAt"],
      [originalEvents],
    ),
    source.table(purchase, purchaseColumns, [
      orderPurchaseCandidates,
      vendorPurchaseCandidates,
    ]),
    source.table(vendorAccount, ["ledgerPartyId", "deletedAt"]),
    source.table(recordKey, recordKeyColumns),
    source.table(orderMail, ["ledgerPartyId", "rawChecksum", "vendorId"]),
    source.table(
      runOperation,
      ["kind", "result", "completedAt"],
      [emailOutcomes],
    ),
    source.table(run, ["status", "purpose", "deletedAt"]),
    source.table(emailReadSnapshot, [
      "relationshipFacts",
      "relationshipFactsComputedAt",
    ]),
  ],
  writes: [emailStateRecords, emailStateSnapshot],
  async load(reads, keys) {
    // Every scope reads its own Email and the rows keyed by it through its
    // own scope, so a batchmate's input never dirties it. Each phase issues
    // its scoped reads in one tick: they coalesce into one statement per table.
    const rows = new Map(
      (
        await Promise.all(keys.map((key) => reads.for(key).rows(email, [key])))
      ).flatMap((found) => [...found]),
    );
    const own = await Promise.all(
      keys.map((key) => {
        const scoped = reads.for(key);
        const row = rows.get(key);
        const original = row?.orderMailId ? [row.orderMailId] : [];
        return Promise.all([
          scoped.lookup(emailClassificationObservation, emailPredictions, [
            key,
          ]),
          scoped.lookup(sourceOrderObservation, emailOrderObservations, [key]),
          scoped.lookup(orderMailEvent, originalEvents, original),
          scoped.rows(emailReadSnapshot, [key]),
          scoped.lookup(runOperation, emailOutcomes, [key]),
          scoped.rows(run, row?.runId ? [row.runId] : []),
          // The shared projections below join only this Email's original and
          // ledger party; these reads fence them for this scope alone.
          scoped.rows(orderMail, original),
          scoped.rows(ledgerParty, row ? [row.ledgerPartyId] : []),
        ]);
      }),
    );
    const events = own.flatMap(([, , found]) => found);
    const scopedBindings = await Promise.all(
      keys.map((key, index) =>
        reads.for(key).bindings({
          facts: own[index]![1].map((row) => ({
            kind: orderEvidence.kind,
            id: row.id,
          })),
        }),
      ),
    );
    const ownerKeys = scopedBindings.map(
      (bindings) =>
        new Set(
          bindings.map((binding) =>
            binding.basis === "baseline" &&
            binding.scope.kind === "purchaseEvent"
              ? binding.scope.key
              : binding.eventKey,
          ),
        ),
    );
    // A Purchase publication inserts, rejects or merges the RecordKey rows
    // that own a scope's bound observations, and no writer raises a key per
    // RecordKey row. A scope with order observations therefore depends on the
    // declared RecordKey and Purchase columns that publication raises; one
    // without them has no owner to read.
    const ownerFence = [
      ...recordKeyColumns.map((column) => columnKey("RecordKey", column)),
      ...purchaseColumns.map((column) => columnKey("Purchase", column)),
    ];
    const owners = await reads.selectEach(
      recordKey,
      new Map(
        keys.map((key, index) => [
          key,
          own[index]![1].length ? ownerFence : [],
        ]),
      ),
      sql`${recordKey.scopeKind} = 'purchaseEvent'
      AND ${recordKey.entity} = ${sqlEnumConstant(entitySchema, entitySchema.enum.purchase)} AND ${recordKey.scopeKey} = ANY(${textArrayParam(ownerKeys.flatMap((set) => [...set]))})`,
    );
    const subjects = [
      ...keys.map((key) => `email:${key}`),
      ...events.map((row) => `emailEvent:${row.id}`),
    ];
    const linkChoices = await reads.selectEach(
      decision,
      new Map(
        keys.map((key) => [key, [decisionKey(recordSubject("email", key))]]),
      ),
      sql`${decision.subject}=ANY(${textArrayParam(keys.map((key) => recordSubject("email", key)))}) AND ${decision.field} LIKE 'link:%'`,
    );
    const linkTargets = await Promise.all(
      keys.map((key) => {
        const targets = linkChoices
          .filter((row) => row.subject === recordSubject("email", key))
          .map((row) => row.field!.slice(5));
        return reads
          .for(key)
          .rows(entityIdentity, targets)
          .then((found) => [
            ...targets,
            ...targets.flatMap((id) => {
              const merged = found.get(id)?.mergedIntoId;
              return merged ? [merged] : [];
            }),
          ]);
      }),
    );
    // Each scope fences the Purchases its shared projections can read before
    // they run: rows it names, and the order and Vendor memberships its own
    // order events search.
    const named = keys.map((_, index) => {
      const [, observations, events, , , , originals] = own[index]!;
      const vendorId = [...originals.values()][0]?.vendorId;
      return {
        ids: canonicalUuids([
          ...owners
            .filter((row) => ownerKeys[index]!.has(row.scopeKey))
            .map((row) => row.entityId),
          ...observations.flatMap((row) =>
            row.purchaseId ? [row.purchaseId] : [],
          ),
          ...linkTargets[index]!,
        ]),
        orders: events.flatMap((row) =>
          row.orderId !== null ? [row.orderId] : [],
        ),
        // The amount and date branch searches the original's Vendor.
        vendorId:
          vendorId &&
          events.some((row) => !row.supersededAt && row.amount !== null)
            ? vendorId
            : null,
      };
    });
    const fenced = await reads.selectEach(
      purchase,
      new Map(
        keys.map((key, index) => {
          const { ids, orders, vendorId } = named[index]!;
          return [
            key,
            [
              ...ids.map((id) => rowKey("Purchase", id)),
              ...orders.map((order) =>
                indexKey(orderPurchaseCandidates.name, order),
              ),
              ...(vendorId
                ? [indexKey(vendorPurchaseCandidates.name, vendorId)]
                : []),
            ],
          ];
        }),
      ),
      // Each source selects Purchase ids on its own plan; as OR branches of one
      // filter they scanned every Purchase.
      sql`${purchase.id} = ANY(ARRAY(
      SELECT unnest(${uuidArrayParam(named.flatMap((row) => row.ids))})
      UNION SELECT candidate.id FROM "Purchase" candidate
        WHERE candidate."orderId" = ANY(${textArrayParam(named.flatMap((row) => row.orders))})))`,
    );
    // The search's candidate accounts are unknown before it runs.
    const suggestions = await reads.prepare(
      [vendorAccount, entityIdentity],
      async (database) => {
        const result = await repositoryQueries(database).execute<{
          emailId: string;
          purchaseId: string;
          eventId: string;
        }>(sql`
        WITH link_decisions AS MATERIALIZED ${emailLinkDecisionsForEmailsSql(uuidArrayParam(keys))}
        SELECT "Email".id AS "emailId", matched."purchaseId", matched."eventId"
        FROM "Email" CROSS JOIN LATERAL (${emailSuggestedEvidenceSql("respect", undefined, sql`link_decisions`)}) matched
        WHERE "Email".id=ANY(${textArrayParam(keys)}::uuid[])`);
        const exact = await readExactOrderLinkCandidates(database, {
          emailIds: keys,
        });
        return result.rows.map((row) => ({
          ...row,
          automatic: exact.some(
            (match) =>
              match.emailId === row.emailId &&
              match.purchaseId === row.purchaseId &&
              match.eventId === row.eventId,
          ),
        }));
      },
    );
    // Purchases a subject's assignment decisions name, by shortcode or id.
    const references = await reads.prepare([], (database) =>
      repositoryQueries(database).execute<{ subject: string; id: string }>(sql`
      SELECT DISTINCT choice.subject, coalesce(e."mergedIntoId",e.id) AS id FROM "Decision" choice
        CROSS JOIN LATERAL (VALUES
          (choice.value #>> '{}'),
          (choice.value->>'purchaseId'),
          (CASE WHEN starts_with(choice.field, 'link:') THEN substring(choice.field from 6) END)
        ) reference(token)
        JOIN "Entity" e ON (
          e.id = CASE WHEN pg_input_is_valid(reference.token, ${"uuid"}) THEN reference.token::uuid END
          AND e.id::text = reference.token
        ) OR e.shortcode = reference.token
        WHERE choice.channel = ${sqlEnumConstant(decisionChannel, decisionChannel.enum.assignment)} AND choice.subject = ANY(${textArrayParam(subjects)})`),
    );
    const referenced = keys.map((key, index) => {
      const owned = new Set([
        `email:${key}`,
        ...own[index]![2].map((row) => `emailEvent:${row.id}`),
      ]);
      return canonicalUuids([
        ...references.rows.flatMap((row) =>
          owned.has(row.subject) ? [row.id] : [],
        ),
        ...suggestions.flatMap((row) =>
          row.emailId === key ? [row.purchaseId] : [],
        ),
      ]);
    });
    const referencedRows = await reads.selectEach(
      purchase,
      new Map(
        keys.map((key, index) => [
          key,
          referenced[index]!.map((id) => rowKey("Purchase", id)),
        ]),
      ),
      sql`${purchase.id} = ANY(${uuidArrayParam(referenced.flat())})`,
    );
    const purchases = [
      ...new Map(
        [...fenced, ...referencedRows].map((row) => [row.id, row] as const),
      ).values(),
    ];
    const byId = new Map<string, (typeof purchases)[number]>(
      purchases.map((row) => [row.id, row]),
    );
    // Each scope reads the accounts of the Purchases it names.
    const accounts = [
      ...new Map(
        (
          await Promise.all(
            keys.map((key, index) =>
              reads.for(key).rows(
                vendorAccount,
                [...named[index]!.ids, ...referenced[index]!].flatMap((id) => {
                  const account = byId.get(id)?.vendorAccountId;
                  return account ? [account] : [];
                }),
              ),
            ),
          )
        ).flatMap((found) => [...found]),
      ).values(),
    ];
    // Email rows, Purchase roster, subject decisions and redirect rows were
    // fenced before this shared projection. It adds no untracked authority.
    const scopedLinks = emailLinkDecisionsReadForEmails(uuidArrayParam(keys));
    const links = await reads.prepare([], (database) =>
      repositoryQueries(database)
        .select()
        .from(scopedLinks)
        .where(
          sql`${scopedLinks.emailId}=ANY(${textArrayParam(keys)}::uuid[])`,
        ),
    );
    const at = new Date();
    return new Map(
      keys.map((key, index) => {
        const [predictions, observations, events, snapshot, operations, runs] =
          own[index]!;
        return [
          key,
          {
            key,
            row: rows.get(key),
            predictions,
            observations,
            events,
            purchases,
            accounts,
            owners,
            bindings: scopedBindings[index]!,
            links: links.filter((link) => link.emailId === key),
            suggestions: suggestions.filter((row) => row.emailId === key),
            snapshot: snapshot.get(key),
            at,
            operations,
            runs: [...runs.values()],
          },
        ];
      }),
    );
  },
  reconcile(input, c) {
    const row = input.row;
    if (!row || row.deletedAt) return c.done();
    const subject = recordSubject("email", row.id);
    const choices = c.assignments(subject);
    const prediction = input.predictions
      .filter(
        (value) =>
          value.checksum === row.checksum && value.application === "applied",
      )
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          b.id.localeCompare(a.id),
      )[0];
    const projected = {
      classification: prediction?.classification ?? row.classification,
      classificationStage: prediction?.stage ?? row.classificationStage,
      classificationReason: prediction?.reason ?? row.classificationReason,
      classificationVersion:
        prediction?.classificationVersion ?? row.classificationVersion,
    };
    const provenance: Record<string, string> = {};
    for (const field of emailStateColumns) {
      const held = choices.get(field);
      if (held) {
        Object.assign(projected, {
          [field]: held.kind === "none" ? null : held.value,
        });
        provenance[field] = held.id;
      }
    }
    const member = choices.get("classification");
    if (member?.kind === "set") {
      projected.classificationStage = "resolution";
      provenance.classificationStage = member.id;
    }
    c.patch(emailStateRecords, row.id, projected, { provenance });
    const facts: ReturnType<typeof emailPurchaseFact.parse>[] = [];
    const add = (
      purchaseId: string,
      kind: "accepted" | "linked" | "dismissed" | "suggested",
      eventId: string | null,
      checksum: string | null,
      proposer?: "heuristic",
    ) => {
      const target = input.purchases.find(
        (value) =>
          value.id === c.reference("purchase", purchaseId) && !value.deletedAt,
      );
      const owner = input.accounts.find(
        (value) => value.id === target?.vendorAccountId && !value.deletedAt,
      )?.ledgerPartyId;
      if (!target || !target.vendorId || (owner && owner !== row.ledgerPartyId))
        return;
      facts.push(
        emailPurchaseFact.parse({
          purchaseId: target.id,
          purchaseShortcode: target.shortcode,
          vendorId: target.vendorId,
          eventId,
          kind,
          changed: checksum !== null && checksum !== row.checksum,
          proposedBy:
            proposer ??
            (kind === "accepted"
              ? "import"
              : kind === "suggested"
                ? "heuristic"
                : "member"),
        }),
      );
    };
    for (const observation of input.observations) {
      const binding = effectiveBindings(input.bindings).find(
        (value) => value.fact.id === observation.id,
      );
      const owner =
        binding &&
        input.owners.find(
          (value) =>
            value.entity === "purchase" &&
            !value.mergedAt &&
            !value.rejectedAt &&
            value.scopeKind === "purchaseEvent" &&
            value.scopeKey ===
              (binding.scope.kind === "purchaseEvent" &&
              binding.basis === "baseline"
                ? binding.scope.key
                : binding.eventKey),
        );
      const id = owner?.entityId;
      if (id) add(id, "accepted", null, observation.checksum);
    }
    const linkedPurchase = choices.get("purchaseId");
    const linkedId =
      linkedPurchase?.kind === "set" && typeof linkedPurchase.value === "string"
        ? c.reference("purchase", linkedPurchase.value)
        : null;
    const dismissed = new Set<string>(
      input.links
        .filter((link) => link.active && link.decision === "dismissed")
        .map((link) => link.purchaseId),
    );
    for (const link of input.links.filter((link) => link.active))
      add(link.purchaseId, link.decision, link.eventId, link.evidenceChecksum);
    for (const suggestion of input.suggestions)
      if (
        !dismissed.has(suggestion.purchaseId) &&
        c.decision("rejection", `emailEvent:${suggestion.eventId}`)?.kind !==
          "reject"
      )
        add(
          suggestion.purchaseId,
          suggestion.automatic ? "linked" : "suggested",
          suggestion.eventId,
          row.checksum,
          "heuristic",
        );
    for (const event of input.events.filter(
      (value) => value.orderMailId === row.orderMailId && !value.supersededAt,
    )) {
      const held = c.decision(
        "assignment",
        `emailEvent:${event.id}`,
        "purchaseId",
      );
      if (
        held?.kind === "set" &&
        typeof held.value === "string" &&
        !dismissed.has(c.reference("purchase", held.value) ?? held.value) &&
        !linkedId
      ) {
        add(held.value, "linked", event.id, null);
        continue;
      }
      if (c.decision("rejection", `emailEvent:${event.id}`)?.kind === "reject")
        continue;
    }
    const gates = new Map(
      input.purchases.flatMap((value) =>
        !value.deletedAt && value.vendorId
          ? [
              [
                value.id,
                {
                  id: value.id,
                  vendorId: value.vendorId,
                  ownerId:
                    input.accounts.find(
                      (account) =>
                        account.id === value.vendorAccountId &&
                        !account.deletedAt,
                    )?.ledgerPartyId ?? null,
                },
              ] as const,
            ]
          : [],
      ),
    );
    const links = foldScopedEmailPurchaseFacts({
      facts,
      emailId: row.id,
      ownerId: row.ledgerPartyId,
      purchases: gates,
      scope: null,
    });
    const outcome = outcomeFor(
      input,
      row,
      c,
      choices,
      projected.classification,
      facts.some((value) => value.kind === "accepted"),
      links.some((value) => value.state === "linked"),
    );
    if (projected.classification === "uncertain")
      c.gap.decision("whether this Email is relevant");
    else if (
      projected.classification === "related" &&
      !links.some((value) => value.state === "linked")
    )
      c.gap.evidence(
        "accepted order details or a reviewed Purchase link",
        sourceActor("the Email"),
      );
    const value = emailRelationshipResult.parse({
      facts,
      evidence: facts.map((fact) => ({
        purchaseId: fact.purchaseShortcode,
        kind: fact.kind,
        changed: fact.changed,
        proposedBy: fact.proposedBy,
      })),
      linked: links.some((value) => value.state === "linked"),
      linkState: strongestLinkState(links),
      purchaseLinks: links,
      outcome,
    });
    c.patch(emailStateSnapshot, row.id, {
      relationshipFacts: value,
      relationshipFactsComputedAt: isEqual(
        input.snapshot?.relationshipFacts,
        value,
      )
        ? input.snapshot!.relationshipFactsComputedAt
        : input.at,
      relationshipFactsDecision: {
        outcome: { kind: "value" },
        provenance: { kind: "computed" },
      },
      relationshipFactsSort: null,
    });
    return c.done();
  },
});
