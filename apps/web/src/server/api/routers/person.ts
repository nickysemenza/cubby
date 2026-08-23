import {
  personShortcode,
  unsafePersonShortcode,
} from "@cubby/schemas/identifiers";
import {
  linkCurrentUserToPersonInput,
  mergePeopleInput,
  mergePeopleOut,
  personCreateInput,
  personFiltersSchema,
  personOptionsOut,
  personOut,
  personSortableFields,
  personUpdateData,
  unlinkPersonUserInput,
} from "@cubby/schemas/person";
import {
  createPerson,
  deletePeople,
  getPersonByShortcode,
  linkCurrentUserToPerson,
  listPeople,
  mergePeople,
  unlinkPersonUser,
  updatePerson,
} from "~/server/repo/person";
import { createSearchableEntityCrudProcedures } from "../crud-factory";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const procedures = createSearchableEntityCrudProcedures({
  schemas: {
    createInput: personCreateInput,
    updateInput: personUpdateData,
    output: personOut,
    filters: personFiltersSchema,
    sort: { sortableFields: personSortableFields, defaultSort: "name" },
    idSchema: personShortcode,
  },
  repository: {
    getByID: async (ctx, id) => {
      const result = await getPersonByShortcode(ctx.db, id);
      if (!result) throw new Error(`Person not found: ${id}`);
      return result;
    },
    getByShortcode: (ctx, id) => getPersonByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      listPeople(ctx.db, filters, sorts, pagination),
    create: (ctx, data) => createPerson(ctx.db, data, ctx.actorContext),
    update: (ctx, id, data) =>
      updatePerson(ctx.db, unsafePersonShortcode(id), data, ctx.actorContext),
    delete: async (ctx, ids) => ({
      deleted: (
        await deletePeople(
          ctx.db,
          ids.map(unsafePersonShortcode),
          ctx.actorContext,
        )
      ).deleted,
    }),
  },
  entityName: "person",
});

const options = protectedProcedure
  .output(strictOutput(personOptionsOut))
  .query(async ({ ctx }) => {
    const result = await listPeople(
      ctx.db,
      {},
      [{ orderBy: "name", direction: "asc" }],
      { pageIndex: 0, pageSize: 100 },
    );
    return result.data.map(({ id, name, kind }) => ({ id, name, kind }));
  });

const linkCurrentUser = protectedProcedure
  .input(linkCurrentUserToPersonInput)
  .output(strictOutput(personOut))
  .mutation(async ({ ctx, input }) => {
    return await linkCurrentUserToPerson(ctx.db, input.id, ctx.actorContext);
  });

const unlinkUser = protectedProcedure
  .input(unlinkPersonUserInput)
  .output(strictOutput(personOut))
  .mutation(async ({ ctx, input }) => {
    return await unlinkPersonUser(ctx.db, input.id, ctx.actorContext);
  });

const merge = protectedProcedure
  .input(mergePeopleInput)
  .output(strictOutput(mergePeopleOut))
  .mutation(({ ctx, input }) => mergePeople(ctx.db, input, ctx.actorContext));

export const personRouter = createTRPCRouter({
  ...procedures,
  options,
  linkCurrentUser,
  unlinkUser,
  merge,
});
