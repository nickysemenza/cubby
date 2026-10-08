import { researchToolInputs } from "@cubby/schemas/research-tools";
import {
  MAX_EXTERNAL_HTML_BYTES,
  readResponseWithLimit,
} from "@cubby/shared/external-fetch";
import { z } from "zod";

import type { getTestAiGateway } from "~/server/cf-env";

import type { ResearchObservationPorts } from "./research-observations";
import type { FetchPage } from "./server-page-fetch";

type FixtureRequest =
  | Pick<z.input<typeof researchToolInputs.web_search>, "query">
  | Pick<z.input<typeof researchToolInputs.web_read>, "url">;

const fetchedPage = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("fetched"),
    url: z.url(),
    html: z.string().max(MAX_EXTERNAL_HTML_BYTES),
    durationMs: z.number().nonnegative(),
  }),
  z.object({
    status: z.literal("blocked"),
    reason: z.string(),
    durationMs: z.number().nonnegative(),
  }),
]);

/** Harness-only source transport changes observations, never model decisions. */
export async function researchFixtureSources(
  gateway: ReturnType<typeof getTestAiGateway>,
): Promise<Pick<ResearchObservationPorts, "search" | "fetchPage"> | undefined> {
  if (!gateway) return;
  const configuration = await gateway.fetch(
    "https://gateway.test/research-fixture-config",
  );
  if (configuration.status === 404 || configuration.status === 405) return;
  if (!configuration.ok)
    throw new Error(
      `Research fixture configuration HTTP ${configuration.status}: ${await configuration.text()}`,
    );
  if (
    !z.object({ enabled: z.boolean() }).parse(await configuration.json())
      .enabled
  )
    return;
  const post = (path: string, body: FixtureRequest) =>
    gateway.fetch(
      new Request(`https://gateway.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const fetchPage: FetchPage = async (url) => {
    const response = await post("/research-page", { url });
    const body = new TextDecoder().decode(
      await readResponseWithLimit(response, MAX_EXTERNAL_HTML_BYTES),
    );
    if (!response.ok)
      throw new Error(`Research fixture page HTTP ${response.status}: ${body}`);
    return fetchedPage.parse(JSON.parse(body));
  };
  return {
    search: ({
      query,
    }: Pick<z.input<typeof researchToolInputs.web_search>, "query">) =>
      post("/research-search", { query }),
    fetchPage,
  };
}
