import { jobWaitReason, type JobWaitingOnReason } from "@cubby/schemas/job";
import { sql, type SQL } from "drizzle-orm";

type Facts = {
  leased: boolean;
  waitReason: string | null;
  later: boolean;
  deviceLane: boolean;
};
type Columns = { [K in keyof Facts]: SQL };

type Condition = "leased" | "funding" | "deviceWait" | "later" | "deviceLane";
type Rule = { reason: JobWaitingOnReason; all: readonly Condition[] };

// Ordered conditions describe both the in-memory and SQL classifiers.
const rules: readonly Rule[] = [
  { reason: "leased", all: ["leased"] },
  { reason: "waiting_funding", all: ["funding"] },
  { reason: "waiting_device", all: ["deviceWait", "later", "deviceLane"] },
  { reason: "blocked", all: ["deviceWait", "later"] },
  { reason: "backing_off", all: ["later"] },
  { reason: "waiting_device", all: ["deviceLane"] },
];

const factsOf = (f: Facts) => ({
  leased: f.leased,
  funding: f.waitReason === jobWaitReason.enum.ai_funding_window,
  deviceWait: f.waitReason === jobWaitReason.enum.device,
  later: f.later,
  deviceLane: f.deviceLane,
});
const columnsOf = (c: Columns) => ({
  leased: c.leased,
  funding: sql`${c.waitReason} = ${jobWaitReason.enum.ai_funding_window}`,
  deviceWait: sql`${c.waitReason} = ${jobWaitReason.enum.device}`,
  later: c.later,
  deviceLane: c.deviceLane,
});

export const classifyWaiting = (facts: Facts): JobWaitingOnReason =>
  rules.find((rule) => rule.all.every((condition) => factsOf(facts)[condition]))
    ?.reason ?? "due";

export const classifyWaitingSql = (columns: Columns) =>
  sql<JobWaitingOnReason>`(CASE ${sql.join(
    rules.map(
      (rule) =>
        sql`WHEN ${sql.join(
          rule.all.map((condition) => columnsOf(columns)[condition]),
          sql` AND `,
        )} THEN ${rule.reason}`,
    ),
    sql` `,
  )} ELSE ${"due"} END)::text`;
