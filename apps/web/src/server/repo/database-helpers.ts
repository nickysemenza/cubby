import { Prisma, PrismaClient } from "@prisma/client";
import { type SortParams } from "~/schemas/pagination";
import { type Database } from "~/server/db";

// Helper function to format search terms for PostgreSQL full-text search
export const formatSearchTerm = (
  term?: string,
): Prisma.StringFilter | undefined => {
  if (term === undefined || term.trim() === "") {
    return undefined;
  }
  return { contains: term, mode: "insensitive" };
  // Replace spaces with & operator for AND logic
  // however, this seems slower than just using contains
  // return { search: term.trim().split(/\s+/).join(" & ") };
};

// Helper function to get sort direction for a field
export const getSortDirection = (sort: SortParams, field: string) =>
  sort.orderBy === field ? sort.direction : undefined;

/**
 * Get the underlying PrismaClient from the opaque Database type.
 * This should ONLY be used within repo files to access the database.
 * Services and routers should never call this - they just pass Database around.
 */
export const getDb = (db: Database): PrismaClient => {
  return db as unknown as PrismaClient;
};

/**
 * Safely unwrap Database or use TransactionClient directly.
 * Detects if the input is already a TransactionClient and returns it,
 * otherwise unwraps the branded Database type.
 */
export const unwrapDb = (
  db: Database | Prisma.TransactionClient,
): PrismaClient | Prisma.TransactionClient => {
  return "product" in db ? db : getDb(db);
};

/**
 * Transaction wrapper for interactive transactions (sequential operations).
 * Use this in repo functions when you need multiple operations to be atomic.
 */
export const withTransaction = async <T>(
  db: Database,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => {
  return await getDb(db).$transaction(fn);
};
