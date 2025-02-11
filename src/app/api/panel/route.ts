import { renderTrpcPanel } from "trpc-ui";
import { appRouter } from "../../../server/api/root";
import { NextRequest } from "next/server";

async function handler(_: NextRequest) {
  return new Response(
    renderTrpcPanel(appRouter, {
      url: "http://localhost:3000/api/trpc",
      transformer: "superjson",
    }),
    { status: 200, headers: { "Content-Type": "text/html" } },
  );
}
export { handler as GET, handler as POST };
