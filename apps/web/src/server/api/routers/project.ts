import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import {
  projectCreateInput,
  projectUpdateInput,
  projectOut,
  projectWithMembersOut,
  projectMemberOut,
  projectAccessInput,
  addMemberInput,
  getMembersInput,
} from "~/schemas/project";
import { IDInput } from "~/schemas/common";
import { ProjectService } from "~/server/services/project.service";

export const projectRouter = createTRPCRouter({
  // Get user's projects
  list: protectedProcedure
    .output(projectWithMembersOut.array())
    .query(async ({ ctx }) => {
      const projectService = new ProjectService(ctx.db);
      return await projectService.getUserProjects(ctx.auth.userId);
    }),

  // Get current active project (by ID)
  getByID: protectedProcedure
    .input(IDInput)
    .output(projectWithMembersOut.nullable())
    .query(async ({ ctx, input }) => {
      const projectService = new ProjectService(ctx.db);
      return await projectService.getProjectById(ctx.auth.userId, input.id);
    }),

  // Create new project
  create: protectedProcedure
    .input(projectCreateInput)
    .output(projectOut)
    .mutation(async ({ ctx, input }) => {
      const projectService = new ProjectService(ctx.db);
      return await projectService.createProject(ctx.auth.userId, input);
    }),

  // Update project
  update: protectedProcedure
    .input(IDInput.merge(projectUpdateInput))
    .output(projectOut)
    .mutation(async ({ ctx, input }) => {
      const projectService = new ProjectService(ctx.db);
      const { id, ...data } = input;
      return await projectService.updateProject(ctx.auth.userId, id, data);
    }),

  // Validate project access (for client-side project switching)
  validateAccess: protectedProcedure
    .input(projectAccessInput)
    .output(projectAccessInput.extend({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const projectService = new ProjectService(ctx.db);

      const hasAccess = await projectService.verifyProjectAccess(
        ctx.auth.userId,
        input.projectId,
      );

      if (!hasAccess) {
        throw new Error("Not a member of this project");
      }

      return { success: true, projectId: input.projectId };
    }),

  // Add member to project
  addMember: protectedProcedure
    .input(addMemberInput)
    .mutation(async ({ ctx, input }) => {
      const projectService = new ProjectService(ctx.db);
      return await projectService.addMember(ctx.auth.userId, input);
    }),

  // Get project members
  getMembers: protectedProcedure
    .input(getMembersInput)
    .output(projectMemberOut.array())
    .query(async ({ ctx, input }) => {
      const projectService = new ProjectService(ctx.db);
      return await projectService.getProjectMembers(
        ctx.auth.userId,
        input.projectId,
      );
    }),

  // Remove member from project
  removeMember: protectedProcedure
    .input(
      getMembersInput.extend({
        memberUserId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const projectService = new ProjectService(ctx.db);
      return await projectService.removeMember(
        ctx.auth.userId,
        input.projectId,
        input.memberUserId,
      );
    }),

  // Get default project for user (create if needed)
  getDefault: protectedProcedure
    .output(z.object({ projectId: z.string() }))
    .query(async ({ ctx }) => {
      const projectService = new ProjectService(ctx.db);
      const projectId = await projectService.ensureDefaultProject(
        ctx.auth.userId,
      );
      return { projectId };
    }),
});
