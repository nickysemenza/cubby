import { HydrateClient } from "~/trpc/server";
import EntityCount from "./homepage/entitycount";
import EntityCount2 from "./homepage/entitycountserver";

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
