import { Link } from "@tanstack/react-router";
import { AlertCircle, Zap } from "lucide-react";
import { DashboardCard } from "~/components/layout/dashboard-card";
import { Button } from "~/components/ui/button";
import { EntityIcon, entities } from "~/entities/entities";
import { actionsForSurface } from "../actions/action-items";

const createActions = actionsForSurface("navbar-create");

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
        {createActions.map((action) => (
          <Link key={action.id} to={action.path}>
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start gap-2 transition-colors"
            >
              {action.entity ? (
                <>
                  <EntityIcon
                    entity={action.entity}
                    colored
                    className="size-4 shrink-0"
                  />
                  <span className="truncate">
                    New {entities[action.entity].label}
                  </span>
                </>
              ) : (
                <>
                  <action.icon className="size-4 shrink-0" />
                  <span className="truncate">{action.name}</span>
                </>
              )}
            </Button>
          </Link>
        ))}
        <Link to="/problems">
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2 transition-colors"
          >
            <AlertCircle className="size-4 shrink-0 text-destructive" />
            <span className="truncate">Problems</span>
          </Button>
        </Link>
      </div>
    </DashboardCard>
  );
}
