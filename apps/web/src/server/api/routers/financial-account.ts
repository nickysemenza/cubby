import { financialAccountOptionsOut } from "@cubby/schemas/financial-account";
import { financialAccountOptions } from "~/server/repo/financial-account";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

/**
 * The account picklist — feeds the transactions table's Account filter. Cheap
 * options query, same shape as `vendor.options`. The transaction form keeps its
 * own search-as-you-type combobox: that one pages the full list, this one is
 * loaded eagerly for a header control.
 */
const options = protectedProcedure
  .output(strictOutput(financialAccountOptionsOut))
  .query(({ ctx }) => financialAccountOptions(ctx.db));

export const financialAccountRouter = createTRPCRouter({
  options,
});
