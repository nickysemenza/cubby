export interface Env {
  // D1 Database
  DB: D1Database;

  // R2 Bucket for images
  IMAGES: R2Bucket;

  // Secrets (set via wrangler secret put)
  API_KEY: string;
}

// Hono app type with bindings
import type { Hono } from "hono";
export type App = Hono<{ Bindings: Env }>;
