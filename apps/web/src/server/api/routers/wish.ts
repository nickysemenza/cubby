import { ENTITY_BINDINGS } from "~/server/entity-bindings";
import { ENTITY_KERNEL_BINDINGS } from "~/server/entity-kernel/registry";
import { createEntityCompatibilityProcedures } from "../entity-compatibility";
import { createTRPCRouter } from "../trpc";

const procedures = createEntityCompatibilityProcedures(
  ENTITY_KERNEL_BINDINGS.wish,
  ENTITY_BINDINGS.wish.crud,
);

export const wishRouter = createTRPCRouter(procedures);
