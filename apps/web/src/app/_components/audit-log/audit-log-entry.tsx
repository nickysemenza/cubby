import type { AuditJsonValue } from "@cubby/schemas/audit";
import { CaretDownIcon as ChevronDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretRightIcon as ChevronRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { RobotIcon as Bot } from "@phosphor-icons/react/dist/csr/Robot";
import { sortBy } from "es-toolkit";
import { useState } from "react";

import { Row, Stack } from "~/components/layout";
import { MutedBox } from "~/components/layout/muted-box";
import {
  AuditTimelineContent,
  AuditTimelineIndicator,
  AuditTimelineItem,
  AuditTimelineSeparator,
} from "~/components/reui/timeline";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { Description } from "~/components/ui/description";
import { EntityIcon, entityLabel } from "~/entities/entities";
import type { AuditLogEntry } from "~/lib/audit-log.functions";
import { countLabel } from "~/lib/pluralize";
import { getStatusBadgeProps } from "~/lib/status-colors";
import { cn } from "~/lib/utils";

import { HoverableTimestamp } from "../HoverableTimestamp";
import { AuditEntityLink } from "./audit-entity-link";

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
  "SourceData",
  "dataExceptions",
  "embedding",
  "notionPageId",
  "sortOrder",
  "sourceRefs",
  "totals",
  "updatedAt",
  "valuation",
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

const LEDGER_SHORTCODE = /^[A-Z]{2,4}-[A-Z\d]{4}$/u;
const LEDGER_VALUE_CHARS = 22;
const LEDGER_MAX_FIELDS = 2;

/** `mono` carries the Three Voices Rule: measures and codes get the mono face. */
type LedgerValue = { text: string; mono: boolean };

const formatLedgerNumber = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(2);

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
    return { text: formatLedgerNumber(value), mono: true };
  }
  if (isAuditString(value)) {
    return {
      text:
        value.length > LEDGER_VALUE_CHARS
          ? `${value.slice(0, LEDGER_VALUE_CHARS)}\u2026`
          : value,
      mono: LEDGER_SHORTCODE.test(value),
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
    ? { text: `${formatLedgerNumber(quantity)} ${unit}`, mono: true }
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
  // field with no glanceable rendering (an object-valued `totals`/`valuation`
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

function LedgerChangeSummary({
  shown,
  omitted,
}: {
  shown: LedgerField[];
  omitted: number;
}) {
  return (
    <Row align="baseline" gap="sm" className="min-w-0 text-xs">
      {shown.map(({ field, from, to }) => (
        <Row key={field} align="baseline" gap="tight" className="min-w-0">
          <span className="shrink-0 font-mono text-2xs text-slate uppercase">
            {humanizeChangeField(field)}
          </span>
          {from && (
            <span
              className={cn(
                "truncate text-muted-foreground",
                from.mono && "font-mono",
              )}
            >
              {from.text}
            </span>
          )}
          <span className="shrink-0 text-slate">&rarr;</span>
          <span className={cn("truncate", to?.mono && "font-mono")}>
            {to ? to.text : "(empty)"}
          </span>
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
        <Row key={field} align="center" gap="xs" className="text-xs">
          <span className="font-medium text-muted-foreground">{field}:</span>
          <span className="text-foreground">{formatChangeValue(from)}</span>
          <span className="text-muted-foreground">&rarr;</span>
          <span className="text-foreground">{formatChangeValue(to)}</span>
        </Row>
      ))}
    </Stack>
  );
}

interface AuditLogEntryProps {
  entry: AuditLogEntry;
  showEntityLink?: boolean;
  step: number;
  /**
   * "ledger" renders a glanceable single line (name + one-line diff ... time)
   * with no avatar, timeline, or expandable change detail — the home feed. The
   * diff is a projection: it shows at most two fields and discloses the rest as
   * an omitted count.
   */
  variant?: "default" | "ledger";
}

function LedgerAuditEntry({
  entry,
  showEntityLink,
  step,
}: Omit<AuditLogEntryProps, "variant">) {
  const fallbackEntityLabel = entityLabel(entry.entityType);
  const action = getStatusBadgeProps("audit", entry.action);
  const summary =
    entry.action === "update" ? summarizeChanges(entry.changes) : null;
  return (
    <AuditTimelineItem step={step} className="not-last:pb-2">
      <AuditTimelineIndicator className="size-2 border-0 bg-primary ring-2 ring-background" />
      <AuditTimelineSeparator className="left-[-1.5rem] h-[calc(100%-0.5rem)] translate-y-2 bg-border" />
      <AuditTimelineContent>
        <Row
          align="center"
          justify="between"
          gap="sm"
          className="min-h-11 sm:min-h-7"
        >
          <Row align="center" gap="sm" className="min-w-0">
            {showEntityLink && entry.entityId ? (
              <AuditEntityLink
                entityType={entry.entityType}
                entityId={entry.entityId}
                name={entry.entityName}
                displayImage={entry.displayImage}
                compact
              />
            ) : (
              <>
                <EntityIcon
                  entity={entry.entityType}
                  colored
                  className="size-4 flex-shrink-0"
                />
                <span className="truncate text-sm font-medium">
                  {entry.entityName ?? fallbackEntityLabel}
                </span>
              </>
            )}
            {summary ? (
              <LedgerChangeSummary
                shown={summary.shown}
                omitted={summary.omitted}
              />
            ) : (
              <Badge
                variant="secondary"
                className={cn("text-2xs", action.className)}
              >
                {action.label}
              </Badge>
            )}
          </Row>
          <span className="shrink-0 text-muted-foreground">
            <HoverableTimestamp timestamp={entry.createdAt} />
          </span>
        </Row>
      </AuditTimelineContent>
    </AuditTimelineItem>
  );
}

/** "Claude · Kitchen iPad · RUN-4K7M": the client, device and run behind a write. */
const auditVia = (entry: AuditLogEntry): string | null => {
  const parts = [
    entry.oauthClient ? (entry.oauthClient.name ?? "OAuth client") : null,
    entry.device ? (entry.device.name ?? entry.device.id) : null,
    entry.runId,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
};

function AuditActor({ entry }: { entry: AuditLogEntry }) {
  const via = auditVia(entry);
  return (
    <>
      <Description as="span">
        by {entry.user ? (entry.user.name ?? entry.user.email) : "System"}
      </Description>
      {via && <Description as="span">via {via}</Description>}
    </>
  );
}

const auditUserInitials = (user: AuditLogEntry["user"]): string => {
  if (!user?.name) return "SY";
  return user.name
    .split(" ")
    .map((name) => name[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
};

export function AuditLogEntryComponent({
  entry,
  showEntityLink = true,
  step,
  variant = "default",
}: AuditLogEntryProps) {
  const [isOpen, setIsOpen] = useState(false);
  const changes = entry.changes;
  const hasChanges = changes !== null && Object.keys(changes).length > 0;

  const fallbackEntityLabel = entityLabel(entry.entityType);
  const action = getStatusBadgeProps("audit", entry.action);

  if (variant === "ledger") {
    return (
      <LedgerAuditEntry
        entry={entry}
        showEntityLink={showEntityLink}
        step={step}
      />
    );
  }

  const userInitials = auditUserInitials(entry.user);

  return (
    <AuditTimelineItem step={step}>
      <AuditTimelineIndicator className="size-3 border-0 bg-primary ring-4 ring-background" />
      <AuditTimelineSeparator className="bg-border" />
      <AuditTimelineContent>
        <Collapsible open={isOpen} onOpenChange={setIsOpen}>
          <Row align="start" gap="sm">
            <Avatar className="size-6 flex-shrink-0">
              {entry.user?.image ? (
                <AvatarImage
                  src={entry.user.image}
                  alt={entry.user.name ?? ""}
                />
              ) : null}
              <AvatarFallback
                className={cn(
                  "text-xs",
                  !entry.user && "bg-muted text-muted-foreground",
                )}
              >
                {entry.user ? userInitials : <Bot className="size-4" />}
              </AvatarFallback>
            </Avatar>

            <div className="min-w-0 flex-1">
              <Row align="center" gap="sm" wrap>
                {showEntityLink && entry.entityId ? (
                  <AuditEntityLink
                    entityType={entry.entityType}
                    entityId={entry.entityId}
                    name={entry.entityName}
                    displayImage={entry.displayImage}
                    compact
                  />
                ) : (
                  <>
                    <EntityIcon
                      entity={entry.entityType}
                      colored
                      className="size-4 flex-shrink-0"
                    />
                    <span className="text-sm font-medium">
                      {entry.entityName ?? fallbackEntityLabel}
                    </span>
                  </>
                )}

                <Badge
                  variant="secondary"
                  className={cn("text-xs", action.className)}
                >
                  {action.label}
                </Badge>

                <AuditActor entry={entry} />

                <span className="text-xs text-muted-foreground">
                  <HoverableTimestamp timestamp={entry.createdAt} />
                </span>
              </Row>

              {changes && hasChanges && (
                <CollapsibleTrigger className="mt-1 flex min-h-11 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground md:mt-2 md:min-h-0">
                  {isOpen ? (
                    <ChevronDown className="size-3" />
                  ) : (
                    <ChevronRight className="size-3" />
                  )}
                  {Object.keys(changes).length} field
                  {Object.keys(changes).length > 1 ? "s" : ""} changed
                </CollapsibleTrigger>
              )}

              <CollapsibleContent className="mt-2">
                {changes && (
                  <MutedBox padding="sm">
                    <ChangesList changes={changes} />
                  </MutedBox>
                )}
              </CollapsibleContent>
            </div>
          </Row>
        </Collapsible>
      </AuditTimelineContent>
    </AuditTimelineItem>
  );
}
