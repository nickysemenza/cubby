import type { AuditJsonValue, AuditLogListOut } from "@cubby/schemas/audit";
import { parseShortcode } from "@cubby/shared";
import { countLabel } from "@cubby/shared/pluralize";
import { RobotIcon } from "@phosphor-icons/react/dist/csr/Robot";
import { sortBy } from "es-toolkit";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { formatCount } from "~/lib/number-format";
import { getStatusBadgeProps } from "~/lib/status-colors";
import { cn } from "~/lib/utils";
import { DateDisplay } from "~/ui/common/date-display";
import type { Fact } from "~/ui/common/fact-list";
import {
  type RecordColumn,
  RecordDetail,
  RecordDot,
  RecordRow,
} from "~/ui/common/record-list";
import { Row, Stack } from "~/ui/layout";
import { MutedBox } from "~/ui/layout/muted-box";
import { Avatar, AvatarFallback, AvatarImage } from "~/ui/primitives/avatar";
import { InlineTextDiff } from "~/ui/text/inline-text-diff";

import { foldedFields } from "./audit-log-fold";

type AuditLogEntry = AuditLogListOut["entries"][number];
type AuditChanges = NonNullable<AuditLogEntry["changes"]>;
type AuditJsonObject = { [key: string]: AuditJsonValue };

function isAuditObject(
  value: AuditJsonValue | undefined,
): value is AuditJsonObject {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function isAuditBoolean(value: AuditJsonValue | undefined): value is boolean {
  return typeof value === "boolean";
}

function isAuditNumber(value: AuditJsonValue | undefined): value is number {
  return typeof value === "number";
}

function isAuditString(value: AuditJsonValue | undefined): value is string {
  return typeof value === "string";
}

function formatChangeValue(value: AuditJsonValue | undefined): string {
  if (value === null || value === undefined || value === "") return "(empty)";
  const str =
    isAuditObject(value) || Array.isArray(value)
      ? JSON.stringify(value)
      : String(value);
  return str.length > 500 ? `${str.slice(0, 500)}...` : str;
}

/**
 * Fields whose diffs are bookkeeping rather than news. They aren't hidden — the
 * ledger falls back to them when nothing more interesting changed — they just
 * lose the fight for the one line a row gets.
 */
const LOW_SIGNAL_CHANGE_FIELDS = new Set([
  "embedding",
  "externalIds",
  "sortOrder",
  "sourceRefs",
  "totals",
  "updatedAt",
]);

/** Column names whose camel-case split still doesn't read as English. */
const CHANGE_FIELD_LABELS = {
  displayLabel: "label",
  postedDate: "posted",
  productQuantity: "quantity",
  rawDescription: "description",
  sourceCategory: "category",
  statedTotal: "total",
  transactionDate: "date",
  verifiedAt: "verified",
} satisfies Record<string, string>;

function isChangeFieldLabel(
  field: string,
): field is keyof typeof CHANGE_FIELD_LABELS {
  return field in CHANGE_FIELD_LABELS;
}

function humanizeChangeField(field: string): string {
  return (
    (isChangeFieldLabel(field) ? CHANGE_FIELD_LABELS[field] : undefined) ??
    field
      // A resolved FK reads as the thing it points at ("location", not
      // "location id") — the id itself is already rendered as a shortcode.
      .replace(/Id$/u, "")
      .replace(/([a-z\d])([A-Z])/gu, "$1 $2")
      .toLowerCase()
  );
}

const LEDGER_VALUE_CHARS = 22;
const LEDGER_MAX_FIELDS = 2;

/** `mono` carries the Three Voices Rule: measures and codes get the mono face. */
type LedgerValue = { text: string; mono: boolean };

/**
 * One side of a diff, compressed to something that fits on a ledger line.
 * Returns null for values with no glanceable rendering (empty, or a nested
 * object that isn't an `Amount`), which drops the field from the summary.
 */
function formatLedgerValue(
  value: AuditJsonValue | undefined,
): LedgerValue | null {
  if (value === undefined || value === null || value === "") return null;
  if (isAuditBoolean(value)) {
    return { text: value ? "yes" : "no", mono: false };
  }
  if (isAuditNumber(value)) {
    return { text: formatCount(value, 2), mono: true };
  }
  if (isAuditString(value)) {
    return {
      text:
        value.length > LEDGER_VALUE_CHARS
          ? `${value.slice(0, LEDGER_VALUE_CHARS)}\u2026`
          : value,
      mono: parseShortcode(value) !== null,
    };
  }
  if (Array.isArray(value)) {
    return { text: countLabel(value.length, "item"), mono: true };
  }
  if (!isAuditObject(value)) return null;
  // `Amount` is by far the most common object diff on the home feed — an
  // inventory quantity change is unreadable as raw JSON and obvious as "3 ea".
  const { value: quantity, unit } = value;
  return isAuditNumber(quantity) && isAuditString(unit)
    ? { text: `${formatCount(quantity, 2)} ${unit}`, mono: true }
    : null;
}

/**
 * Rank a `changes` map down to the 1–2 fields worth a glance, plus how many
 * were left out — the omitted count is the disclosure that keeps a one-line
 * renderer honest about being a projection of the full diff.
 */
export function summarizeChanges(
  changes: AuditLogEntry["changes"],
): { shown: LedgerField[]; omitted: number } | null {
  if (!changes) return null;
  const changed = Object.entries(changes);
  const renderable = changed
    .map(([field, diff]) => ({
      field,
      from: formatLedgerValue(diff.from),
      to: formatLedgerValue(diff.to),
    }))
    .filter((entry) => entry.from !== null || entry.to !== null);
  if (renderable.length === 0) return null;

  const ranked = sortBy(renderable, [
    (entry) => (LOW_SIGNAL_CHANGE_FIELDS.has(entry.field) ? 1 : 0),
  ]);
  const shown = ranked.slice(0, LEDGER_MAX_FIELDS);
  // Counted against every changed field, not just the renderable ones. A
  // field with no glanceable rendering (an object-valued `totals`
  // diff, which is exactly what a recompute-style update touches) is dropped
  // from the line — but dropping it from the count too would let the row claim
  // it changed less than it did, which is the one thing this disclosure exists
  // to prevent.
  return { shown, omitted: changed.length - shown.length };
}

type LedgerField = {
  field: string;
  from: LedgerValue | null;
  to: LedgerValue | null;
};

type AuditReferences = AuditLogEntry["references"];

/** A relationship code reads as the record it names; anything else as text. */
function LedgerValueText({
  value,
  references,
  className,
}: {
  value: LedgerValue;
  references: AuditReferences;
  className?: string;
}) {
  const parsed = value.mono ? parseShortcode(value.text) : null;
  const reference = parsed ? references[parsed.shortcode] : undefined;
  if (parsed && reference) {
    return (
      <EntityRefLink
        variant="audit"
        entityKind={parsed.type}
        entityId={parsed.shortcode}
        name={reference.name}
        displayImage={reference.displayImage}
        compact
        className={cn("gap-1 text-xs font-normal", className)}
      />
    );
  }
  return (
    <span className={cn("truncate", value.mono && "font-mono", className)}>
      {value.text}
    </span>
  );
}

function LedgerChangeSummary({
  shown,
  omitted,
  references,
}: {
  shown: LedgerField[];
  omitted: number;
  references: AuditReferences;
}) {
  return (
    <Row align="baseline" gap="sm" className="min-w-0 text-xs">
      {shown.map(({ field, from, to }) => (
        <Row key={field} align="baseline" gap="tight" className="min-w-0">
          <span className="shrink-0 text-muted-foreground">
            {humanizeChangeField(field)}
          </span>
          {from && (
            <LedgerValueText
              value={from}
              references={references}
              className="text-muted-foreground"
            />
          )}
          <span className="shrink-0 text-slate">&rarr;</span>
          {to ? (
            <LedgerValueText value={to} references={references} />
          ) : (
            <span className="truncate">(empty)</span>
          )}
        </Row>
      ))}
      {omitted > 0 && (
        <span className="shrink-0 font-mono text-2xs text-slate">
          +{omitted}
        </span>
      )}
    </Row>
  );
}

function ChangesList({ changes }: { changes: AuditChanges }) {
  return (
    <Stack gap="xs">
      {Object.entries(changes).map(([field, { from, to }]) => (
        <Row key={field} align="start" gap="xs" className="min-w-0 text-xs">
          <span className="font-medium text-muted-foreground">{field}:</span>
          {(typeof from === "string" || from == null) &&
          (typeof to === "string" || to == null) ? (
            <InlineTextDiff
              before={from ?? ""}
              after={to ?? ""}
              beforeLabel="Previous"
              afterLabel="Applied"
              wrap
            />
          ) : (
            <>
              <span className="text-foreground">{formatChangeValue(from)}</span>
              <span className="text-muted-foreground">&rarr;</span>
              <span className="text-foreground">{formatChangeValue(to)}</span>
            </>
          )}
        </Row>
      ))}
    </Stack>
  );
}

/** "Claude · Kitchen iPad": the client and device behind a write; the run links separately. */
export const AUDIT_COLUMNS = [
  { id: "client", label: "Client" },
  { id: "device", label: "Device" },
  { id: "run", label: "Run" },
] as const satisfies readonly RecordColumn[];

/** Which client, device and Run carried the change, keyed by `AUDIT_COLUMNS`. */
export const auditFacts = (entry: AuditLogEntry): Fact[] => [
  ...(entry.oauthClient
    ? [
        {
          id: "client",
          label: "Client",
          value: entry.oauthClient.name ?? "OAuth client",
        },
      ]
    : []),
  ...(entry.device
    ? [
        {
          id: "device",
          label: "Device",
          value: entry.device.name ?? entry.device.id,
        },
      ]
    : []),
  ...(entry.runId
    ? [
        {
          id: "run",
          label: "Run",
          value: (
            <EntityRefLink
              variant="chip"
              entity="run"
              id={entry.runId}
              name={entry.runId}
              displayImage={null}
              emoji={null}
            />
          ),
        },
      ]
    : []),
];

const actorName = (entry: AuditLogEntry) =>
  entry.user ? (entry.user.name ?? entry.user.email) : "System";

const auditUserInitials = (user: AuditLogEntry["user"]): string => {
  if (!user?.name) return "SY";
  return user.name
    .split(" ")
    .map((name) => name[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
};

/** The writer as an initial badge; the full "by …" reads in its title and to assistive tech. */
function AuditActor({ entry }: { entry: AuditLogEntry }) {
  const name = actorName(entry);
  return (
    <Avatar className="size-4 shrink-0" title={`by ${name}`}>
      {entry.user?.image ? <AvatarImage src={entry.user.image} alt="" /> : null}
      <AvatarFallback
        className={cn(
          "text-[0.5625rem]",
          !entry.user && "bg-muted text-muted-foreground",
        )}
      >
        {entry.user ? (
          auditUserInitials(entry.user)
        ) : (
          <RobotIcon className="size-2.5" />
        )}
      </AvatarFallback>
      <span className="sr-only">by {name}</span>
    </Avatar>
  );
}

const ACTION_TONE = {
  create: "positive",
  update: undefined,
  delete: "destructive",
} as const;

/** One audit event, or a folded burst of updates, as a timeline row. */
export function AuditRecordRow({
  group,
  showEntityLink,
}: {
  group: readonly AuditLogEntry[];
  showEntityLink: boolean;
}) {
  const [entry] = group;
  if (!entry) return null;
  const action = getStatusBadgeProps("audit", entry.action);
  const folded = group.length > 1;
  const fields = folded ? foldedFields(group) : undefined;
  // A burst shows its newest diff merged over the older ones' fields.
  const changes: AuditChanges | null = folded
    ? Object.assign(
        {},
        ...[...group].reverse().map((item) => item.changes ?? {}),
      )
    : entry.changes;
  const summary = entry.action === "update" ? summarizeChanges(changes) : null;
  const references: AuditReferences = folded
    ? Object.assign({}, ...group.map((item) => item.references))
    : entry.references;
  const changedCount = Object.keys(changes ?? {}).length;
  const shownCount = summary?.shown.length ?? 0;
  return (
    <RecordRow
      leading={
        <RecordDot tone={ACTION_TONE[entry.action]} label={action.label} />
      }
      primary={
        <>
          {showEntityLink && entry.entityId ? (
            <EntityRefLink
              variant="audit"
              entityKind={entry.entityKind}
              entityId={entry.entityId}
              name={entry.entityName}
              displayImage={entry.displayImage}
              compact
            />
          ) : null}
          <span
            className={cn(
              "shrink-0",
              showEntityLink && entry.entityId
                ? "text-xs text-muted-foreground"
                : "font-medium",
            )}
          >
            {folded && fields
              ? `${countLabel(group.length, "update")} · ${countLabel(fields.size, "field")}`
              : action.label}
          </span>
        </>
      }
      secondary={
        summary ? (
          <LedgerChangeSummary
            shown={summary.shown}
            omitted={0}
            references={references}
          />
        ) : null
      }
      facts={auditFacts(entry)}
      trailing={
        <span className="inline-flex items-center gap-1.5">
          <AuditActor entry={entry} />
          <DateDisplay timestamp={entry.createdAt} />
        </span>
      }
      detail={
        changes && changedCount > shownCount ? (
          <RecordDetail
            summary={
              shownCount > 0
                ? `${countLabel(changedCount - shownCount, "more field")}`
                : `${countLabel(changedCount, "field")} changed`
            }
          >
            <MutedBox padding="sm">
              <ChangesList changes={changes} />
            </MutedBox>
          </RecordDetail>
        ) : null
      }
    />
  );
}
