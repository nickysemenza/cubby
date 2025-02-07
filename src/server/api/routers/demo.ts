import { z } from "zod";
import ollama from "ollama";
import { zodToJsonSchema } from "zod-to-json-schema";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { parsedIngredient } from "~/codec/codec";
export const demoRouter = createTRPCRouter({
  hello: publicProcedure
    .input(z.object({ text: z.string() }))
    .output(z.any())
    .query(async ({ input }) => {
      return "ok";
      const rawResponse = await ollama.chat({
        model: "llama3.1",
        messages: [
          {
            role: "user",
            content: "Parse this recipe ingredient: " + input.text,
          },
        ],
        format: zodToJsonSchema(parsedIngredient),
      });
      const response = parsedIngredient.parse(
        JSON.parse(rawResponse.message.content),
      );
      return {
        response,
      };
    }),
});
