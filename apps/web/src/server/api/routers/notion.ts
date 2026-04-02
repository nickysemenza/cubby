import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc";

export const notionRouter = createTRPCRouter({
  dashboard: publicProcedure.query(async ({ ctx }) => {
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

    // Fetch cover images for projects without a page-level cover
    const projectsNeedingImages = projects.filter((p) => !p.coverImage);
    const contentImages =
      projectsNeedingImages.length > 0
        ? await ctx.notionClient.getProjectImages(
            projectsNeedingImages.map((p) => p.id),
          )
        : {};

    // Merge content images into projects (page-level cover takes precedence)
    const projectsWithImages = projects.map((p) => ({
      ...p,
      coverImage: p.coverImage ?? contentImages[p.id] ?? null,
    }));

    return {
      projects: projectsWithImages,
      tasks: tasksWithNames,
      purchases: purchasesWithNames,
    };
  }),

  projectContent: publicProcedure
    .input(z.object({ pageId: z.string() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.notionClient) return null;
      return ctx.notionClient.getPageContent(input.pageId);
    }),
});
