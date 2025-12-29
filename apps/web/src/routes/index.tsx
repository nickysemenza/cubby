import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertCircle } from "lucide-react";
import EntityCount from "~/app/_components/homepage/entitycount";
import { quickActions } from "~/app/_components/navbar/quick-actions-menu";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";

export const Route = createFileRoute("/")({ component: Home });

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
            {quickActions.map((action) => (
              <Button
                key={action.href}
                variant="outline"
                size="sm"
                render={<Link to={action.href} />}
                nativeButton={false}
              >
                <action.icon className="mr-2 h-4 w-4 shrink-0" />
                {action.label}
              </Button>
            ))}
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
