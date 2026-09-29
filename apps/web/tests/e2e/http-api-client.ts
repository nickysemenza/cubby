import { initClient } from "@ts-rest/core";

import { httpContract } from "~/lib/generated/http-contract.gen";

/**
 * A typed client for the HTTP API. Query values travel as plain text: numbers
 * and booleans as their text form, lists as repeated keys (the server also
 * folds ts-rest's own `key[0]=` spelling onto that form). Structured query
 * inputs are POST bodies, so nothing on a URL is ever JSON-encoded.
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
  });
}
