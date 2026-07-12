import { Hono } from "hono";
import type { Env } from "../types";
import { dashboardRoutes } from "./admin-dashboard";
import { missRoutes } from "./admin-misses";
import { productRoutes } from "./admin-products";

const admin = new Hono<{ Bindings: Env }>();

admin.route("/", dashboardRoutes);
admin.route("/", productRoutes);
admin.route("/", missRoutes);

export { admin };
