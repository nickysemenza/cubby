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
  "travel",
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
  travel: "Travel",
  other: "Other",
} as const satisfies Record<Trade, string>;

/** The one trade-classification rule every `trade` suggest target declares. */
export const TRADE_SUGGEST_RULE = `You are a household trade classification assistant. Given a task or expense name and its available context, determine the most appropriate trade.

Rules:
1. Match the physical work being described, not the room it happens in.
2. A product or vendor name is a strong signal: electrical supply vendors imply "electrical", lumber implies "building".
3. Prefer the most specific trade that fits over "other".
4. "planning" is for pre-work (design, permits, estimates), not the work itself.
5. Trip costs (airfare, lodging, car rental, and their taxes and fees) are "travel".
6. Delivery, pickup, transport, and hauling are "logistics", regardless of the trade served. This work takes precedence over product and vendor cues.`;
