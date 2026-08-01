import {
  clearDataExceptionInput,
  dataQuality,
  setDataExceptionInput,
} from "@cubby/schemas/data-quality";
import {
  clearDataException,
  setDataException,
} from "~/server/repo/data-quality";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const setException = protectedProcedure
  .input(setDataExceptionInput)
  .output(strictOutput(dataQuality))
  .mutation(({ ctx, input }) =>
    setDataException(ctx.db, input, ctx.actorContext),
  );

const clearException = protectedProcedure
  .input(clearDataExceptionInput)
  .output(strictOutput(dataQuality))
  .mutation(({ ctx, input }) =>
    clearDataException(ctx.db, input, ctx.actorContext),
  );

export const dataQualityRouter = createTRPCRouter({
  setException,
  clearException,
});
