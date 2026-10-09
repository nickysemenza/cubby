import { userId } from "@cubby/schemas/identifiers";
import { createFileRoute } from "@tanstack/react-router";

import { auth } from "~/lib/auth";
import { getErrorMessage } from "~/lib/error-utils";
import { getUsdaReleaseEnv } from "~/server/cf-env";
import { verifyHttpApiKeyActor } from "~/server/http-api-handler";
import { authenticateHttpSession } from "~/server/http-session-cache";
import { createRequestContext, requireActor } from "~/server/request-context";
import type { RequestActor } from "~/server/request-context";
import { activeUsdaRelease } from "~/server/usda-release/client";

const headers = { "Cache-Control": "private, no-store" };

async function timed<T>(fn: () => PromiseLike<T>) {
  const start = performance.now();
  const value = await fn();
  return { ms: Math.round((performance.now() - start) * 10) / 10, value };
}

/**
 * The active USDA release's load state. The first request after a release is
 * activated starts its load (ADR 0008); `?probe=1` on a ready release also
 * times one search and one batch lookup through the binding.
 */
export const Route = createFileRoute("/api/debug/usda-release")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        let actor: RequestActor | null = null;
        if (request.headers.has("x-api-key")) {
          actor = await verifyHttpApiKeyActor(request, auth.api);
        } else {
          const session = await authenticateHttpSession({
            headers: request.headers,
            getSession: auth.api.getSession,
          });
          if (session.response)
            actor = {
              userId: userId.parse(session.response.user.id),
              sessionId: session.response.session.id,
              channel: "api",
            };
        }
        if (!actor)
          return Response.json(
            { error: "Valid API key, bearer token or session required" },
            { status: 401, headers },
          );
        requireActor(
          await createRequestContext({ headers: request.headers, actor }),
        );
        const env = getUsdaReleaseEnv();
        if (!env)
          return Response.json(
            { error: "USDA_RELEASE binding is unavailable outside Workers" },
            { status: 503, headers },
          );
        try {
          const release = activeUsdaRelease(env);
          const status = await timed(() => release.status());
          if (
            status.value.state !== "ready" ||
            new URL(request.url).searchParams.get("probe") !== "1"
          )
            return Response.json(
              { ...status.value, statusMs: status.ms },
              { headers },
            );
          const search = await timed(() =>
            release.search({
              nameFilter: "cheddar cheese",
              orderBy: "relevance",
              direction: "asc",
              foodsOnly: true,
              pageIndex: 0,
              pageSize: 50,
            }),
          );
          const ids = search.value.data.map((row) => row.fdc_id);
          const batch = await timed(() =>
            release.lookupBatch(ids.map((fdc_id) => ({ kind: "fdc", fdc_id }))),
          );
          return Response.json(
            {
              ...status.value,
              statusMs: status.ms,
              probe: {
                searchMs: search.ms,
                searchCount: search.value.count,
                batchMs: batch.ms,
                batchSize: ids.length,
              },
            },
            { headers },
          );
        } catch (error) {
          return Response.json(
            { error: getErrorMessage(error) },
            { status: 500, headers },
          );
        }
      },
    },
  },
});
