import { runEvidenceMediaRead } from "@cubby/schemas/http-byte-transports";
import { userId } from "@cubby/schemas/identifiers";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { auth } from "~/lib/auth";
import { AppError } from "~/server/errors/app-error";
import { verifyHttpApiKeyActor } from "~/server/http-api-handler";
import { authenticateHttpSession } from "~/server/http-session-cache";
import type { RequestActor } from "~/server/request-context";
import { createRequestContext, requireActor } from "~/server/request-context";
import { normalizeStartOperationError } from "~/server/start-operation.server";

type EvidenceReadPorts = {
  authenticate: (
    request: Request,
  ) => Promise<{ actor: RequestActor | null; authHeaders: Headers }>;
  context: typeof createRequestContext;
  readMedia: typeof import("~/server/purchase-import/run-evidence").readRunEvidenceMedia;
};

async function authenticateEvidenceRequest(request: Request) {
  let actor: RequestActor | null = null;
  const authHeaders = new Headers();
  if (request.headers.has("x-api-key")) {
    actor = await verifyHttpApiKeyActor(request, auth.api);
  } else {
    const session = await authenticateHttpSession({
      headers: request.headers,
      getSession: auth.api.getSession,
    });
    session.headers.forEach((value, name) => authHeaders.append(name, value));
    if (session.response)
      actor = {
        userId: userId.parse(session.response.user.id),
        sessionId: session.response.session.id,
        channel: "api",
      };
  }
  return { actor, authHeaders };
}

export async function handleEvidenceMediaRequest(
  request: Request,
  ports: EvidenceReadPorts,
): Promise<Response> {
  let actor: RequestActor | null = null;
  try {
    const authenticated = await ports.authenticate(request);
    actor = authenticated.actor;
    const authHeaders = authenticated.authHeaders;
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
      await ports.context({ headers: request.headers, actor }),
    );
    const query = new URL(request.url).searchParams;
    const response = await ports.readMedia(
      context.db,
      {
        runId: query.get("runId") ?? "",
        targetId: query.get("targetId") ?? "",
        evidenceId: query.get("evidenceId") ?? "",
      },
      context.auth.userId,
    );
    authHeaders.forEach((value, name) => response.headers.append(name, value));
    return response;
  } catch (error) {
    const { publicError } = normalizeStartOperationError(
      error,
      actor ? "run" : "context",
      undefined,
      {
        operation: runEvidenceMediaRead.operationId,
        authenticated: actor !== null,
        headers: request.headers,
      },
    );
    return Response.json(publicError, {
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
    });
  }
}

export const Route = createFileRoute("/api/import/evidence")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleEvidenceMediaRequest(request, {
          authenticate: authenticateEvidenceRequest,
          context: createRequestContext,
          readMedia: async (...args) => {
            const { readRunEvidenceMedia } =
              await import("~/server/purchase-import/run-evidence");
            return readRunEvidenceMedia(...args);
          },
        }),
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
