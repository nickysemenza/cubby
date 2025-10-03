import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";

import { env } from "~/env";

export const createDBClient = (databaseUrl?: string) => {
  const connectionString = databaseUrl ?? env.DATABASE_URL;
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
  prisma: ReturnType<typeof createDBClient> | undefined;
};

const dbInstance = globalForPrisma.prisma ?? createDBClient();

if (env.NODE_ENV !== "production") globalForPrisma.prisma = dbInstance;

// Opaque type that prevents ALL method calls outside of repo layer
// This enforces that database access only happens in repo files
// Database has NO methods - it can only be passed around
declare const DatabaseBrand: unique symbol;
export interface Database {
  readonly [DatabaseBrand]: true;
}

/**
 * Convert a PrismaClient instance to the opaque Database type.
 * This brands the client to enforce that direct database access only happens in repo files.
 * Use this when creating Database instances (e.g., in test setup).
 */
export const toBrandedDatabase = (client: PrismaClient): Database => {
  return client as unknown as Database;
};

// Export the branded instance - NO methods can be called on this outside repo/
export const db = toBrandedDatabase(dbInstance);
