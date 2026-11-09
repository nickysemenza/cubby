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
import { runHasLiveExecution } from "~/server/generic/jobs/repo/job-reads";

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
      input: run.input,
    })
    .from(run)
    .where(eq(run.id, runId));
  if (owner?.purpose !== "mail_discovery") return null;
  if (!owner.ledgerPartyId)
    throw new Error("Mail discovery has no member scope");
  const identity = {
    ledgerPartyId: owner.ledgerPartyId,
    mailboxId: mailboxDiscoveryInput.parse(owner.input).mailboxId,
  };
  await lockMailDiscoveryAdmission(db, identity);
  return identity;
}

/** Explicit readmission may narrow a frozen targeted page, never its source inputs. */
export function retainedMailDiscoveryScope(
  input: Pick<typeof run.$inferSelect, "input" | "progress">,
): MailboxDiscoveryScope {
  const declared = mailboxDiscoveryInput.parse(input.input);
  const progress = mailboxDiscoveryProgress.parse(input.progress);
  if (declared.controlled) return { kind: "mailbox" };
  if (progress.discoveryScope) return progress.discoveryScope;
  return progress.page?.scopedKey
    ? { kind: "query", key: progress.page.scopedKey }
    : { kind: "mailbox" };
}

type MailDiscoveryOwner = Pick<
  typeof run.$inferSelect,
  "id" | "status" | "failureCode"
> & { progress: MailboxDiscoveryProgress | null };

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
  const owners = await getDb(db)
    .select({
      id: run.id,
      status: run.status,
      failureCode: run.failureCode,
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
        sql`${run.input}->>'mailboxId' = ${input.mailboxId}`,
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
                runHasLiveExecution(execution),
              ),
              and(
                eq(run.status, runStatus.enum.failed),
                eq(run.failureCode, "job_failed"),
                runHasLiveExecution({ ...execution, requireAttempt: true }),
              ),
            ),
          ),
        ),
      ),
    );
  return owners.map((owner) => ({
    ...owner,
    progress: mailboxDiscoveryProgress.safeParse(owner.progress).data ?? null,
  }));
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

/** Call only while holding this mailbox's admission lock in the same transaction. */
export async function mailDiscoveryAdmission(
  db: Database,
  input: {
    ledgerPartyId: string;
    mailboxId: string;
    scope: MailboxDiscoveryScope;
    runId?: RunId;
    recovery: boolean;
  },
): Promise<"available" | "scope_busy" | "capacity"> {
  const owners = await readMailDiscoveryOwners(db, input);
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
  const conflicts = (scope: MailboxDiscoveryScope) =>
    scope.kind === "mailbox" ||
    input.scope.kind === "mailbox" ||
    scope.key === input.scope.key;
  if (
    active.length >= MAIL_DISCOVERY_CAPACITY ||
    active.some((owner) => scopeOf(owner).kind === "mailbox")
  )
    return "capacity";
  if (active.some((owner) => conflicts(scopeOf(owner)))) return "scope_busy";
  const requestTime = (owner: (typeof owners)[number]) =>
    owner.progress?.admissionRequestedAt ?? "";
  const candidate = owners.find((owner) => owner.id === input.runId);
  const older = queued.filter(
    (owner) =>
      !candidate ||
      requestTime(owner) < requestTime(candidate) ||
      (requestTime(owner) === requestTime(candidate) &&
        owner.id < candidate.id),
  );
  // An exclusive waiter drains existing owners instead of losing every vacancy
  // to a fresh continuation. Query recovery reserves one otherwise free lane.
  if (older.some((owner) => scopeOf(owner).kind === "mailbox"))
    return "capacity";
  if (older.some((owner) => conflicts(scopeOf(owner)))) return "scope_busy";
  if (
    input.recovery &&
    input.scope.kind === "query" &&
    active.filter((owner) => owner.progress?.admissionClass === "recovery")
      .length >=
      MAIL_DISCOVERY_CAPACITY - 1
  )
    return "capacity";
  return input.recovery ||
    queued.length === 0 ||
    active.length < MAIL_DISCOVERY_CAPACITY - 1
    ? "available"
    : "capacity";
}
