import { getImageProcessingNamespace } from "~/server/cf-env";
import {
  authenticate,
  DEVICE_AUTH,
  isChallenge,
} from "~/server/http/authenticate";

/** Authenticate the upgrade once; the companion's hello never asserts actor identity. */
export async function handleImageProcessingSocketUpgrade(
  request: Request,
): Promise<Response> {
  const authenticated = await authenticate(request, DEVICE_AUTH);
  if (isChallenge(authenticated))
    return new Response(authenticated.message, {
      status: authenticated.status,
    });
  const namespace = getImageProcessingNamespace();
  if (!namespace)
    return new Response("Image companion unavailable", { status: 503 });
  const headers = new Headers(request.headers);
  headers.set("x-cubby-user-id", authenticated.context.actorContext.userId);
  return namespace
    .getByName("household")
    .fetch(new Request(request, { headers }));
}
