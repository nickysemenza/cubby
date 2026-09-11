import { initClient, tsRestFetchApi } from "@ts-rest/core";
import { z } from "zod";

import { httpContract } from "~/lib/generated/http-contract.gen";

import { httpMetadataSchema, httpSchemaSources } from "./contract";
import { resourceQueryValues, resourceParameterIsText } from "./resource-query";

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
    api: (args) => {
      const metadata = z
        .object({ http: httpMetadataSchema })
        .parse(args.route.metadata).http;
      if (metadata.mode !== "list") return tsRestFetchApi(args);
      const schema =
        args.route.query instanceof z.ZodType
          ? httpSchemaSources.get(args.route.query)?.schema
          : undefined;
      if (!(schema instanceof z.ZodObject))
        throw new Error("Resource queries require an object schema");
      const params = new URLSearchParams();
      for (const [name, value] of Object.entries(
        resourceQueryValues.parse(args.rawQuery ?? {}),
      )) {
        const text = z.string().safeParse(value);
        if (value !== undefined)
          params.set(
            name,
            text.success &&
              schema.shape[name] &&
              resourceParameterIsText(schema.shape[name])
              ? text.data
              : JSON.stringify(value),
          );
      }
      const query = params.toString();
      return tsRestFetchApi({
        ...args,
        path: args.path.replace(/\?.*$/u, "") + (query ? `?${query}` : ""),
      });
    },
  });
}
