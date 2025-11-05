import { currentUser } from "@clerk/nextjs/server";
import { type Database } from "~/server/db";
import { type z } from "zod";
import {
  type projectCreateInput,
  type projectUpdateInput,
  type addMemberInput,
} from "~/schemas/project";
import { TraceNames, withTrace } from "~/server/tracing";
import * as projectRepo from "~/server/repo/project";
import * as userRepo from "~/server/repo/user";

export class ProjectService {
  constructor(private db: Database) {}

  /**
   * Sync Clerk user to local database if needed
   */
  async syncUser(userId: string): Promise<void> {
    // Check if user exists locally
    const existingUser = await userRepo.findUserByClerkId(this.db, userId);

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

      await userRepo.insertUser(this.db, {
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
        const membership = await projectRepo.findProjectMembershipByUserId(
          this.db,
          userId,
        );

        if (membership) {
          span.setAttributes({
            "project.id": membership.projectId,
            "project.isExisting": true,
          });
          return membership.projectId;
        }

        // Create default project
        const userRecord = await userRepo.findUserByClerkId(this.db, userId);

        const newProject = await projectRepo.createProject(this.db, {
          name: `${userRecord?.firstName || "My"} Household`,
          description: "Default project",
        });

        // Add user as member
        await projectRepo.addProjectMember(this.db, {
          projectId: newProject.id,
          userId,
        });

        span.setAttributes({
          "project.id": newProject.id,
          "project.isExisting": false,
          "project.name": newProject.name,
        });

        return newProject.id;
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

        const membership = await projectRepo.findProjectMembership(
          this.db,
          projectId,
          userId,
        );

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
    const memberships = await projectRepo.getUserProjectMemberships(
      this.db,
      userId,
    );

    const projects = memberships.map((m) => m.project);

    // Get counts for each project
    const projectsWithCounts = await Promise.all(
      projects.map(async (proj) => {
        const counts = await projectRepo.getProjectCounts(this.db, proj.id);

        return {
          ...proj,
          _count: counts,
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

    const proj = await projectRepo.getProjectById(this.db, projectId);

    if (!proj) {
      return null;
    }

    // Get counts
    const counts = await projectRepo.getProjectCounts(this.db, proj.id);

    return {
      ...proj,
      _count: counts,
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

    const newProject = await projectRepo.createProject(this.db, {
      name: data.name,
      description: data.description ?? null,
    });

    // Add user as member
    await projectRepo.addProjectMember(this.db, {
      projectId: newProject.id,
      userId,
    });

    return {
      ...newProject,
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

    const updated = await projectRepo.updateProjectById(this.db, projectId, {
      name: data.name,
      description: data.description ?? null,
    });

    // Get member count
    const memberCount = await projectRepo.getProjectMemberCount(
      this.db,
      projectId,
    );

    return {
      ...updated,
      _count: {
        members: memberCount,
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
    const userRecord = await userRepo.findUserByEmail(this.db, data.email);

    if (!userRecord) {
      throw new Error("User not found. They must sign up first.");
    }

    // Check if already a member
    const existingMembership = await projectRepo.findProjectMembership(
      this.db,
      data.projectId,
      userRecord.id,
    );

    if (existingMembership) {
      throw new Error("User is already a member of this project");
    }

    // Add as member
    const newMember = await projectRepo.addProjectMember(this.db, {
      projectId: data.projectId,
      userId: userRecord.id,
    });

    return newMember;
  }

  /**
   * Get project members
   */
  async getProjectMembers(userId: string, projectId: string) {
    const hasAccess = await this.verifyProjectAccess(userId, projectId);

    if (!hasAccess) {
      throw new Error("Not a member of this project");
    }

    return await projectRepo.getProjectMembers(this.db, projectId);
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
    const memberCount = await projectRepo.getProjectMemberCount(
      this.db,
      projectId,
    );

    if (memberCount === 1 && userId === memberUserId) {
      throw new Error("Cannot remove the last member from the project");
    }

    const deleted = await projectRepo.removeProjectMember(
      this.db,
      projectId,
      memberUserId,
    );

    return deleted;
  }
}
