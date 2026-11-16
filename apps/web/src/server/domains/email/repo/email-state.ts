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
import { textArrayParam } from "~/server/db/helpers/array-param";
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
import { emailLinkDecisionsRead } from "~/server/domains/email/repo/email-decision-sql";
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
  effectiveBindings,
  defineReconciler,
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
    source.table(emailClassificationObservation, [
      "emailId",
      "classification",
      "stage",
      "reason",
      "classificationVersion",
      "application",
      "conflict",
      "checksum",
      "createdAt",
    ]),
    source.table(sourceOrderObservation, [
      "emailId",
      "vendorId",
      "checksum",
      "extraction",
      "purchaseId",
    ]),
    source.table(orderMailEvent, [
      "orderMailId",
      "orderId",
      "amount",
      "supersededAt",
    ]),
    source.table(purchase, [
      "vendorId",
      "orderId",
      "vendorAccountId",
      "statedTotal",
      "date",
      "deletedAt",
    ]),
    source.table(vendorAccount, ["ledgerPartyId", "deletedAt"]),
    source.table(recordKey, [
      "scopeKind",
      "scopeKey",
      "entity",
      "entityId",
      "mergedAt",
    ]),
    source.table(orderMail, ["ledgerPartyId", "rawChecksum", "vendorId"]),
    source.table(runOperation, ["kind", "result", "completedAt"]),
    source.table(run, ["status", "purpose", "deletedAt"]),
    source.table(emailReadSnapshot, [
      "relationshipFacts",
      "relationshipFactsComputedAt",
    ]),
  ],
  writes: [emailStateRecords, emailStateSnapshot],
  async load(reads, keys) {
    const rows = await reads.rows(email, keys);
    const originals = [...rows.values()].flatMap((row) =>
      row.orderMailId ? [row.orderMailId] : [],
    );
    const [predictions, observations, events, snapshots, operations, runs] =
      await Promise.all([
        reads.select(
          emailClassificationObservation,
          [],
          sql`${emailClassificationObservation.emailId}::text = ANY(${textArrayParam(keys)})`,
        ),
        reads.select(
          sourceOrderObservation,
          [],
          sql`${sourceOrderObservation.emailId}::text = ANY(${textArrayParam(keys)})`,
        ),
        reads.select(
          orderMailEvent,
          [],
          sql`${orderMailEvent.orderMailId}::text = ANY(${textArrayParam(originals)})`,
        ),
        reads.select(
          emailReadSnapshot,
          [],
          sql`${emailReadSnapshot.entityId}::text = ANY(${textArrayParam(keys)})`,
        ),
        reads.select(
          runOperation,
          [],
          sql`${runOperation.result}->${"target"}->>'entityId' = ANY(${textArrayParam(keys)})`,
        ),
        reads.rows(
          run,
          [...rows.values()].flatMap((row) => (row.runId ? [row.runId] : [])),
        ),
      ]);
    const bindings = await reads.bindings({
      facts: observations.map((row) => ({
        kind: orderEvidence.kind,
        id: row.id,
      })),
    });
    const scopeKeys = bindings.map((binding) =>
      binding.basis === "baseline" && binding.scope.kind === "purchaseEvent"
        ? binding.scope.key
        : binding.eventKey,
    );
    const owners = await reads.select(
      recordKey,
      [],
      sql`${recordKey.scopeKind} = 'purchaseEvent'
      AND ${recordKey.entity} = ${sqlEnumConstant(entitySchema, entitySchema.enum.purchase)} AND ${recordKey.scopeKey} = ANY(${textArrayParam(scopeKeys)})`,
    );
    const subjects = [
      ...keys.map((key) => `email:${key}`),
      ...events.map((row) => `emailEvent:${row.id}`),
    ];
    const ids = [
      ...owners.map((row) => row.entityId),
      ...observations.flatMap((row) =>
        row.purchaseId ? [row.purchaseId] : [],
      ),
    ];
    const linkChoices = await reads.selectEach(
      decision,
      new Map(
        keys.map((key) => [key, [decisionKey(recordSubject("email", key))]]),
      ),
      sql`${decision.subject}=ANY(${textArrayParam(keys.map((key) => recordSubject("email", key)))}) AND ${decision.field} LIKE 'link:%'`,
    );
    await Promise.all(
      keys.map((key) =>
        reads.for(key).rows(
          entityIdentity,
          linkChoices
            .filter((row) => row.subject === recordSubject("email", key))
            .map((row) => row.field!.slice(5)),
        ),
      ),
    );
    const suggestions = await reads.prepare(
      [
        purchase,
        orderMailEvent,
        orderMail,
        vendorAccount,
        entityIdentity,
        ledgerParty,
      ],
      async (database) => {
        const result = await repositoryQueries(database).execute<{
          emailId: string;
          purchaseId: string;
          eventId: string;
        }>(sql`
        SELECT "Email".id AS "emailId", matched."purchaseId", matched."eventId"
        FROM "Email" CROSS JOIN LATERAL (${emailSuggestedEvidenceSql()}) matched
        WHERE "Email".id::text=ANY(${textArrayParam(keys)})`);
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
    ids.push(...suggestions.map((row) => row.purchaseId));
    const purchases = await reads.select(
      purchase,
      [],
      sql`${purchase.id}::text = ANY(${textArrayParam(ids)})
      OR ${purchase.orderId} = ANY(${textArrayParam(events.flatMap((row) => (row.orderId ? [row.orderId] : [])))})
      OR ${purchase.id} IN (SELECT coalesce(e."mergedIntoId",e.id) FROM "Decision" choice JOIN "Entity" e
        ON e.id::text = choice.value #>> '{}' OR e.shortcode = choice.value #>> '{}'
        OR e.id::text = choice.value->>'purchaseId' OR e.shortcode = choice.value->>'purchaseId'
        OR choice.field = 'link:' || e.id::text OR choice.field = 'link:' || e.shortcode
        WHERE choice.channel = ${sqlEnumConstant(decisionChannel, decisionChannel.enum.assignment)} AND choice.subject = ANY(${textArrayParam(subjects)}))`,
    );
    const accounts = [
      ...(
        await reads.rows(
          vendorAccount,
          purchases.flatMap((row) =>
            row.vendorAccountId ? [row.vendorAccountId] : [],
          ),
        )
      ).values(),
    ];
    // Email rows, Purchase roster, subject decisions and redirect rows were
    // fenced before this shared projection. It adds no untracked authority.
    const links = await reads.prepare([], (database) =>
      repositoryQueries(database)
        .select()
        .from(emailLinkDecisionsRead)
        .where(
          sql`${emailLinkDecisionsRead.emailId}=ANY(${textArrayParam(keys)}::uuid[])`,
        ),
    );
    const at = new Date();
    return new Map(
      keys.map((key) => [
        key,
        {
          key,
          row: rows.get(key),
          predictions: predictions.filter((row) => row.emailId === key),
          observations: observations.filter((row) => row.emailId === key),
          events,
          purchases,
          accounts,
          owners,
          bindings,
          links: links.filter((link) => link.emailId === key),
          suggestions: suggestions.filter((row) => row.emailId === key),
          snapshot: snapshots.find((row) => row.entityId === key),
          at,
          operations,
          runs: [...runs.values()],
        },
      ]),
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
