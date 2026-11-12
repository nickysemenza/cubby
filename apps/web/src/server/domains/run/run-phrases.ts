import type { MailRunOutcomeCounts } from "@cubby/schemas/email-fields";
/**
 * The words a Run reads as on every surface: its what-title, the Why line
 * (from its cause, parent Run and input, relative to the viewer), the What
 * line (its kind and input scope), the outcome so far, the short state reason,
 * what waits on a member, and its progress as a `ProgressValue`. Pure: the Run
 * read binding (`repo/run.ts`) loads every input in its page batches, so no
 * phrase costs a query or a model call.
 */
import type { DisplayItem } from "@cubby/schemas/entity-definitions/label-field";
import { mailboxDiscoveryInput } from "@cubby/schemas/mailbox-research";
import type { ProgressValue } from "@cubby/schemas/progress";
import {
  mailResearchRunInput,
  orderMailImportRunInput,
  orderMailImportRunOrders,
  RUN_KINDS,
  RUN_PURPOSE_LABEL,
  runPurpose,
  runWorkLabel,
  sweepRunInput,
  type RunPurpose,
} from "@cubby/schemas/run-fields";
import type { RunWorkProgress } from "@cubby/schemas/run-work-progress";
import { z } from "zod";

/** The stored Run columns the phrases read. */
export type RunPhraseRow = {
  purpose: string;
  trigger: string;
  cause: string | null;
  status: string;
  input: unknown;
  progress: unknown;
  actorUserId: string;
  actorName: string;
  vendorId: string | null;
  failureCode: string | null;
  dispatchError: string | null;
  ordersSeen: number;
  imported: number;
  updated: number;
  skipped: number;
};

/** A linked Run or import named in a phrase: its public code and its kind. */
type LinkedRecord = { entity: string; code: string; label: string | null };

/** Everything the page batches loaded for one Run. */
export type RunPhraseContext = {
  /** The user reading the response; "You" is relative to them. */
  viewerUserId: string | null;
  vendorName: string | null;
  partyName: string | null;
  parent: LinkedRecord | null;
  predecessor: LinkedRecord | null;
  /** The TransactionImport a statement Sweep names in `scope.importId`. */
  importRecord: LinkedRecord | null;
  /** Subjects of the Emails a Mail import holds, in roster order. */
  emailSubjects: readonly string[];
  successorCode: string | null;
  displayStatus: string;
  stalled: boolean;
  outcomeCounts: MailRunOutcomeCounts | null;
  workProgress: RunWorkProgress | null;
  wallTime: string;
};

const ENDED = new Set([
  "completed",
  "failed",
  "dispatch_failed",
  "needs_review",
]);
const FAILED = new Set(["failed", "dispatch_failed"]);

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

const purposeOf = (row: RunPhraseRow): RunPurpose | null =>
  runPurpose.safeParse(row.purpose).data ?? null;

const kindLabel = (purpose: string | null) => {
  const parsed = runPurpose.safeParse(purpose);
  return parsed.success ? RUN_PURPOSE_LABEL[parsed.data] : "Run";
};

/** `categoryId` → `category`, `brandName` → `brand name`. */
const fieldWords = (key: string) =>
  key
    .replace(/Id$/u, "")
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .toLowerCase();

const sweepTargets = (input: unknown) => {
  const sweep = sweepRunInput.safeParse(input);
  if (!sweep.success) return null;
  const field = sweep.data.families.find((entry) => entry.family === "field");
  const statement = sweep.data.families.find(
    (entry) => entry.family === "statement_transaction",
  );
  const targets =
    field?.family === "field" ? (field.scope.targets ?? null) : null;
  return {
    statement:
      statement?.family === "statement_transaction" ? statement.scope : null,
    targets,
  };
};

const photoCount = (input: unknown) => {
  const batches = z
    .object({
      kind: z.literal("photo_inventory"),
      batches: z.array(z.object({ imageCount: z.number().int() })),
    })
    .safeParse(input);
  return batches.success
    ? batches.data.batches.reduce((sum, batch) => sum + batch.imageCount, 0)
    : null;
};

const mailSourceCount = (input: unknown) => {
  const research = mailResearchRunInput.safeParse(input);
  if (research.success) return research.data.sources.length;
  const orders = orderMailImportRunInput.safeParse(input);
  return orders.success ? orderMailImportRunOrders(orders.data).length : null;
};

/** "{Verb} {object}": what the Run does, never who ran it. */
export function runTitle(row: RunPhraseRow, context: RunPhraseContext): string {
  const purpose = purposeOf(row);
  const total = context.workProgress?.current.total ?? null;
  const unit = context.workProgress?.current.unit ?? null;
  if (purpose === "mail_import" || mailSourceCount(row.input) !== null) {
    const count = mailSourceCount(row.input);
    const subjects = context.emailSubjects;
    if (subjects.length > 0) {
      const shown = subjects.slice(0, 2).join(", ");
      const more = (count ?? subjects.length) - Math.min(subjects.length, 2);
      return `${plural(count ?? subjects.length, "email")}: ${shown}${more > 0 ? `, +${more}` : ""}`;
    }
    const emails =
      count === null ? "order email" : plural(count, "order email");
    return `Import ${emails}${context.vendorName ? ` from ${context.vendorName}` : ""}`;
  }
  if (purpose === "mail_discovery") {
    const input = mailboxDiscoveryInput.safeParse(row.input);
    const mailbox = input.success ? input.data.mailboxId : null;
    const scoped = z
      .object({ discoveryScope: z.object({ kind: z.literal("query") }) })
      .safeParse(row.progress).success;
    return mailbox
      ? `${scoped ? "Search" : "Scan"} inbox ${mailbox}`
      : "Scan inbox";
  }
  if (purpose === "sweep") {
    const scope = sweepTargets(row.input);
    const counted =
      total !== null && unit ? ` for ${plural(total, unit, unit)}` : "";
    if (scope?.statement && !scope.targets)
      return total !== null
        ? `Categorize ${plural(total, "statement line")}`
        : "Categorize statement lines";
    const [target] = scope?.targets ?? [];
    if (scope?.targets?.length === 1 && target && target.fields.length === 1)
      return `Sweep ${fieldWords(target.entity)} ${fieldWords(target.fields[0]!)}${counted}`;
    return total !== null && unit
      ? `Sweep ${plural(total, unit, unit)}`
      : "Sweep suggestions";
  }
  if (purpose === "photo_inventory") {
    const photos = photoCount(row.input);
    return photos ? `Review ${plural(photos, "photo")}` : "Review photos";
  }
  return `${runWorkLabel(row)} · ${context.vendorName ?? context.partyName ?? row.actorName}`;
}

const linkItem = (title: string, record: LinkedRecord | null): DisplayItem => ({
  entity: record?.entity ?? null,
  id: record?.code ?? null,
  title,
  subtitle: null,
  trailing: null,
});

/**
 * Why the Run exists, from its recorded cause and lineage. Null when the cause
 * was never recorded; clients draw that as not recorded, never as automatic.
 */
export function runWhyLine(
  row: RunPhraseRow,
  context: RunPhraseContext,
): DisplayItem | null {
  if (context.predecessor)
    return linkItem(
      `Retry of ${context.predecessor.code}`,
      context.predecessor,
    );
  const parentKind = context.parent ? kindLabel(context.parent.label) : null;
  switch (row.cause) {
    case "member_request":
      return linkItem(
        context.viewerUserId === row.actorUserId
          ? "You started this"
          : `${row.actorName} started this`,
        null,
      );
    case "import_completed": {
      const after = context.parent ?? context.importRecord;
      return after
        ? linkItem(
            `After ${context.parent ? parentKind : "import"} ${after.code}`,
            after,
          )
        : linkItem("After an import", null);
    }
    case "source_discovered":
      return context.parent
        ? linkItem(
            `Found by ${parentKind} ${context.parent.code}`,
            context.parent,
          )
        : linkItem("Found in new mail", null);
    case "retry":
      return linkItem("Retry", null);
    case "scheduled":
      return linkItem("Scheduled", null);
    case "evidence_changed":
      return context.parent
        ? linkItem(`Evidence changed on ${context.parent.code}`, context.parent)
        : linkItem("Evidence changed", null);
    default:
      return null;
  }
}

/** The kind and the input it covers, for the detail header. */
export function runWhatLine(
  row: RunPhraseRow,
  context: RunPhraseContext,
): string | null {
  const purpose = purposeOf(row);
  const sources = mailSourceCount(row.input);
  if (sources !== null)
    return `${plural(sources, "retained Email")} checked for purchases${context.vendorName ? ` from ${context.vendorName}` : ""}`;
  if (purpose === "mail_discovery") {
    const input = mailboxDiscoveryInput.safeParse(row.input);
    if (!input.success) return RUN_KINDS.mail_discovery.description;
    const policy =
      input.data.executionPolicy === "import"
        ? "relevant mail goes to Email import"
        : "classification only";
    return `New mail in ${input.data.mailboxId}; ${policy}`;
  }
  if (purpose === "sweep") {
    const scope = sweepTargets(row.input);
    const parts = [
      ...(scope?.statement
        ? [
            context.importRecord
              ? `Statement lines from import ${context.importRecord.code}`
              : "Statement lines",
          ]
        : []),
      ...(scope?.targets ?? []).map(
        (target) =>
          `${fieldWords(target.entity)} ${target.fields.map(fieldWords).join(", ")}`,
      ),
    ];
    const total = context.workProgress?.current.total ?? null;
    const unit = context.workProgress?.current.unit;
    return parts.length
      ? `${parts.join("; ")}${total !== null && unit ? `: ${plural(total, unit, unit)}` : ""}`
      : "Every declared decision field";
  }
  if (purpose === "photo_inventory") {
    const photos = photoCount(row.input);
    return photos ? `${plural(photos, "photo")} in one batch` : null;
  }
  return purpose ? RUN_KINDS[purpose].description : null;
}

const joined = (parts: readonly (string | null | false)[]) =>
  parts.filter((part): part is string => Boolean(part)).join(" · ");

/**
 * What the Run changed, from its recorded counts and end state: "2 imported ·
 * 1 needs you before it failed". While it runs the last phrase says "so far".
 */
export function runOutcomeLine(
  row: RunPhraseRow,
  context: RunPhraseContext,
): string | null {
  const purpose = purposeOf(row);
  const ended = ENDED.has(row.status);
  const outcomes = context.outcomeCounts;
  const work = context.workProgress;
  let counts = "";
  if (outcomes) {
    counts = joined([
      outcomes.imported > 0 && `${plural(outcomes.imported, "email")} imported`,
      outcomes.linked > 0 &&
        `${outcomes.linked.toLocaleString("en-US")} linked`,
      outcomes.unrelated > 0 &&
        `${outcomes.unrelated.toLocaleString("en-US")} unrelated`,
      outcomes.needsMember > 0 &&
        `${outcomes.needsMember.toLocaleString("en-US")} need you`,
      outcomes.waiting + outcomes.needsResearch > 0 &&
        `${(outcomes.waiting + outcomes.needsResearch).toLocaleString("en-US")} waiting`,
    ]);
  } else if (purpose === "mail_discovery") {
    const progress = z
      .object({
        saved: z.number().int().default(0),
        unrelated: z.number().int().default(0),
      })
      .safeParse(row.progress);
    if (progress.success)
      counts = joined([
        progress.data.saved > 0 &&
          `${plural(progress.data.saved, "email")} saved`,
        progress.data.unrelated > 0 &&
          `${progress.data.unrelated.toLocaleString("en-US")} skipped`,
      ]);
  } else if (row.ordersSeen + row.imported + row.updated + row.skipped > 0) {
    counts = joined([
      row.imported > 0 && `${plural(row.imported, "order")} imported`,
      row.updated > 0 && `${row.updated.toLocaleString("en-US")} updated`,
      row.skipped > 0 && `${row.skipped.toLocaleString("en-US")} skipped`,
    ]);
  } else if (work) {
    const phases = [...work.completed, work.current];
    const processed = phases.reduce((sum, phase) => sum + phase.processed, 0);
    const failures = phases.reduce((sum, phase) => sum + phase.failures, 0);
    counts = joined([
      processed > 0 &&
        `${plural(processed, work.current.unit, work.current.unit)} checked`,
      failures > 0 && `${failures.toLocaleString("en-US")} failed`,
    ]);
  }
  if (FAILED.has(row.status))
    return counts
      ? `${counts} before it failed`
      : "Nothing changed before it failed";
  if (!counts) return ended ? "Nothing changed" : "Nothing changed yet";
  return ended ? counts : `${counts} so far`;
}

const firstSentence = (text: string) => {
  const line = text.split(/\n|(?<=\.)\s/u)[0]!.trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

/**
 * The muted text after the state label: the failure, what it is doing now,
 * how long it took, or its retry. A wait and a stall draw from their own
 * fields, so the reason never repeats them.
 */
export function runStateReason(
  row: RunPhraseRow,
  context: RunPhraseContext,
): string | null {
  const status = context.displayStatus;
  if (status === "retried")
    return context.successorCode ? `Retried as ${context.successorCode}` : null;
  if (FAILED.has(status))
    return row.dispatchError
      ? firstSentence(row.dispatchError)
      : (row.failureCode?.replaceAll("_", " ") ?? null);
  if (status === "needs_review") {
    const members = context.outcomeCounts?.needsMember ?? 0;
    return members > 0 ? `${plural(members, "email")} need you` : null;
  }
  if (status === "completed") return `in ${context.wallTime}`;
  if (status === "running" && !context.stalled)
    return context.workProgress?.current.label ?? null;
  return null;
}

/** What waits on a member, for the detail side column. */
export function runOpenItems(
  row: RunPhraseRow,
  context: RunPhraseContext,
): DisplayItem[] {
  const items: DisplayItem[] = [];
  const members = context.outcomeCounts?.needsMember ?? 0;
  if (members > 0)
    items.push({
      entity: null,
      id: null,
      title: `${plural(members, "Email")} need you`,
      subtitle: "Settle them in Results",
      trailing: null,
    });
  if (context.displayStatus === "needs_review" && members === 0)
    items.push({
      entity: null,
      id: null,
      title: "Results to review",
      subtitle: null,
      trailing: null,
    });
  if (FAILED.has(context.displayStatus))
    items.push({
      entity: null,
      id: null,
      title: "The run failed",
      subtitle: runStateReason(row, context),
      trailing: null,
    });
  if (context.displayStatus === "waiting_for_funding")
    items.push({
      entity: null,
      id: null,
      title: "Waiting for AI funding",
      subtitle: "Resume with paid funding, or wait for the next window",
      trailing: null,
    });
  if (context.stalled)
    items.push({
      entity: null,
      id: null,
      title: "No progress for 15 minutes",
      subtitle: "Diagnostics show the stalled work",
      trailing: null,
    });
  return items;
}

/**
 * The Run's progress as counts: every recorded work phase when they share one
 * unit, else the current phase; a Mail import without work samples counts its
 * Emails by outcome. Remaining items are active while it runs (one at a time),
 * failed when it failed, and queued otherwise.
 */
export function runProgressMeter(
  row: RunPhraseRow,
  context: RunPhraseContext,
): ProgressValue | null {
  const work = context.workProgress;
  if (work) {
    const phases = [...work.completed, work.current];
    const shared = phases.every(
      (phase) => phase.unit === work.current.unit && phase.total !== null,
    );
    const counted = shared ? phases : [work.current];
    const failed = counted.reduce((sum, phase) => sum + phase.failures, 0);
    const processed = counted.reduce((sum, phase) => sum + phase.processed, 0);
    const total = counted.every((phase) => phase.total !== null)
      ? counted.reduce((sum, phase) => sum + (phase.total ?? 0), 0)
      : null;
    return progressFromCounts(row, context, {
      done: Math.max(0, processed - failed),
      failed,
      total,
      unit: work.current.unit,
    });
  }
  const outcomes = context.outcomeCounts;
  if (outcomes) {
    const settled = outcomes.imported + outcomes.linked + outcomes.unrelated;
    const total =
      mailSourceCount(row.input) ??
      settled +
        outcomes.waiting +
        outcomes.needsResearch +
        outcomes.needsMember;
    return progressFromCounts(row, context, {
      done: settled + outcomes.needsMember,
      failed: 0,
      total,
      unit: "emails",
    });
  }
  return null;
}

function progressFromCounts(
  row: RunPhraseRow,
  context: RunPhraseContext,
  counts: { done: number; failed: number; total: number | null; unit: string },
): ProgressValue {
  const remaining =
    counts.total === null
      ? 0
      : Math.max(0, counts.total - counts.done - counts.failed);
  const running = row.status === "running";
  const active = running && !context.stalled ? Math.min(1, remaining) : 0;
  const stalled = running && context.stalled ? Math.min(1, remaining) : 0;
  const failedRest = FAILED.has(row.status) ? remaining : 0;
  return {
    done: counts.done,
    failed: counts.failed + failedRest,
    active,
    stalled,
    queued: remaining - active - stalled - failedRest,
    total: counts.total,
    unit: counts.unit,
  };
}
