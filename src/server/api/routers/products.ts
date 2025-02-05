import { type PrismaClient, type Prisma } from "@prisma/client";
import { type ProductConfigItem } from "~/server/config";
import { findOrCreateItem } from "./item";
import { type z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc";
import { productWithItemOut } from "~/schemas/item";
import { IDInput } from "~/schemas/util";

export const loadProducts = async (
  db: PrismaClient,
  data: ProductConfigItem[],
) => {
  const now = new Date();

  for (const product of data) {
    const { name, manufacturer, upc, model } = product;
    const item = await findOrCreateItem(db, product.name, product.productType);
    //todo: do something with product.unit_mappings
    const upsertFields: Prisma.ProductCreateInput = {
      name,
      manufacturer,
      upc,
      model,
      updatedAt: now,
      Item: { connect: { id: item.id } },
    };
    await db.product.upsert({
      where: {
        name,
      },
      create: {
        ...upsertFields,
      },
      update: {
        ...upsertFields,
      },
    });

    const stale = await db.product.findMany({
      where: {
        updatedAt: {
          not: now,
        },
      },
    });
    console.log({ stale: stale.map((s) => s.id) });
  }
};

const getByID = publicProcedure
  .input(IDInput)
  .output(productWithItemOut)
  .query(async ({ ctx, input }) => {
    const res = await ctx.db.product.findFirstOrThrow({
      where: {
        id: input.id,
      },
      include: { Item: true },
    });
    return dbProductoToAPI(res);
  });

type ProductDeepDB = Prisma.ProductGetPayload<{
  include: {
    Item: true;
  };
}>;

const dbProductoToAPI: (
  item: ProductDeepDB,
) => z.infer<typeof productWithItemOut> = (item) => {
  const { Item, ...restOfItem } = item;

  return {
    ...restOfItem,
    item: Item,
  };
};

export const productRouter = createTRPCRouter({
  getByID,
});
