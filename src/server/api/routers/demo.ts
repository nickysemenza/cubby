import { z } from "zod";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
export const demoRouter = createTRPCRouter({
  hello: publicProcedure
    .input(z.object({ text: z.string() }))
    .output(z.object({ greeting: z.string(), fib: z.number() }))
    .query(({ input }) => {
      return {
        greeting: `Hello, ${input.text}`,
        fib: 42,
      };
    }),
});
