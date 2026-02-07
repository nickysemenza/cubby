import type { Entity } from "@cubby/schemas/entity";
import { Link } from "@tanstack/react-router";
import { AlertCircle, Zap } from "lucide-react";
import { DashboardCard } from "~/components/layout/dashboard-card";
import { Button } from "~/components/ui/button";
import { EntityIcon, entities } from "~/entities/entities";
import { quickActions } from "../navbar/quick-actions-menu";

type CustomAction = { label: string; href: string; icon: React.ElementType };

const isEntityAction = (
  action: (typeof quickActions)[number],
): action is { entity: Entity } => "entity" in action;

/**
 * Quick actions card for the home page.
 * Provides one-click access to common creation actions.
 */
export function QuickActionsCard() {
  return (
    <DashboardCard
      icon={Zap}
      title="Quick Actions"
      description="Jump to common tasks"
    >
      <div className="grid grid-cols-2 gap-2">
        {quickActions.map((action) => {
          if (isEntityAction(action)) {
            const def = entities[action.entity];
            return (
              <Link key={action.entity} to={def.routes.new!}>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-start gap-2 transition-all hover:scale-[1.02] active:scale-[0.98]"
                >
                  <EntityIcon
                    entity={action.entity}
                    colored
                    className="h-4 w-4 shrink-0"
                  />
                  <span className="truncate">New {def.label}</span>
                </Button>
              </Link>
            );
          }
          const customAction = action as CustomAction;
          return (
            <Link key={customAction.href} to={customAction.href}>
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start gap-2 transition-all hover:scale-[1.02] active:scale-[0.98]"
              >
                <customAction.icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{customAction.label}</span>
              </Button>
            </Link>
          );
        })}
        <Link to="/problems">
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2 transition-all hover:scale-[1.02] active:scale-[0.98]"
          >
            <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
            <span className="truncate">Problems</span>
          </Button>
        </Link>
      </div>
    </DashboardCard>
  );
}
