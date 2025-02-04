import { PrismaClient, Prisma } from "@prisma/client";
import { ProductConfigItem } from "~/server/config";

export const loadProducts = async (
  db: PrismaClient,
  data: ProductConfigItem[],
) => {
  const now = new Date();

  for (const product of data) {
    const { name, manufacturer, upc, model } = product;
    const upsertFields = { name, manufacturer, upc, model, updatedAt: now };
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
