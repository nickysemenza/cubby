import { HydrateClient } from "~/trpc/server";
import EntityCount from "./_components/entitycount";
import EntityCount2 from "./_components/entitycountserver";

export default async function Home() {
  return (
    <HydrateClient>
      <div className="container mx-auto">
        <div>hello</div>
        <EntityCount />
        <EntityCount2 />
      </div>
    </HydrateClient>
  );
}
