import { chatGptStatus, chatGptModel } from "@cubby/schemas/chatgpt";
import { getErrorMessage } from "@cubby/shared";
import type { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import type { HttpRouteHandlers } from "~/lib/http/route-handler";
import { requireChatGptPlan } from "~/server/ai/chatgpt/client";
import {
  API_AUTH,
  authenticate,
  isChallenge,
} from "~/server/http/authenticate";

async function handle(
  request: Request,
  action: () => Promise<
    | z.infer<typeof chatGptStatus>
    | z.infer<typeof chatGptModel>[]
    | { disconnected: boolean }
  >,
) {
  try {
    const authenticated = await authenticate(request, API_AUTH);
    if (isChallenge(authenticated))
      return Response.json(
        { error: authenticated.message },
        { status: authenticated.status },
      );
    const headers = new Headers(authenticated.responseHeaders);
    headers.set("Cache-Control", "private, no-store");
    return Response.json(await action(), { headers });
  } catch (error) {
    return Response.json(
      { error: scrubErrorMessage(getErrorMessage(error)) },
      { status: 400, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}

export const handlers: HttpRouteHandlers<
  Record<never, never>,
  "GET" | "DELETE" | "PATCH"
> = {
  GET: ({ request }) =>
    handle(request, () => {
      const params = new URL(request.url).searchParams;
      const plan = requireChatGptPlan();
      return params.has("models") ? plan.models() : plan.status();
    }),
  PATCH: ({ request }) =>
    handle(request, () => requireChatGptPlan().dismissWelcome()),
  DELETE: ({ request }) =>
    handle(request, async () => {
      await requireChatGptPlan().disconnect();
      return { disconnected: true };
    }),
};
