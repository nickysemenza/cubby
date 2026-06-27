import {
  notionDashboardSchema,
  notionProjectContentInput,
  notionProjectContentOut,
  notionProjectImagesOut,
} from "~/server/clients/notion";
import { createTRPCRouter, protectedProcedure } from "../trpc";

export const notionRouter = createTRPCRouter({
  dashboard: protectedProcedure
    .output(notionDashboardSchema)
    .query(async ({ ctx }) => {
      if (!ctx.notionClient) return null;

      const [projects, tasks, purchases] = await Promise.all([
        ctx.notionClient.queryProjects(),
        ctx.notionClient.queryTasks(),
        ctx.notionClient.queryPurchases(),
      ]);

      // Resolve task/purchase project names from the projects list
      const projectMap = new Map(projects.map((p) => [p.id, p.name]));

      const tasksWithNames = tasks.map((t) => ({
        ...t,
        projectName: (t.projectName && projectMap.get(t.projectName)) ?? null,
      }));

      const purchasesWithNames = purchases.map((p) => ({
        ...p,
        projectName: (p.projectName && projectMap.get(p.projectName)) ?? null,
      }));

      return {
        projects,
        tasks: tasksWithNames,
        purchases: purchasesWithNames,
      };
    }),

  /** Separate query for cover images — loaded lazily so dashboard isn't blocked. */
  projectImages: protectedProcedure
    .output(notionProjectImagesOut)
    .query(async ({ ctx }) => {
      if (!ctx.notionClient) return {};

      const projects = await ctx.notionClient.queryProjects();
      const needImages = projects.filter((p) => !p.coverImage);
      if (needImages.length === 0) return {};

      const contentImages = await ctx.notionClient.getProjectImages(
        needImages.map((p) => p.id),
      );

      // Merge page-level covers with content images
      const allImages: Record<string, string> = {};
      for (const p of projects) {
        const img = p.coverImage ?? contentImages[p.id];
        if (img) allImages[p.id] = img;
      }
      return allImages;
    }),

  projectContent: protectedProcedure
    .input(notionProjectContentInput)
    .output(notionProjectContentOut)
    .query(async ({ ctx, input }) => {
      if (!ctx.notionClient) return null;
      return ctx.notionClient.getPageContent(input.pageId);
    }),
});
