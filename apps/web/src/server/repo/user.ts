import { type Database, type Transaction } from "~/server/db";
import { unwrapDb } from "~/server/repo/database-helpers";
import { user } from "~/server/db/schema";
import { eq } from "drizzle-orm";

/**
 * User repository functions
 */

export const findUserById = async (
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
    name: string;
    image?: string;
    emailVerified?: boolean;
  },
) => {
  const [created] = await unwrapDb(db)
    .insert(user)
    .values({
      id: userData.id,
      email: userData.email,
      name: userData.name,
      image: userData.image,
      emailVerified: userData.emailVerified ?? false,
    })
    .returning();
  if (!created) {
    throw new Error("Failed to insert user");
  }
  return created;
};
