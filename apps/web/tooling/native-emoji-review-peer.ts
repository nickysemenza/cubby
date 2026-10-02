import { createServer } from "node:http";
import { z } from "zod";
import {
  fieldSuggestionsInput,
  fieldSuggestionsReviewOut,
} from "@cubby/schemas/ai";

/** Only AI inference is synthetic; native authentication, reads and saves reach Workerd. */
export async function createNativeEmojiReviewPeer(
  upstream: URL,
  categoryId: string,
) {
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      if (
        request.method === "POST" &&
        request.url === "/api/v1/ai/suggestFieldsReview"
      ) {
        const input = fieldSuggestionsInput.parse(JSON.parse(body.toString()));
        if (
          input.entity !== "productCategory" ||
          input.entityId !== categoryId ||
          !input.targets.includes("emoji")
        )
          throw new Error("Emoji review fixture received an unexpected target");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            fieldSuggestionsReviewOut.parse({
              eligibleTargets: ["emoji"],
              suggestions: [
                {
                  field: "emoji",
                  suggestion: {
                    value: "🥕",
                    label: "🥕",
                    detail: null,
                    confidence: "high",
                    probability: 0.99,
                    reasoning: "Synthetic category context",
                    alternatives: [
                      { value: "🍎", label: "🍎", probability: 0.01 },
                    ],
                  },
                },
              ],
            }),
          ),
        );
        return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (
          value &&
          !["host", "content-length", "connection", "accept-encoding"].includes(
            key,
          )
        )
          headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const result = await fetch(new URL(request.url ?? "/", upstream), {
        method: request.method,
        headers,
        ...(body.length && { body }),
        redirect: "manual",
      });
      response.writeHead(
        result.status,
        Object.fromEntries(
          [...result.headers].filter(
            ([key]) =>
              ![
                "content-encoding",
                "content-length",
                "transfer-encoding",
              ].includes(key),
          ),
        ),
      );
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  return {
    url: new URL(`http://127.0.0.1:${address.port}`),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
