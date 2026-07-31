import type { AuditEntityType } from "@cubby/schemas/audit";
import { Bot, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Row, Stack } from "~/components/layout";
import { MutedBox } from "~/components/layout/muted-box";
import {
  TimelineContent,
  TimelineIndicator,
  TimelineItem,
  TimelineSeparator,
} from "~/components/reui/timeline";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { Description } from "~/components/ui/description";
import { EntityIcon, entities } from "~/entities/entities";
import type { RouterOutputs } from "~/integrations/trpc/react";
import { getStatusBadgeProps } from "~/lib/status-colors";
import { cn } from "~/lib/utils";
import { EntityInlineLinkById } from "../EntityInlineLinkById";
import { HoverableTimestamp } from "../HoverableTimestamp";

function formatChangeValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "(empty)";
  if (typeof value === "object") return JSON.stringify(value);
  const str = String(value);
  return str.length > 500 ? `${str.slice(0, 500)}...` : str;
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

type AuditLogEntry = RouterOutputs["auditLog"]["list"]["entries"][number];

interface AuditLogEntryProps {
  entry: AuditLogEntry;
  showEntityLink?: boolean;
  step: number;
  /**
   * "ledger" renders a glanceable single line (pill + action ... time) with no
   * avatar, timeline, or change details — used on the home feed.
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

  const entityConfig = entities[entry.entityType as AuditEntityType];
  const action = getStatusBadgeProps("audit", entry.action);

  if (variant === "ledger") {
    return (
      <TimelineItem step={step} className="not-last:pb-2">
        <TimelineIndicator className="size-2 border-0 bg-primary ring-2 ring-background" />
        <TimelineSeparator className="left-[-1.5rem] h-[calc(100%-0.5rem)] translate-y-2 bg-border" />
        <TimelineContent>
          <Row align="center" justify="between" gap="sm" className="min-h-7">
            <Row align="center" gap="sm" className="min-w-0">
              {showEntityLink && entry.entityId ? (
                <EntityInlineLinkById
                  entityType={entry.entityType}
                  entityId={entry.entityId}
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
                    {entityConfig.label}
                  </span>
                </>
              )}
              <Badge
                variant="secondary"
                className={cn("text-2xs", action.className)}
              >
                {action.label}
              </Badge>
            </Row>
            <span className="shrink-0 text-muted-foreground">
              <HoverableTimestamp timestamp={entry.createdAt} />
            </span>
          </Row>
        </TimelineContent>
      </TimelineItem>
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
    <TimelineItem step={step}>
      <TimelineIndicator className="size-3 border-0 bg-primary ring-4 ring-background" />
      <TimelineSeparator className="bg-border" />
      <TimelineContent>
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
                  <EntityInlineLinkById
                    entityType={entry.entityType}
                    entityId={entry.entityId}
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
                      {entityConfig.label}
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
                <CollapsibleTrigger className="mt-2 flex items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-foreground">
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
      </TimelineContent>
    </TimelineItem>
  );
}
