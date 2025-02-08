import { HydrateClient } from "~/trpc/server";
import EntityCount from "./homepage/entitycount";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";

export default async function Home() {
  return (
    <HydrateClient>
      <div className="container mx-auto">
        <Card className="w-sm">
          <CardHeader>
            <CardTitle>Entity Counts</CardTitle>
          </CardHeader>
          <CardContent>
            <EntityCount />
          </CardContent>
        </Card>
      </div>
    </HydrateClient>
  );
}
