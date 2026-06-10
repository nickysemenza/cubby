import type { AuditEntityType } from "@cubby/schemas/audit";
import { Bot, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { MutedBox } from "~/components/layout/muted-box";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { EntityIcon, entities } from "~/entities/entities";
import { getStatusBadgeProps } from "~/lib/status-colors";
import { cn } from "~/lib/utils";
import type { RouterOutputs } from "~/trpc/react";
import { EntityPillById } from "../EntityPillById";
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
    <div className="space-y-1">
      {Object.entries(changes).map(([field, { from, to }]) => (
        <div key={field} className="flex items-center gap-1 text-xs">
          <span className="font-medium text-muted-foreground">{field}:</span>
          <span className="text-foreground">{formatChangeValue(from)}</span>
          <span className="text-muted-foreground">&rarr;</span>
          <span className="text-foreground">{formatChangeValue(to)}</span>
        </div>
      ))}
    </div>
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
      <div className="flex items-center justify-between gap-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {showEntityLink ? (
            <EntityPillById
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
        </div>
        <span className="shrink-0 text-muted-foreground">
          <HoverableTimestamp timestamp={entry.createdAt} />
        </span>
      </div>
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
      <div className="group/entry relative flex items-start gap-2.5 py-2 pl-6 last:border-b-0">
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
          <div className="flex flex-wrap items-center gap-2">
            {/* Entity Pill or Icon */}
            {showEntityLink ? (
              <EntityPillById
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
              <span className="text-muted-foreground text-sm">
                by {entry.user.name ?? entry.user.email}
              </span>
            )}
            {!entry.user && (
              <span className="text-muted-foreground text-sm">by System</span>
            )}

            {/* Timestamp — inline with the metadata row to save a line */}
            <span className="text-muted-foreground text-xs">
              <HoverableTimestamp timestamp={entry.createdAt} />
            </span>
          </div>

          {/* Changes (if any) */}
          {hasChanges && (
            <CollapsibleTrigger className="mt-1.5 flex items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-foreground">
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
      </div>
    </Collapsible>
  );
}
