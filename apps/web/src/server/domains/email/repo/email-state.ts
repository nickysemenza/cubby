import {
  emailImportOutcomeDetail,
  MAIL_IMPORT_GAP_EXECUTOR,
  MAIL_IMPORT_GAP_OUTCOME,
} from "@cubby/schemas/email-fields";
import {
  emailRelationshipResult,
  emailPurchaseFact,
} from "@cubby/schemas/email-relationship-facts";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { sourceActor } from "@cubby/schemas/kernel/stage";
import { mailImportOutcome } from "@cubby/schemas/suggestion";
import { sql, eq, inArray, and, isNull } from "drizzle-orm";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import { recordKey } from "~/server/db/kernel-schema";
import { emailReadSnapshot } from "~/server/db/read-snapshot-schema";
import {
  email,
  emailClassificationObservation,
  emailPurchaseDecision,
  orderMailEvent,
  sourceOrderObservation,
  purchase,
  vendorAccount,
  ledgerParty,
  runOperation,
  run,
  orderMail,
  importSourceOrder,
  importSourceClaim,
} from "~/server/db/schema";
import {
  readEmailPurchaseEvidence,
  foldScopedEmailPurchaseFacts,
  strongestLinkState,
} from "~/server/domains/email/repo/email-purchase-links";
import {
  emailEvidence,
  orderEvidence,
} from "~/server/domains/purchase-import/repo/order-evidence";
import {
  defineEvidence,
  defineReconciler,
  rowKey,
  source,
  writes,
  recordSubject,
  type Binding,
  type Pure,
} from "~/server/kernel/api";

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
export const emailStateRecords = writes(email, emailStateColumns);
export const emailStateSnapshot = writes(
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
  legacyLinks: (typeof emailPurchaseDecision.$inferSelect)[];
  purchases: (typeof purchase.$inferSelect)[];
  accounts: (typeof vendorAccount.$inferSelect)[];
  owners: (typeof recordKey.$inferSelect)[];
  bindings: Binding[];
  snapshot: typeof emailReadSnapshot.$inferSelect | undefined;
  legacyFacts: (z.output<typeof emailPurchaseFact> & { emailId: string })[];
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
    source.table(emailPurchaseDecision, [
      "emailId",
      "eventId",
      "purchaseId",
      "decision",
      "active",
      "evidenceChecksum",
    ]),
    source.table(orderMailEvent, ["orderMailId", "orderId", "supersededAt"]),
    source.table(purchase, [
      "vendorId",
      "orderId",
      "vendorAccountId",
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
    source.table(importSourceClaim, [
      "ledgerPartyId",
      "canonicalClaimId",
      "kind",
      "externalKey",
    ]),
    source.table(importSourceOrder, [
      "sourceClaimId",
      "purchaseId",
      "acceptedObservationId",
      "checksum",
    ]),
    source.table(runOperation, ["kind", "result", "completedAt"]),
    source.table(run, ["status", "purpose", "deletedAt"]),
    source.table(emailReadSnapshot, [
      "relationshipFacts",
      "relationshipFactsComputedAt",
    ]),
  ],
  writes: [emailStateRecords, emailStateSnapshot],
  async load(reads, keys) {
    const [
      rows,
      predictions,
      observations,
      events,
      purchases,
      accounts,
      owners,
      snapshots,
      legacyLinks,
      operations,
      runs,
      legacyFacts,
    ] = await Promise.all([
      reads.rows(email, keys),
      reads.select(emailClassificationObservation, keys, sql`true`),
      reads.select(sourceOrderObservation, keys, sql`true`),
      reads.select(orderMailEvent, keys, sql`true`),
      reads.select(purchase, keys, sql`true`),
      reads.select(vendorAccount, [], sql`true`),
      reads.prepare([recordKey], async (db) =>
        (await import("~/server/db/repository-access.boundary"))
          .repositoryQueries(db)
          .select()
          .from(recordKey),
      ),
      reads.prepare([emailReadSnapshot], async (db) =>
        (await import("~/server/db/repository-access.boundary"))
          .repositoryQueries(db)
          .select()
          .from(emailReadSnapshot),
      ),
      reads.select(emailPurchaseDecision, keys, sql`true`),
      reads.select(runOperation, [], sql`true`),
      reads.select(run, [], sql`true`),
      reads.prepare(
        [
          email,
          purchase,
          vendorAccount,
          orderMail,
          orderMailEvent,
          emailPurchaseDecision,
          importSourceClaim,
          importSourceOrder,
          sourceOrderObservation,
        ],
        (db) =>
          readEmailPurchaseEvidence(
            db,
            keys.map((key) => parseEntityId("email", key)),
            null,
            "ignore",
          ),
      ),
    ]);
    const bindings = await reads.bindings({
      facts: observations.map((row) => ({
        kind: orderEvidence.kind,
        id: row.id,
      })),
    });
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
          legacyLinks,
          purchases,
          accounts,
          owners,
          bindings,
          snapshot: snapshots.find((row) => row.entityId === key),
          at,
          operations,
          runs,
          legacyFacts: legacyFacts.filter((fact) => fact.emailId === key),
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
          value.checksum === row.checksum && value.application !== "unverified",
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
    if (member) {
      projected.classificationStage = "resolution";
      provenance.classificationStage = member.id;
    }
    c.patch(emailStateRecords, row.id, projected, { provenance });
    const facts: ReturnType<typeof emailPurchaseFact.parse>[] =
      input.legacyFacts.map((fact) => emailPurchaseFact.parse(fact));
    const add = (
      purchaseId: string,
      kind: "accepted" | "linked" | "dismissed" | "suggested",
      eventId: string | null,
      checksum: string | null,
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
            kind === "accepted"
              ? "import"
              : kind === "suggested"
                ? "heuristic"
                : "member",
        }),
      );
    };
    for (const observation of input.observations) {
      const binding =
        input.bindings.find(
          (value) =>
            value.fact.id === observation.id && value.basis === "decision",
        ) ?? input.bindings.find((value) => value.fact.id === observation.id);
      const owner =
        binding &&
        input.owners.find(
          (value) =>
            value.entity === "purchase" &&
            !value.mergedAt &&
            value.scopeKind === "purchaseEvent" &&
            value.scopeKey ===
              (binding.scope.kind === "purchaseEvent" &&
              binding.basis === "baseline"
                ? binding.scope.key
                : binding.eventKey),
        );
      const id = owner?.entityId ?? observation.purchaseId;
      if (id) add(id, "accepted", null, observation.checksum);
    }
    for (const [field, held] of choices)
      if (field.startsWith("link:") && typeof held.value === "string")
        add(
          field.slice(5),
          held.value === "dismissed" ? "dismissed" : "linked",
          null,
          null,
        );
    for (const event of input.events.filter(
      (value) => value.orderMailId === row.orderMailId && !value.supersededAt,
    )) {
      const held = c.decision(
        "assignment",
        `emailEvent:${event.id}`,
        "purchaseId",
      );
      if (held?.kind === "set" && typeof held.value === "string") {
        add(held.value, "linked", event.id, null);
        continue;
      }
      if (c.decision("rejection", `emailEvent:${event.id}`)?.kind === "reject")
        continue;
      const matches = input.purchases.filter(
        (value) =>
          !value.deletedAt && value.orderId && value.orderId === event.orderId,
      );
      for (const target of matches)
        add(
          target.id,
          matches.length === 1 ? "linked" : "suggested",
          event.id,
          row.checksum,
        );
      if (matches.length > 1)
        c.gap.decision("which Purchase this Email describes", {
          actions: matches.map((target) => ({
            channel: "assignment",
            kind: "set",
            subject: `emailEvent:${event.id}`,
            field: "purchaseId",
            value: target.id,
            label: target.shortcode,
          })),
        });
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
