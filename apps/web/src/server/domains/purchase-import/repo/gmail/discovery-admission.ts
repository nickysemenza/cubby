import { ledgerPartyId, type RunId } from "@cubby/schemas/identifiers";
import {
  mailboxDiscoveryInput,
  mailboxDiscoveryProgress,
  type MailboxDiscoveryScope,
  type MailboxDiscoveryProgress,
  MAIL_DISCOVERY_CAPACITY,
  MAIL_DISCOVERY_ADMISSION_WAIT,
} from "@cubby/schemas/mailbox-research";
import { runStatus, runPurpose } from "@cubby/schemas/run-fields";
import { and, eq, sql, or, isNull, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import { run } from "~/server/db/retained-tables";
import { runHasLivePass } from "~/server/domains/run/repo/run-execution";

/** Admission precedes member, Run and Job locks; provider work never holds it. */
export async function lockMailDiscoveryAdmission(
  db: Database,
  input: { ledgerPartyId: string; mailboxId: string },
): Promise<void> {
  await getDb(db).execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
    'cubby-mail-discovery:' || ${input.ledgerPartyId}::uuid::text || ':' || ${input.mailboxId}, 0))`);
}

/** Resolve immutable mailbox identity before taking a Run lock, then revalidate it. */
export async function lockMailDiscoveryRunAdmission(
  db: Database,
  runId: RunId,
): Promise<{ ledgerPartyId: string; mailboxId: string } | null> {
  const [owner] = await getDb(db)
    .select({
      purpose: run.purpose,
      ledgerPartyId: run.ledgerPartyId,
      mailboxId: sql<unknown>`${run.input}->'mailboxId'`,
    })
    .from(run)
    .where(eq(run.id, runId));
  if (owner?.purpose !== "mail_discovery") return null;
  if (!owner.ledgerPartyId)
    throw new Error("Mail discovery has no member scope");
  const identity = {
    ledgerPartyId: owner.ledgerPartyId,
    mailboxId: mailboxDiscoveryInput.shape.mailboxId.parse(owner.mailboxId),
  };
  await lockMailDiscoveryAdmission(db, identity);
  return identity;
}

/** Explicit readmission may narrow a frozen targeted page, never its source inputs. */
export function retainedMailDiscoveryScope(
  input: Pick<
    typeof run.$inferSelect,
    "input" | "progress" | "status" | "failureCode"
  >,
): MailboxDiscoveryScope {
  const declared = mailboxDiscoveryInput.parse(input.input);
  const progress = mailboxDiscoveryProgress.parse(input.progress);
  if (declared.controlled) return { kind: "mailbox" };
  if (progress.discoveryScope) {
    // Authorization also pauses initialization before a page freezes; only
    // the admission-wait owner establishes legacy queued history intent.
    if (
      input.status === "paused" &&
      input.failureCode === MAIL_DISCOVERY_ADMISSION_WAIT &&
      progress.discoveryScope.kind === "mailbox" &&
      progress.admissionClass === "automatic" &&
      progress.phase === "paused" &&
      !progress.page
    )
      return { kind: "mailbox", mode: "new_mail" };
    return progress.discoveryScope;
  }
  return progress.page?.scopedKey
    ? { kind: "query", key: progress.page.scopedKey }
    : { kind: "mailbox" };
}

type MailDiscoveryOwner = Pick<
  typeof run.$inferSelect,
  "id" | "status" | "failureCode"
> & {
  progress: MailboxDiscoveryProgress | null;
  historyOnly: boolean;
  controlled: boolean;
  pageScopedKey: string | null;
};

async function readMailDiscoveryOwners(
  db: Database,
  input: { ledgerPartyId: string; mailboxId: string },
): Promise<MailDiscoveryOwner[]> {
  const successor = alias(run, "mail_admission_successor");
  const execution = {
    id: sql`${run.id}`,
    purpose: sql`${run.purpose}`,
    generation: sql`${run.progress}->>'attempt'`,
  };
  // includes-deleted: a running legacy writer occupies capacity until it stops.
  // The mailbox is compared on returned rows: as a WHERE predicate it would
  // detoast each status-matched candidate's input, query roster included,
  // before the Pass filters reject most of them.
  const rows = await getDb(db)
    .select({
      id: run.id,
      mailboxId: sql<string | null>`${run.input}->>'mailboxId'`,
      status: run.status,
      failureCode: run.failureCode,
      controlled: sql<boolean>`${run.input}->'controlled' IS NOT NULL`,
      hasFrozenPage: sql<boolean>`${run.progress}->${mailboxDiscoveryProgress.keyof().enum.page} IS NOT NULL`,
      pageScopedKey: sql<
        string | null
      >`${run.progress}->${mailboxDiscoveryProgress.keyof().enum.page}->>'scopedKey'`,
      // Frozen pages contain full coverage; admission needs only these fields.
      progress: sql<unknown>`jsonb_strip_nulls(jsonb_build_object(
        'attempt', ${run.progress}->'attempt', 'phase', ${run.progress}->'phase',
        'discoveryScope', ${run.progress}->'discoveryScope',
        'admissionClass', ${run.progress}->'admissionClass',
        'admissionRequestedAt', ${run.progress}->'admissionRequestedAt'))`,
    })
    .from(run)
    .where(
      and(
        eq(run.purpose, runPurpose.enum.mail_discovery),
        eq(run.ledgerPartyId, ledgerPartyId.parse(input.ledgerPartyId)),
        or(
          eq(run.status, runStatus.enum.running),
          and(
            notDeleted(run),
            isNull(run.retiredAt),
            notExists(
              getDb(db)
                .select({ id: successor.id })
                .from(successor)
                .where(
                  and(
                    eq(successor.predecessorRunId, run.id),
                    notDeleted(successor),
                  ),
                ),
            ),
            or(
              and(
                eq(run.status, runStatus.enum.paused),
                eq(run.failureCode, "controlled_mail_queued"),
              ),
              and(
                eq(run.status, runStatus.enum.paused),
                eq(run.failureCode, MAIL_DISCOVERY_ADMISSION_WAIT),
                runHasLivePass(execution),
              ),
              and(
                eq(run.status, runStatus.enum.failed),
                eq(run.failureCode, "job_failed"),
                runHasLivePass({ ...execution, requireAttempt: true }),
              ),
            ),
          ),
        ),
      ),
    );
  return rows.flatMap(({ mailboxId, ...owner }) => {
    if (mailboxId !== input.mailboxId) return [];
    const progress =
      mailboxDiscoveryProgress.safeParse(owner.progress).data ?? null;
    return [
      {
        ...owner,
        progress,
        // Ordinary mailbox owners are pinned to history by the listing path.
        historyOnly:
          progress?.discoveryScope?.kind === "mailbox" &&
          progress.admissionClass === "automatic" &&
          !owner.controlled &&
          !owner.pageScopedKey &&
          (progress.discoveryScope.mode === "new_mail" ||
            (owner.status === "paused" &&
              owner.failureCode === MAIL_DISCOVERY_ADMISSION_WAIT &&
              progress.phase === "paused" &&
              !owner.hasFrozenPage)),
      },
    ];
  });
}

/** Coalesce normal history demand while independent query owners finish. */
export async function findQueuedAutomaticMailboxDiscovery(
  db: Database,
  input: { ledgerPartyId: string; mailboxId: string },
): Promise<RunId | null> {
  return (
    (await readMailDiscoveryOwners(db, input)).find((owner) => {
      const progress = owner.progress;
      return (
        owner.status !== "running" &&
        progress?.admissionClass === "automatic" &&
        progress.discoveryScope?.kind === "mailbox"
      );
    })?.id ?? null
  );
}

type AdmissionRequest = {
  scope: MailboxDiscoveryScope;
  runId?: RunId;
  recovery: boolean;
};
type AdmissionDecision = "available" | "scope_busy" | "capacity";

/** Call only while holding this mailbox's admission lock in the same transaction. */
export async function mailDiscoveryAdmission(
  db: Database,
  input: AdmissionRequest & { ledgerPartyId: string; mailboxId: string },
): Promise<AdmissionDecision> {
  return admissionDecision(await readMailDiscoveryOwners(db, input), input);
}

function admissionDecision(
  owners: MailDiscoveryOwner[],
  input: AdmissionRequest,
): AdmissionDecision {
  const active = owners.filter(
    (owner) => owner.id !== input.runId && owner.status === "running",
  );
  const queued = owners.filter(
    (owner) => owner.id !== input.runId && owner.status !== "running",
  );
  const scopeOf = (owner: (typeof owners)[number]): MailboxDiscoveryScope =>
    owner.progress?.discoveryScope ?? {
      kind: "mailbox",
    };
  const conflicts = (
    left: MailboxDiscoveryScope,
    right: MailboxDiscoveryScope,
  ) =>
    left.kind === "mailbox" ||
    right.kind === "mailbox" ||
    left.key === right.key;
  if (
    active.length >= MAIL_DISCOVERY_CAPACITY ||
    active.some((owner) => scopeOf(owner).kind === "mailbox")
  )
    return "capacity";
  if (active.some((owner) => conflicts(scopeOf(owner), input.scope)))
    return "scope_busy";
  const requestTime = (owner: (typeof owners)[number]) =>
    owner.progress?.admissionRequestedAt ?? "";
  const candidate = owners.find(
    (owner) => owner.id === input.runId && owner.status !== "running",
  );
  const precedes = (
    owner: MailDiscoveryOwner,
    next: MailDiscoveryOwner | undefined,
  ) =>
    !next ||
    requestTime(owner) < requestTime(next) ||
    (requestTime(owner) === requestTime(next) && owner.id < next.id);
  const older = queued.filter((owner) => precedes(owner, candidate));
  // An exclusive waiter drains existing owners instead of losing every vacancy
  // to a fresh continuation. Query recovery reserves one otherwise free lane.
  if (older.some((owner) => scopeOf(owner).kind === "mailbox"))
    return "capacity";
  if (older.some((owner) => conflicts(scopeOf(owner), input.scope)))
    return "scope_busy";
  const recoveryCapacity =
    active.filter((owner) => owner.progress?.admissionClass === "recovery")
      .length <
    MAIL_DISCOVERY_CAPACITY - 1;
  if (input.recovery && input.scope.kind === "query" && !recoveryCapacity)
    return "capacity";
  // Older yielded work also owns a vacancy; fresh continuations cannot strand
  // its frozen page. A blocked recovery cannot reserve that vacancy away.
  const eligibleWaiter = queued.some(
    (owner) =>
      scopeOf(owner).kind === "query" &&
      (owner.progress?.admissionClass !== "recovery" || recoveryCapacity) &&
      (owner.progress?.admissionClass === "recovery" ||
        precedes(owner, candidate)) &&
      !active.some((current) => conflicts(scopeOf(current), scopeOf(owner))) &&
      !owners.some(
        (prior) =>
          prior.status !== "running" &&
          precedes(prior, owner) &&
          conflicts(scopeOf(prior), scopeOf(owner)),
      ),
  );
  return input.recovery ||
    !eligibleWaiter ||
    active.length < MAIL_DISCOVERY_CAPACITY - 1
    ? "available"
    : "capacity";
}

/**
 * The admission waiters a freed slot admits now, in queue order. Each is
 * judged by the decision its own resume makes, against owners in which every
 * earlier pick already runs, so release follows priority and fairness and
 * never brings forward more waiters than the freed slots admit. Call only
 * while holding this mailbox's admission lock, after the releasing Run's
 * status write in the same transaction.
 */
export async function mailDiscoveryWaitersToRelease(
  db: Database,
  input: { ledgerPartyId: string; mailboxId: string; except?: RunId },
): Promise<RunId[]> {
  let owners = await readMailDiscoveryOwners(db, input);
  const requestTime = (owner: MailDiscoveryOwner) =>
    owner.progress?.admissionRequestedAt ?? "";
  const waiters = owners
    .filter(
      (owner) =>
        owner.id !== input.except &&
        owner.status === "paused" &&
        owner.failureCode === MAIL_DISCOVERY_ADMISSION_WAIT,
    )
    .sort((left, right) =>
      requestTime(left) === requestTime(right)
        ? left.id < right.id
          ? -1
          : 1
        : requestTime(left) < requestTime(right)
          ? -1
          : 1,
    );
  const released: RunId[] = [];
  for (const waiter of waiters) {
    // The scope and class `resumeClaimedWorkflowRun` admits this waiter with.
    const scope: MailboxDiscoveryScope = waiter.controlled
      ? { kind: "mailbox" }
      : (waiter.progress?.discoveryScope ??
        (waiter.pageScopedKey
          ? { kind: "query", key: waiter.pageScopedKey }
          : { kind: "mailbox" }));
    const recovery = waiter.progress?.admissionClass !== "automatic";
    if (
      admissionDecision(owners, { scope, runId: waiter.id, recovery }) !==
      "available"
    )
      continue;
    released.push(waiter.id);
    owners = owners.map((owner) =>
      owner.id === waiter.id
        ? {
            ...owner,
            status: "running",
            failureCode: null,
            progress: owner.progress && {
              ...owner.progress,
              discoveryScope: scope,
              admissionClass: recovery ? "recovery" : "automatic",
            },
          }
        : owner,
    );
  }
  return released;
}

/** A parked partial query must retain its own position against later demand. */
export async function mailDiscoveryShouldYield(
  db: Database,
  input: {
    ledgerPartyId: string;
    mailboxId: string;
    runId: RunId;
    controlled: boolean;
    progress: MailboxDiscoveryProgress;
  },
): Promise<boolean> {
  const { page, discoveryScope: scope } = input.progress;
  if (input.controlled || !scope) return false;
  // History event coverage is atomic over a whole provider page.
  if (page && (scope.kind === "mailbox" || page.scopedKey !== scope.key))
    return false;
  if (page && scope.kind === "query") {
    const owners = await readMailDiscoveryOwners(db, input);
    if (
      owners.some(
        (owner) =>
          owner.id !== input.runId &&
          owner.status !== "running" &&
          (owner.progress?.discoveryScope?.kind === "query"
            ? owner.progress.discoveryScope.key === scope.key
            : !owner.historyOnly),
      )
    )
      return false;
  }
  return (
    (await mailDiscoveryAdmission(db, {
      ...input,
      scope,
      recovery: input.progress.admissionClass === "recovery",
    })) !== "available"
  );
}
