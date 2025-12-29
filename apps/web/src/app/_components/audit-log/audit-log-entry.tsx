import { Bot, ChevronDown, ChevronRight, Package } from "lucide-react";
import { useState } from "react";
import { MutedBox } from "~/components/layout/muted-box";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { entities } from "~/entities/entities";
import type { Entity } from "~/entities/types";
import { cn } from "~/lib/utils";
import type { AuditEntityType } from "~/server/repo/audit-log";
import type { RouterOutputs } from "~/trpc/react";
import { EntityPillById } from "../EntityPillById";
import { HoverableTimestamp } from "../HoverableTimestamp";
import { ChangesList } from "../value-change";

type AuditLogEntry = RouterOutputs["auditLog"]["list"]["entries"][number];

/** Map AuditEntityType to Entity (handles "inventory" -> "inventory-item") */
const auditEntityToEntity = (entityType: string): Entity => {
  if (entityType === "inventory") return "inventory-item";
  return entityType as Entity;
};

/** Get entity config from the unified entities definition */
const getEntityConfig = (entityType: string) => {
  const entity = auditEntityToEntity(entityType);
  const config = entities[entity];
  return {
    icon: config?.lucideIcon ?? Package,
    label: config?.label ?? entityType,
  };
};

// Map actions to badge variants
const actionConfig: Record<string, { label: string; className: string }> = {
  create: {
    label: "Created",
    className:
      "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  },
  update: {
    label: "Updated",
    className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
  },
  delete: {
    label: "Deleted",
    className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
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

  const entityConf = getEntityConfig(entry.entityType);
  const action = actionConfig[entry.action] ?? {
    label: entry.action,
    className: "bg-gray-100 text-gray-800",
  };
  const EntityIcon = entityConf.icon;

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
      <div className="flex items-start gap-3 border-b py-3 last:border-b-0">
        {/* User Avatar */}
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
                entityType={entry.entityType as AuditEntityType}
                entityId={entry.entityId}
              />
            ) : (
              <>
                <EntityIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                <span className="font-medium text-sm">{entityConf.label}</span>
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
