import { z } from "zod";

export const DATABASE_CHANGES_SOCKET_PATH = "/api/database-changes/socket";

export const databaseChangeMessage = z.object({
  type: z.literal("invalidate"),
  categories: z.array(z.string().min(1)).max(256),
});
