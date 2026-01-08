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
import { cn } from "~/lib/utils";
import type { AuditEntityType } from "~/schemas/audit";
import type { RouterOutputs } from "~/trpc/react";
import { EntityPillById } from "../EntityPillById";
import { HoverableTimestamp } from "../HoverableTimestamp";
import { ChangesList } from "../value-change";

type AuditLogEntry = RouterOutputs["auditLog"]["list"]["entries"][number];

// Map actions to badge variants - using theme colors
const actionConfig: Record<string, { label: string; className: string }> = {
  create: {
    label: "Created",
    className: "bg-secondary text-secondary-foreground",
  },
  update: {
    label: "Updated",
    className: "bg-slate/20 text-slate",
  },
  delete: {
    label: "Deleted",
    className: "bg-destructive/15 text-destructive",
  },
};

interface AuditLogEntryProps {
  entry: AuditLogEntry;
  showEntityLink?: boolean;
}

export function AuditLogEntryComponent({
  entry,
  showEntityLink = true,
}: AuditLogEntryProps) {
  const [isOpen, setIsOpen] = useState(false);
  const hasChanges = entry.changes && Object.keys(entry.changes).length > 0;

  const entityConfig = entities[entry.entityType as AuditEntityType];
  const action = actionConfig[entry.action] ?? {
    label: entry.action,
    className: "bg-muted text-muted-foreground",
  };

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
      <div className="group/entry relative flex items-start gap-3 py-3 pl-6 last:border-b-0">
        <div className="absolute top-5 left-0 h-3 w-3 rounded-full bg-primary ring-4 ring-background" />
        <div className="absolute top-8 bottom-0 left-[5px] w-0.5 bg-gradient-to-b from-border to-transparent group-last/entry:hidden" />
        <Avatar className="h-8 w-8 flex-shrink-0">
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
          </div>

          {/* Timestamp */}
          <div className="mt-1 text-muted-foreground text-xs">
            <HoverableTimestamp timestamp={entry.createdAt} />
          </div>

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
      </div>
    </Collapsible>
  );
}
