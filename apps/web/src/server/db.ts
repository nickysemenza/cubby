import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";

import { env } from "~/env";

const createPrismaClient = () => {
  const connectionString = env.DATABASE_URL;
  const isNeon = connectionString.includes("neon.tech");

  const args: Partial<Prisma.PrismaClientOptions> = isNeon
    ? { adapter: new PrismaNeon({ connectionString }) }
    : {
        datasources: {
          db: {
            url: connectionString,
          },
        },
      };
  return new PrismaClient({
    log: ["development", "test"].includes(env.NODE_ENV)
      ? ["query", "error", "warn"]
      : ["error"],
    ...args,
  });
};
const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createPrismaClient> | undefined;
};

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (env.NODE_ENV !== "production") globalForPrisma.prisma = db;

export type Database = typeof db;
