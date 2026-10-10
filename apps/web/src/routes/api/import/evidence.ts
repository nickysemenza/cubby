import { userId } from "@cubby/schemas/identifiers";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { auth } from "~/lib/auth";
import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { getErrorMessage } from "~/lib/error-utils";
import { AppError } from "~/server/errors/app-error";
import { verifyHttpApiKeyActor } from "~/server/http-api-handler";
import { authenticateHttpSession } from "~/server/http-session-cache";
import type { RequestActor } from "~/server/request-context";
import { createRequestContext, requireActor } from "~/server/request-context";

export const Route = createFileRoute("/api/import/evidence")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          let actor: RequestActor | null = null;
          const authHeaders = new Headers();
          if (request.headers.has("x-api-key")) {
            actor = await verifyHttpApiKeyActor(request, auth.api);
          } else {
            const session = await authenticateHttpSession({
              headers: request.headers,
              getSession: auth.api.getSession,
            });
            session.headers.forEach((value, name) =>
              authHeaders.append(name, value),
            );
            if (session.response)
              actor = {
                userId: userId.parse(session.response.user.id),
                sessionId: session.response.session.id,
                channel: "api",
              };
          }
          if (!actor)
            return Response.json(
              {
                code: "UNAUTHORIZED",
                message: "Valid API key, bearer token or session required",
              },
              {
                status: 401,
                headers: { "Cache-Control": "private, no-store" },
              },
            );
          const context = requireActor(
            await createRequestContext({ headers: request.headers, actor }),
          );
          const { readRunEvidenceMedia } =
            await import("~/server/purchase-import/run-evidence");
          const query = new URL(request.url).searchParams;
          const response = await readRunEvidenceMedia(
            context.db,
            {
              runId: query.get("runId") ?? "",
              targetId: query.get("targetId") ?? "",
              evidenceId: query.get("evidenceId") ?? "",
            },
            context.auth.userId,
          );
          authHeaders.forEach((value, name) =>
            response.headers.append(name, value),
          );
          return response;
        } catch (error) {
          return Response.json(
            {
              code:
                error instanceof AppError
                  ? error.code
                  : error instanceof z.ZodError
                    ? "BAD_REQUEST"
                    : "INTERNAL_SERVER_ERROR",
              message: scrubErrorMessage(getErrorMessage(error)),
            },
            {
              status:
                error instanceof AppError && error.code === "UNAUTHORIZED"
                  ? 401
                  : error instanceof z.ZodError
                    ? 400
                    : 500,
              headers: {
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
              },
            },
          );
        }
      },
      PUT: async ({ request }) => {
        const [{ db }, { receiveRunEvidenceUpload }] = await Promise.all([
          import("~/server/db"),
          import("~/server/purchase-import/run-evidence"),
        ]);
        return receiveRunEvidenceUpload(db, request);
      },
    },
  },
});
