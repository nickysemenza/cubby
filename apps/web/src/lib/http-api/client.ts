import { initClient } from "@ts-rest/core";

import { httpContract } from "~/lib/generated/http-contract.gen";

/**
 * A typed client for the HTTP API. `jsonQuery` is what the server decodes:
 * plain strings stay literal on the URL and every other value is JSON, so
 * structured filters and numeric-looking text both round-trip.
 */
export function createCubbyClient({
  baseUrl,
  apiKey,
}: {
  baseUrl: string;
  apiKey?: string;
}) {
  return initClient(httpContract, {
    baseUrl,
    baseHeaders: apiKey === undefined ? {} : { "x-api-key": apiKey },
    credentials: "same-origin",
    jsonQuery: true,
  });
}
