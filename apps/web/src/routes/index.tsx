import { createFileRoute } from "@tanstack/react-router";
import EntityCount from "~/app/_components/homepage/entitycount";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <div className="container mx-auto">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Entity Counts</CardTitle>
        </CardHeader>
        <CardContent>
          <EntityCount />
        </CardContent>
      </Card>
    </div>
  );
}
