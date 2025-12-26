"use client";

import type { RouterOutputs } from "~/trpc/react";
import { HoverableTimestamp } from "../HoverableTimestamp";
import { Badge } from "~/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import {
  ChevronDown,
  ChevronRight,
  Package,
  MapPin,
  UtensilsCrossed,
  ShoppingCart,
  Bot,
} from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";
import { EntityPillById } from "../EntityPillById";
import type { AuditEntityType } from "~/server/repo/audit-log";
import { ChangesList } from "../value-change";

type AuditLogEntry = RouterOutputs["auditLog"]["list"]["entries"][number];

// Map entity types to icons and paths
const entityConfig: Record<
  string,
  { icon: React.ElementType; basePath: string; label: string }
> = {
  product: { icon: ShoppingCart, basePath: "/products", label: "Product" },
  location: { icon: MapPin, basePath: "/locations", label: "Location" },
  inventory: { icon: Package, basePath: "/inventory", label: "Inventory" },
  recipe: { icon: UtensilsCrossed, basePath: "/recipes", label: "Recipe" },
  ingredient: {
    icon: UtensilsCrossed,
    basePath: "/ingredients",
    label: "Ingredient",
  },
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

  const entity = entityConfig[entry.entityType] ?? {
    icon: Package,
    basePath: "",
    label: entry.entityType,
  };
  const action = actionConfig[entry.action] ?? {
    label: entry.action,
    className: "bg-gray-100 text-gray-800",
  };
  const EntityIcon = entity.icon;

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
                <span className="font-medium text-sm">{entity.label}</span>
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
              <div className="rounded-md bg-muted p-2">
                <ChangesList
                  changes={
                    entry.changes as Record<
                      string,
                      { from: unknown; to: unknown }
                    >
                  }
                />
              </div>
            )}
          </CollapsibleContent>
        </div>
      </div>
    </Collapsible>
  );
}
