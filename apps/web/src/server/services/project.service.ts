import { currentUser } from "@clerk/nextjs/server";
import { type Database } from "~/server/db";
import { type z } from "zod";
import {
  type projectCreateInput,
  type projectUpdateInput,
  type addMemberInput,
} from "~/schemas/project";
import { TraceNames, withTrace } from "~/server/tracing";
import { getDb } from "~/server/repo/database-helpers";
import {
  user,
  project,
  projectMember,
  recipe,
  product,
  location,
} from "~/server/db/schema";
import { eq, and, count } from "drizzle-orm";

export class ProjectService {
  constructor(private db: Database) {}

  /**
   * Sync Clerk user to local database if needed
   */
  async syncUser(userId: string): Promise<void> {
    // Check if user exists locally
    const existingUser = await getDb(this.db).query.user.findFirst({
      where: eq(user.id, userId),
    });

    if (!existingUser) {
      // Get current user from Clerk session
      const clerkUser = await currentUser();

      if (!clerkUser || clerkUser.id !== userId) {
        throw new Error("User not found");
      }

      const primaryEmail = clerkUser.emailAddresses.find(
        (e) => e.id === clerkUser.primaryEmailAddressId,
      )?.emailAddress;

      if (!primaryEmail) {
        throw new Error("User has no primary email");
      }

      await getDb(this.db)
        .insert(user)
        .values({
          id: userId,
          email: primaryEmail,
          firstName: clerkUser.firstName ?? null,
          lastName: clerkUser.lastName ?? null,
          imageUrl: clerkUser.imageUrl,
        });
    }
  }

  /**
   * Get or create default project for user
   */
  async ensureDefaultProject(userId: string): Promise<string> {
    return withTrace(
      TraceNames.service("project", "ensureDefaultProject"),
      async (span) => {
        span.setAttributes({
          "user.id": userId,
        });

        // Ensure user exists locally
        await this.syncUser(userId);

        // Check if user has any projects
        const membership = await getDb(this.db).query.projectMember.findFirst({
          where: eq(projectMember.userId, userId),
          with: { project: true },
        });

        if (membership) {
          span.setAttributes({
            "project.id": membership.projectId,
            "project.isExisting": true,
          });
          return membership.projectId;
        }

        // Create default project
        const userRecord = await getDb(this.db).query.user.findFirst({
          where: eq(user.id, userId),
        });

        const [newProject] = await getDb(this.db)
          .insert(project)
          .values({
            name: `${userRecord?.firstName || "My"} Household`,
            description: "Default project",
          })
          .returning();

        // Add user as member
        await getDb(this.db).insert(projectMember).values({
          projectId: newProject!.id,
          userId,
        });

        span.setAttributes({
          "project.id": newProject!.id,
          "project.isExisting": false,
          "project.name": newProject!.name,
        });

        return newProject!.id;
      },
    );
  }

  /**
   * Verify user has access to project
   */
  async verifyProjectAccess(
    userId: string,
    projectId: string,
  ): Promise<boolean> {
    return withTrace(
      TraceNames.service("project", "verifyProjectAccess"),
      async (span) => {
        span.setAttributes({
          "project.id": projectId,
          "user.id": userId,
        });

        const membership = await getDb(this.db).query.projectMember.findFirst({
          where: and(
            eq(projectMember.projectId, projectId),
            eq(projectMember.userId, userId),
          ),
        });

        const hasAccess = !!membership;
        span.setAttributes({
          "project.hasAccess": hasAccess,
        });

        return hasAccess;
      },
    );
  }

  /**
   * Get user's projects
   */
  async getUserProjects(userId: string) {
    await this.syncUser(userId);

    // Get projects where user is a member
    const memberships = await getDb(this.db).query.projectMember.findMany({
      where: eq(projectMember.userId, userId),
      with: { project: true },
    });

    const projects = memberships.map((m) => m.project);

    // Get counts for each project
    const projectsWithCounts = await Promise.all(
      projects.map(async (proj) => {
        const [memberCount] = await getDb(this.db)
          .select({ count: count() })
          .from(projectMember)
          .where(eq(projectMember.projectId, proj.id));

        const [recipeCount] = await getDb(this.db)
          .select({ count: count() })
          .from(recipe)
          .where(eq(recipe.projectId, proj.id));

        const [productCount] = await getDb(this.db)
          .select({ count: count() })
          .from(product)
          .where(eq(product.projectId, proj.id));

        const [locationCount] = await getDb(this.db)
          .select({ count: count() })
          .from(location)
          .where(eq(location.projectId, proj.id));

        return {
          ...proj,
          _count: {
            members: memberCount!.count,
            recipes: recipeCount!.count,
            products: productCount!.count,
            locations: locationCount!.count,
          },
        };
      }),
    );

    // Sort by createdAt desc
    return projectsWithCounts.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  /**
   * Get project by ID (with access check)
   */
  async getProjectById(userId: string, projectId: string) {
    const hasAccess = await this.verifyProjectAccess(userId, projectId);

    if (!hasAccess) {
      throw new Error("Not a member of this project");
    }

    const proj = await getDb(this.db).query.project.findFirst({
      where: eq(project.id, projectId),
    });

    if (!proj) {
      return null;
    }

    // Get counts
    const [memberCount] = await getDb(this.db)
      .select({ count: count() })
      .from(projectMember)
      .where(eq(projectMember.projectId, proj.id));

    const [recipeCount] = await getDb(this.db)
      .select({ count: count() })
      .from(recipe)
      .where(eq(recipe.projectId, proj.id));

    const [productCount] = await getDb(this.db)
      .select({ count: count() })
      .from(product)
      .where(eq(product.projectId, proj.id));

    const [locationCount] = await getDb(this.db)
      .select({ count: count() })
      .from(location)
      .where(eq(location.projectId, proj.id));

    return {
      ...proj,
      _count: {
        members: memberCount!.count,
        recipes: recipeCount!.count,
        products: productCount!.count,
        locations: locationCount!.count,
      },
    };
  }

  /**
   * Create new project
   */
  async createProject(
    userId: string,
    data: z.infer<typeof projectCreateInput>,
  ) {
    await this.syncUser(userId);

    const [newProject] = await getDb(this.db)
      .insert(project)
      .values({
        name: data.name,
        description: data.description ?? null,
      })
      .returning();

    // Add user as member
    await getDb(this.db).insert(projectMember).values({
      projectId: newProject!.id,
      userId,
    });

    return {
      ...newProject!,
      _count: {
        members: 1,
      },
    };
  }

  /**
   * Update project
   */
  async updateProject(
    userId: string,
    projectId: string,
    data: z.infer<typeof projectUpdateInput>,
  ) {
    const hasAccess = await this.verifyProjectAccess(userId, projectId);

    if (!hasAccess) {
      throw new Error("Not a member of this project");
    }

    const [updated] = await getDb(this.db)
      .update(project)
      .set({
        name: data.name,
        description: data.description ?? null,
      })
      .where(eq(project.id, projectId))
      .returning();

    // Get member count
    const [memberCount] = await getDb(this.db)
      .select({ count: count() })
      .from(projectMember)
      .where(eq(projectMember.projectId, projectId));

    return {
      ...updated!,
      _count: {
        members: memberCount!.count,
      },
    };
  }

  /**
   * Add member to project
   */
  async addMember(userId: string, data: z.infer<typeof addMemberInput>) {
    // Verify current user is member
    const hasAccess = await this.verifyProjectAccess(userId, data.projectId);

    if (!hasAccess) {
      throw new Error("Not authorized to add members");
    }

    // Find user by email
    const userRecord = await getDb(this.db).query.user.findFirst({
      where: eq(user.email, data.email),
    });

    if (!userRecord) {
      throw new Error("User not found. They must sign up first.");
    }

    // Check if already a member
    const existingMembership = await getDb(
      this.db,
    ).query.projectMember.findFirst({
      where: and(
        eq(projectMember.projectId, data.projectId),
        eq(projectMember.userId, userRecord.id),
      ),
    });

    if (existingMembership) {
      throw new Error("User is already a member of this project");
    }

    // Add as member
    const [newMember] = await getDb(this.db)
      .insert(projectMember)
      .values({
        projectId: data.projectId,
        userId: userRecord.id,
      })
      .returning();

    return newMember!;
  }

  /**
   * Get project members
   */
  async getProjectMembers(userId: string, projectId: string) {
    const hasAccess = await this.verifyProjectAccess(userId, projectId);

    if (!hasAccess) {
      throw new Error("Not a member of this project");
    }

    return await getDb(this.db).query.projectMember.findMany({
      where: eq(projectMember.projectId, projectId),
      with: {
        user: true,
      },
    });
  }

  /**
   * Remove member from project
   */
  async removeMember(userId: string, projectId: string, memberUserId: string) {
    const hasAccess = await this.verifyProjectAccess(userId, projectId);

    if (!hasAccess) {
      throw new Error("Not a member of this project");
    }

    // Don't allow removing yourself if you're the last member
    const [memberCountResult] = await getDb(this.db)
      .select({ count: count() })
      .from(projectMember)
      .where(eq(projectMember.projectId, projectId));

    if (memberCountResult!.count === 1 && userId === memberUserId) {
      throw new Error("Cannot remove the last member from the project");
    }

    const [deleted] = await getDb(this.db)
      .delete(projectMember)
      .where(
        and(
          eq(projectMember.projectId, projectId),
          eq(projectMember.userId, memberUserId),
        ),
      )
      .returning();

    return deleted!;
  }
}
