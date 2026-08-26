import type { AuditEntityType, AuditJsonValue } from "@cubby/schemas/audit";
import { sortBy } from "es-toolkit";
import { Bot, ChevronDown, ChevronRight } from "lucide-react";
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
import { getStatusBadgeProps } from "~/lib/status-colors";
import { cn } from "~/lib/utils";
import { HoverableTimestamp } from "../HoverableTimestamp";
import { AuditEntityLink } from "./audit-entity-link";

function formatChangeValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "(empty)";
  if (typeof value === "object") return JSON.stringify(value);
  const str = String(value);
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
const CHANGE_FIELD_LABELS: Record<string, string> = {
  displayLabel: "label",
  postedDate: "posted",
  productQuantity: "quantity",
  rawDescription: "description",
  sourceCategory: "category",
  statedTotal: "total",
  transactionDate: "date",
  verifiedAt: "verified",
};

function humanizeChangeField(field: string): string {
  return (
    CHANGE_FIELD_LABELS[field] ??
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
  if (typeof value === "boolean") {
    return { text: value ? "yes" : "no", mono: false };
  }
  if (typeof value === "number") {
    return { text: formatLedgerNumber(value), mono: true };
  }
  if (typeof value === "string") {
    return {
      text:
        value.length > LEDGER_VALUE_CHARS
          ? `${value.slice(0, LEDGER_VALUE_CHARS)}\u2026`
          : value,
      mono: LEDGER_SHORTCODE.test(value),
    };
  }
  if (Array.isArray(value)) {
    return { text: `${value.length} items`, mono: true };
  }
  // `Amount` is by far the most common object diff on the home feed — an
  // inventory quantity change is unreadable as raw JSON and obvious as "3 ea".
  const { value: quantity, unit } = value;
  return typeof quantity === "number" && typeof unit === "string"
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

function ChangesList({
  changes,
}: {
  changes: Record<string, { from: unknown; to: unknown }>;
}) {
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

export function AuditLogEntryComponent({
  entry,
  showEntityLink = true,
  step,
  variant = "default",
}: AuditLogEntryProps) {
  const [isOpen, setIsOpen] = useState(false);
  const hasChanges = entry.changes && Object.keys(entry.changes).length > 0;

  const fallbackEntityLabel = entityLabel(entry.entityType as AuditEntityType);
  const action = getStatusBadgeProps("audit", entry.action);

  if (variant === "ledger") {
    // A create or delete has no interesting "from" side, so its verb IS the
    // news; an update's verb is the one thing the reader can already assume.
    const summary =
      entry.action === "update" ? summarizeChanges(entry.changes) : null;

    return (
      <AuditTimelineItem step={step} className="not-last:pb-2">
        <AuditTimelineIndicator className="size-2 border-0 bg-primary ring-2 ring-background" />
        <AuditTimelineSeparator className="left-[-1.5rem] h-[calc(100%-0.5rem)] translate-y-2 bg-border" />
        <AuditTimelineContent>
          {/* Desktop keeps the dense 28px ledger row; phones raise it to the
              44px floor, since each row is a link to the entity it names. */}
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
                  <span className="truncate font-medium text-sm">
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

  const userInitials = entry.user?.name
    ? entry.user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "SY";

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
                    <span className="font-medium text-sm">
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

                {entry.user ? (
                  <Description as="span">
                    by {entry.user.name ?? entry.user.email}
                  </Description>
                ) : (
                  <Description as="span">by System</Description>
                )}

                <span className="text-muted-foreground text-xs">
                  <HoverableTimestamp timestamp={entry.createdAt} />
                </span>
              </Row>

              {hasChanges && (
                <CollapsibleTrigger className="mt-1 flex min-h-11 items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-foreground md:mt-2 md:min-h-0">
                  {isOpen ? (
                    <ChevronDown className="size-3" />
                  ) : (
                    <ChevronRight className="size-3" />
                  )}
                  {Object.keys(entry.changes!).length} field
                  {Object.keys(entry.changes!).length > 1 ? "s" : ""} changed
                </CollapsibleTrigger>
              )}

              <CollapsibleContent className="mt-2">
                {entry.changes && (
                  <MutedBox padding="sm">
                    <ChangesList
                      changes={
                        entry.changes as Record<
                          string,
                          { from: unknown; to: unknown }
                        >
                      }
                    />
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
