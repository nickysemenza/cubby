import { Link } from "@tanstack/react-router";
import { Zap } from "lucide-react";
import { Grid } from "~/components/layout";
import { DashboardCard } from "~/components/layout/dashboard-card";
import { Button } from "~/components/ui/button";
import { EntityIcon, entities } from "~/entities/entities";
import { actionsForSurface } from "../actions/action-items";

const homeActions = actionsForSurface("home-quick");

/**
 * Quick actions for the home page, drawn from the `home-quick` slice of the
 * canonical registry — the household's recurring verbs first, creates after.
 */
export function QuickActionsCard() {
  return (
    <DashboardCard
      icon={Zap}
      title="Quick actions"
      description="Jump to common tasks"
    >
      <Grid className="grid-cols-2" gap="sm">
        {homeActions.map((action) => (
          // `render` keeps this one element: a <button> inside an <a> is
          // invalid HTML and gave every action two tab stops with ambiguous
          // announcement.
          <Button
            key={action.id}
            render={<Link to={action.path} search={action.search} />}
            // Base UI defaults `nativeButton`, which asserts a real <button>;
            // this one renders an anchor, so the flag has to say so.
            nativeButton={false}
            variant="outline"
            size="sm"
            className="h-11 w-full justify-start gap-2 transition-colors sm:h-8"
          >
            {action.entity ? (
              <EntityIcon
                entity={action.entity}
                colored
                className="size-4 shrink-0"
              />
            ) : (
              <action.icon className="size-4 shrink-0" />
            )}
            <span className="truncate">
              {action.entity
                ? `New ${entities[action.entity].label}`
                : action.name}
            </span>
          </Button>
        ))}
      </Grid>
    </DashboardCard>
  );
}
