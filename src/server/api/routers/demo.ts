import { z } from "zod";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
export const demoRouter = createTRPCRouter({
  hello: publicProcedure
    .input(z.object({ text: z.string() }))
    .output(z.any())
    .query(async ({}) => {
      return "ok";
    }),
});
