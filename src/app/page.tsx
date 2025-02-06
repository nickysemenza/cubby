import { HydrateClient } from "~/trpc/server";
import EntityCount from "./_components/entitycount";

export default async function Home() {
  return (
    <HydrateClient>
      <div className="container mx-auto">
        <div>hello</div>
        <EntityCount />
      </div>
    </HydrateClient>
  );
}
