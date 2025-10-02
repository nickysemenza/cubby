import { currentUser } from "@clerk/nextjs/server";
import { type Database } from "~/server/db";
import { type z } from "zod";
import {
  type projectCreateInput,
  type projectUpdateInput,
  type addMemberInput,
} from "~/schemas/project";
import { TraceNames, withTrace } from "~/server/tracing";

export class ProjectService {
  constructor(private db: Database) {}

  /**
   * Sync Clerk user to local database if needed
   */
  async syncUser(userId: string): Promise<void> {
    // Check if user exists locally
    const existingUser = await this.db.user.findUnique({
      where: { id: userId },
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

      await this.db.user.create({
        data: {
          id: userId,
          email: primaryEmail,
          firstName: clerkUser.firstName,
          lastName: clerkUser.lastName,
          imageUrl: clerkUser.imageUrl,
        },
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
        const membership = await this.db.projectMember.findFirst({
          where: { userId },
          include: { project: true },
        });

        if (membership) {
          span.setAttributes({
            "project.id": membership.projectId,
            "project.isExisting": true,
          });
          return membership.projectId;
        }

        // Create default project
        const user = await this.db.user.findUnique({
          where: { id: userId },
        });

        const project = await this.db.project.create({
          data: {
            name: `${user?.firstName || "My"} Household`,
            description: "Default project",
            members: {
              create: { userId },
            },
          },
        });

        span.setAttributes({
          "project.id": project.id,
          "project.isExisting": false,
          "project.name": project.name,
        });

        return project.id;
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

        const membership = await this.db.projectMember.findUnique({
          where: {
            projectId_userId: { projectId, userId },
          },
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

    return await this.db.project.findMany({
      where: {
        members: {
          some: { userId },
        },
      },
      include: {
        _count: {
          select: {
            members: true,
            recipes: true,
            products: true,
            locations: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Get project by ID (with access check)
   */
  async getProjectById(userId: string, projectId: string) {
    const hasAccess = await this.verifyProjectAccess(userId, projectId);

    if (!hasAccess) {
      throw new Error("Not a member of this project");
    }

    return await this.db.project.findUnique({
      where: { id: projectId },
      include: {
        _count: {
          select: {
            members: true,
            recipes: true,
            products: true,
            locations: true,
          },
        },
      },
    });
  }

  /**
   * Create new project
   */
  async createProject(
    userId: string,
    data: z.infer<typeof projectCreateInput>,
  ) {
    await this.syncUser(userId);

    return await this.db.project.create({
      data: {
        ...data,
        members: {
          create: {
            userId,
          },
        },
      },
      include: {
        _count: {
          select: { members: true },
        },
      },
    });
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

    return await this.db.project.update({
      where: { id: projectId },
      data,
      include: {
        _count: {
          select: { members: true },
        },
      },
    });
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
    const user = await this.db.user.findUnique({
      where: { email: data.email },
    });

    if (!user) {
      throw new Error("User not found. They must sign up first.");
    }

    // Check if already a member
    const existingMembership = await this.db.projectMember.findUnique({
      where: {
        projectId_userId: {
          projectId: data.projectId,
          userId: user.id,
        },
      },
    });

    if (existingMembership) {
      throw new Error("User is already a member of this project");
    }

    // Add as member
    return await this.db.projectMember.create({
      data: {
        projectId: data.projectId,
        userId: user.id,
      },
    });
  }

  /**
   * Get project members
   */
  async getProjectMembers(userId: string, projectId: string) {
    const hasAccess = await this.verifyProjectAccess(userId, projectId);

    if (!hasAccess) {
      throw new Error("Not a member of this project");
    }

    return await this.db.projectMember.findMany({
      where: { projectId },
      include: {
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
    const memberCount = await this.db.projectMember.count({
      where: { projectId },
    });

    if (memberCount === 1 && userId === memberUserId) {
      throw new Error("Cannot remove the last member from the project");
    }

    return await this.db.projectMember.delete({
      where: {
        projectId_userId: {
          projectId,
          userId: memberUserId,
        },
      },
    });
  }
}
