import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertCircle, type LucideIcon } from "lucide-react";
import EntityCount from "~/app/_components/homepage/entitycount";
import { quickActions } from "~/app/_components/navbar/quick-actions-menu";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { EntityIcon, entities } from "~/entities/entities";
import type { Entity } from "~/entities/types";

export const Route = createFileRoute("/")({ component: Home });

type CustomAction = { label: string; href: string; icon: LucideIcon };
const isEntityAction = (
  action: (typeof quickActions)[number],
): action is { entity: Entity } => "entity" in action;

function Home() {
  return (
    <div className="container mx-auto space-y-6 p-4">
      {/* Stat Cards */}
      <EntityCount />

      {/* Quick Actions */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">Quick Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            {quickActions.map((action) => {
              if (isEntityAction(action)) {
                const def = entities[action.entity];
                return (
                  <Button
                    key={action.entity}
                    variant="outline"
                    size="sm"
                    render={
                      <Link to={`/${def.basePath}/new` as "/products/new"} />
                    }
                    nativeButton={false}
                  >
                    <EntityIcon
                      entity={action.entity}
                      colored
                      className="mr-2 h-4 w-4 shrink-0"
                    />
                    New {def.label}
                  </Button>
                );
              }
              const customAction = action as CustomAction;
              return (
                <Button
                  key={customAction.href}
                  variant="outline"
                  size="sm"
                  render={<Link to={customAction.href} />}
                  nativeButton={false}
                >
                  <customAction.icon className="mr-2 h-4 w-4 shrink-0" />
                  {customAction.label}
                </Button>
              );
            })}
            {/* Problems is homepage-specific, not in shared quick actions */}
            <Button
              variant="outline"
              size="sm"
              render={<Link to="/problems" />}
              nativeButton={false}
            >
              <AlertCircle className="mr-2 h-4 w-4 shrink-0" />
              Problems
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
