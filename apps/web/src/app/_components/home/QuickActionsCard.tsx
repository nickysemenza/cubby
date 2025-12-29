import { Link } from "@tanstack/react-router";
import { AlertCircle, Zap } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { EntityIcon, entities } from "~/entities/entities";
import type { Entity } from "~/entities/types";
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
    <Card className="fade-in slide-in-from-bottom-2 flex animate-in flex-col duration-300">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">Quick Actions</CardTitle>
        </div>
        <CardDescription className="text-xs">
          Jump to common tasks
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1">
        <div className="grid grid-cols-2 gap-2">
          {quickActions.map((action) => {
            if (isEntityAction(action)) {
              const def = entities[action.entity];
              return (
                <Link
                  key={action.entity}
                  to={`/${def.basePath}/new` as "/products/new"}
                >
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
      </CardContent>
    </Card>
  );
}
