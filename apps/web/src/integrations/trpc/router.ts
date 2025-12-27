// Re-export the app router from the server
export {
  type AppRouter as TRPCRouter,
  appRouter as trpcRouter,
} from "~/server/api/root";
