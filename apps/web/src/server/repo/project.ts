import { type Database, type Transaction } from "~/server/db";
import { unwrapDb } from "~/server/repo/database-helpers";
import {
  project,
  projectMember,
  recipe,
  product,
  location,
} from "~/server/db/schema";
import { eq, and, count } from "drizzle-orm";

/**
 * Project repository functions
 */

export const createProject = async (
  db: Database | Transaction,
  projectData: {
    name: string;
    description: string | null;
  },
) => {
  const [created] = await unwrapDb(db)
    .insert(project)
    .values(projectData)
    .returning();
  if (!created) {
    throw new Error("Failed to create project");
  }
  return created;
};

export const getProjectById = async (
  db: Database | Transaction,
  projectId: string,
) => {
  return await unwrapDb(db).query.project.findFirst({
    where: eq(project.id, projectId),
  });
};

export const updateProjectById = async (
  db: Database | Transaction,
  projectId: string,
  projectData: {
    name?: string;
    description?: string | null;
  },
) => {
  const [updated] = await unwrapDb(db)
    .update(project)
    .set(projectData)
    .where(eq(project.id, projectId))
    .returning();
  if (!updated) {
    throw new Error("Failed to update project");
  }
  return updated;
};

/**
 * Project member repository functions
 */

export const findProjectMembershipByUserId = async (
  db: Database | Transaction,
  userId: string,
) => {
  return await unwrapDb(db).query.projectMember.findFirst({
    where: eq(projectMember.userId, userId),
    with: { project: true },
  });
};

export const findProjectMembership = async (
  db: Database | Transaction,
  projectId: string,
  userId: string,
) => {
  return await unwrapDb(db).query.projectMember.findFirst({
    where: and(
      eq(projectMember.projectId, projectId),
      eq(projectMember.userId, userId),
    ),
  });
};

export const getUserProjectMemberships = async (
  db: Database | Transaction,
  userId: string,
) => {
  return await unwrapDb(db).query.projectMember.findMany({
    where: eq(projectMember.userId, userId),
    with: { project: true },
  });
};

export const addProjectMember = async (
  db: Database | Transaction,
  memberData: {
    projectId: string;
    userId: string;
  },
) => {
  const [created] = await unwrapDb(db)
    .insert(projectMember)
    .values(memberData)
    .returning();
  if (!created) {
    throw new Error("Failed to add project member");
  }
  return created;
};

export const getProjectMembers = async (
  db: Database | Transaction,
  projectId: string,
) => {
  return await unwrapDb(db).query.projectMember.findMany({
    where: eq(projectMember.projectId, projectId),
    with: {
      user: true,
    },
  });
};

export const getProjectMemberCount = async (
  db: Database | Transaction,
  projectId: string,
) => {
  const [result] = await unwrapDb(db)
    .select({ count: count() })
    .from(projectMember)
    .where(eq(projectMember.projectId, projectId));

  return result!.count;
};

export const removeProjectMember = async (
  db: Database | Transaction,
  projectId: string,
  userId: string,
) => {
  const [deleted] = await unwrapDb(db)
    .delete(projectMember)
    .where(
      and(
        eq(projectMember.projectId, projectId),
        eq(projectMember.userId, userId),
      ),
    )
    .returning();

  if (!deleted) {
    throw new Error("Failed to remove project member");
  }
  return deleted;
};

/**
 * Project counts helper
 */

export const getProjectCounts = async (
  db: Database | Transaction,
  projectId: string,
) => {
  const [memberCount] = await unwrapDb(db)
    .select({ count: count() })
    .from(projectMember)
    .where(eq(projectMember.projectId, projectId));

  const [recipeCount] = await unwrapDb(db)
    .select({ count: count() })
    .from(recipe)
    .where(eq(recipe.projectId, projectId));

  const [productCount] = await unwrapDb(db)
    .select({ count: count() })
    .from(product)
    .where(eq(product.projectId, projectId));

  const [locationCount] = await unwrapDb(db)
    .select({ count: count() })
    .from(location)
    .where(eq(location.projectId, projectId));

  return {
    members: memberCount!.count,
    recipes: recipeCount!.count,
    products: productCount!.count,
    locations: locationCount!.count,
  };
};
