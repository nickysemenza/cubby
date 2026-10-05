import { userId } from "@cubby/schemas/identifiers";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { auth } from "~/lib/auth";
import {
  chatGptAuthorization,
  chatGptStatus,
  chatGptModel,
} from "~/lib/chatgpt-plan";
import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { getErrorMessage } from "~/lib/error-utils";
import { requireChatGptPlan } from "~/server/ai/chatgpt/client";
import { verifyHttpApiKeyActor } from "~/server/http-api-handler";
import { authenticateHttpSession } from "~/server/http-session-cache";
import type { RequestActor } from "~/server/request-context";
import { createRequestContext, requireActor } from "~/server/request-context";

async function handle(
  request: Request,
  action: () => Promise<
    | z.infer<typeof chatGptStatus>
    | z.infer<typeof chatGptModel>[]
    | { hostId: string; clientId: string | null }
    | { disconnected: boolean }
  >,
) {
  try {
    let actor: RequestActor | null = null;
    const headers = new Headers({ "Cache-Control": "private, no-store" });
    if (request.headers.has("x-api-key")) {
      actor = await verifyHttpApiKeyActor(request, auth.api);
    } else {
      const authenticated = await authenticateHttpSession({
        headers: request.headers,
        getSession: auth.api.getSession,
      });
      authenticated.headers.forEach((value, name) =>
        headers.append(name, value),
      );
      if (authenticated.response)
        actor = {
          userId: userId.parse(authenticated.response.user.id),
          sessionId: authenticated.response.session.id,
          channel: "api",
        };
    }
    if (!actor)
      return Response.json(
        { error: "Valid API key, bearer token or session required" },
        { status: 401 },
      );
    requireActor(
      await createRequestContext({ headers: request.headers, actor }),
    );
    const explicitCredential =
      request.headers.has("x-api-key") ||
      /^bearer\s+\S/iu.test(request.headers.get("authorization") ?? "");
    if (
      request.method !== "GET" &&
      !explicitCredential &&
      request.headers.get("origin") !== new URL(request.url).origin
    ) {
      return Response.json(
        { error: "Same-origin request required" },
        { status: 403 },
      );
    }
    return Response.json(await action(), {
      headers,
    });
  } catch (error) {
    return Response.json(
      { error: scrubErrorMessage(getErrorMessage(error)) },
      { status: 400, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}

export const Route = createFileRoute("/api/ai/chatgpt")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handle(request, () => {
          const params = new URL(request.url).searchParams;
          const plan = requireChatGptPlan();
          if (params.has("authorization")) return plan.authorizationHost();
          return params.has("models") ? plan.models() : plan.status();
        }),
      POST: ({ request }) =>
        handle(request, async () =>
          requireChatGptPlan().connect(
            chatGptAuthorization.parse(await request.json()),
          ),
        ),
      DELETE: ({ request }) =>
        handle(request, async () => {
          await requireChatGptPlan().disconnect();
          return { disconnected: true };
        }),
    },
  },
});
