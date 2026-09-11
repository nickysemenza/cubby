import { initClient } from "@ts-rest/core";

import { httpContract } from "~/lib/generated/http-contract.gen";

export function createCubbyClient({
  baseUrl,
  apiKey,
}: {
  baseUrl: string;
  apiKey: string;
}) {
  return initClient(httpContract, {
    baseUrl,
    baseHeaders: { "x-api-key": apiKey },
  });
}
