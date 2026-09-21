import { getImageProcessingNamespace } from "~/server/cf-env";
import { createRequestContext, requireActor } from "~/server/request-context";

const IMAGE_PROCESSING_SOCKET_PATH = "/api/companion/image-processing/socket";

export function isImageProcessingSocketUpgrade(request: Request): boolean {
  return new URL(request.url).pathname === IMAGE_PROCESSING_SOCKET_PATH;
}

/** Authenticate the upgrade once; the companion's hello never asserts actor identity. */
export async function handleImageProcessingSocketUpgrade(
  request: Request,
): Promise<Response> {
  const context = requireActor(
    await createRequestContext({ headers: request.headers }),
  );
  const namespace = getImageProcessingNamespace();
  if (!namespace)
    return new Response("Image companion unavailable", { status: 503 });
  const headers = new Headers(request.headers);
  headers.set("x-cubby-user-id", context.actorContext.userId);
  return namespace
    .getByName("household")
    .fetch(new Request(request, { headers }));
}
