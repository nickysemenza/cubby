import { type Database, type Transaction } from "~/server/db";
import { unwrapDb } from "~/server/repo/database-helpers";
import { user } from "~/server/db/schema";
import { eq } from "drizzle-orm";

/**
 * User repository functions
 */

export const findUserByClerkId = async (
  db: Database | Transaction,
  userId: string,
) => {
  return await unwrapDb(db).query.user.findFirst({
    where: eq(user.id, userId),
  });
};

export const findUserByEmail = async (
  db: Database | Transaction,
  email: string,
) => {
  return await unwrapDb(db).query.user.findFirst({
    where: eq(user.email, email),
  });
};

export const insertUser = async (
  db: Database | Transaction,
  userData: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    imageUrl: string;
  },
) => {
  const [created] = await unwrapDb(db)
    .insert(user)
    .values(userData)
    .returning();
  if (!created) {
    throw new Error("Failed to insert user");
  }
  return created;
};
