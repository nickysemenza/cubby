import { z } from "zod";

export const taskStatusValues = [
  "not_started",
  "later",
  "in_progress",
  "blocked",
  "done",
] as const;
export const taskStatusSchema = z.enum(taskStatusValues);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const TASK_STATUS_LABELS = {
  not_started: "Not started",
  later: "Later",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
} as const satisfies Record<TaskStatus, string>;

export const tradeValues = [
  "planning",
  "demolition",
  "building",
  "drywall",
  "electrical",
  "plumbing",
  "mechanical",
  "cabinetry",
  "countertop",
  "flooring",
  "millwork",
  "finishes",
  "appliances",
  "landscaping",
  "logistics",
  "metalworking",
  "crafts",
  "auto",
  "other",
] as const;
export const tradeSchema = z.enum(tradeValues);
export type Trade = z.infer<typeof tradeSchema>;

export const TRADE_LABELS = {
  planning: "Planning",
  demolition: "Demo & Cleanup",
  building: "Building & Framing",
  drywall: "Drywall",
  electrical: "Electrical & Lighting",
  plumbing: "Plumbing",
  mechanical: "Mechanical / HVAC",
  cabinetry: "Cabinetry",
  countertop: "Countertops",
  flooring: "Flooring",
  millwork: "Trim & Millwork",
  finishes: "Paint & Finishes",
  appliances: "Appliances & Furniture",
  landscaping: "Landscaping",
  logistics: "Logistics & Moving",
  metalworking: "Metalworking",
  crafts: "Arts & Crafts",
  auto: "Auto",
  other: "Other",
} as const satisfies Record<Trade, string>;
