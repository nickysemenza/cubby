import type { AuditEntityType } from "@cubby/schemas/audit";
import { Bot, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Row, Stack } from "~/components/layout";
import { MutedBox } from "~/components/layout/muted-box";
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
  /**
   * "ledger" renders a glanceable single line (pill + action ... time) with no
   * avatar, timeline, or change details — used on the home feed.
   */
  variant?: "default" | "ledger";
}

export function AuditLogEntryComponent({
  entry,
  showEntityLink = true,
  variant = "default",
}: AuditLogEntryProps) {
  const [isOpen, setIsOpen] = useState(false);
  const hasChanges = entry.changes && Object.keys(entry.changes).length > 0;

  const entityConfig = entities[entry.entityType as AuditEntityType];
  const action = getStatusBadgeProps("audit", entry.action);

  if (variant === "ledger") {
    return (
      <Row align="center" justify="between" gap="sm" className="py-2">
        <Row align="center" gap="sm" className="min-w-0">
          {showEntityLink ? (
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
                className="h-4 w-4 flex-shrink-0"
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
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <Row
        align="start"
        gap="sm"
        className="group/entry relative py-2 pl-6 last:border-b-0"
      >
        <div className="absolute top-4 left-0 h-3 w-3 rounded-full bg-primary ring-4 ring-background" />
        <div className="absolute top-7 bottom-0 left-[5px] w-0.5 bg-gradient-to-b from-border to-transparent group-last/entry:hidden" />
        <Avatar className="h-6 w-6 flex-shrink-0">
          {entry.user?.image ? (
            <AvatarImage src={entry.user.image} alt={entry.user.name ?? ""} />
          ) : null}
          <AvatarFallback
            className={cn(
              "text-xs",
              !entry.user && "bg-muted text-muted-foreground",
            )}
          >
            {entry.user ? userInitials : <Bot className="h-4 w-4" />}
          </AvatarFallback>
        </Avatar>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <Row align="center" gap="sm" wrap>
            {/* Entity Pill or Icon */}
            {showEntityLink ? (
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
                  className="h-4 w-4 flex-shrink-0"
                />
                <span className="font-medium text-sm">
                  {entityConfig.label}
                </span>
              </>
            )}

            {/* Action Badge */}
            <Badge
              variant="secondary"
              className={cn("text-xs", action.className)}
            >
              {action.label}
            </Badge>

            {/* User Name */}
            {entry.user && (
              <Description as="span">
                by {entry.user.name ?? entry.user.email}
              </Description>
            )}
            {!entry.user && <Description as="span">by System</Description>}

            {/* Timestamp — inline with the metadata row to save a line */}
            <span className="text-muted-foreground text-xs">
              <HoverableTimestamp timestamp={entry.createdAt} />
            </span>
          </Row>

          {/* Changes (if any) */}
          {hasChanges && (
            <CollapsibleTrigger className="mt-2 flex items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-foreground">
              {isOpen ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
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
  );
}
