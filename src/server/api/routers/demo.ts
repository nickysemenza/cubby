import { z } from "zod";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { greet, fibonacci } from "../../../../recipebridge/pkg/recipebridge";
export const demoRouter = createTRPCRouter({
  hello: publicProcedure
    .input(z.object({ text: z.string() }))
    .output(z.object({ greeting: z.string(), fib: z.number() }))
    .query(({ input }) => {
      return {
        greeting: greet(input.text),
        fib: fibonacci(20),
      };
    }),
});
