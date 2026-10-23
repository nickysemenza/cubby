import { type DoorbellTopic, doorbellTopic } from "~/lib/doorbell";
import {
  getDatabaseFreshnessNamespace,
  getImageProcessingNamespace,
} from "~/server/cf-env";
import {
  type AuthPolicy,
  authenticate,
  BROWSER_AUTH,
  DEVICE_AUTH,
  isChallenge,
} from "~/server/http/authenticate";

/** Each topic's credential policy and the Durable Object that owns its subscribers. */
const topics = {
  "household.changed": {
    policy: BROWSER_AUTH,
    owner: () =>
      getDatabaseFreshnessNamespace()?.getByName("household", {
        locationHint: "wnam",
      }),
  },
  "imageProcessing.work": {
    policy: DEVICE_AUTH,
    owner: () => getImageProcessingNamespace()?.getByName("household"),
  },
} satisfies Record<
  DoorbellTopic,
  {
    policy: AuthPolicy;
    owner: () => { fetch(request: Request): Promise<Response> } | undefined;
  }
>;

/**
 * Authenticate the upgrade once and hand it to the topic's owner. Auth refuses
 * a cross-origin cookie upgrade; native clients send a bearer token.
 */
export async function handleDoorbellUpgrade(
  request: Request,
): Promise<Response> {
  if (request.method !== "GET")
    return new Response("Doorbell subscriptions use GET", { status: 405 });
  const topic = doorbellTopic.safeParse(
    new URL(request.url).searchParams.get("topic"),
  );
  if (!topic.success)
    return new Response(
      `Unknown doorbell topic; expected one of ${doorbellTopic.options.join(", ")}`,
      { status: 400 },
    );
  const { policy, owner } = topics[topic.data];
  const authenticated = await authenticate(request, policy);
  if (isChallenge(authenticated))
    return new Response(authenticated.message, {
      status: authenticated.status,
    });
  const stub = owner();
  if (!stub) return new Response("Doorbell topic unavailable", { status: 503 });
  return stub.fetch(request);
}
