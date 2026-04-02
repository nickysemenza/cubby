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

    return {
      projects,
      tasks: tasksWithNames,
      purchases: purchasesWithNames,
    };
  }),
});
