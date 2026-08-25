import { ENTITY_BINDINGS } from "~/server/entity-bindings";
import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";
import { createEntityListCompatibilityProcedure } from "../entity-compatibility";
import { createTRPCRouter } from "../trpc";

const list = createEntityListCompatibilityProcedure(
  ENTITY_KERNEL_BINDINGS.wish,
  ENTITY_BINDINGS.wish.crud,
);

export const wishRouter = createTRPCRouter({ list });
