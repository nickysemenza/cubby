import type { RunId } from "@cubby/schemas/identifiers";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { and, eq, inArray } from "drizzle-orm";

import type { DrizzleClient, DrizzleTransaction } from "~/server/db";
import { email as emailTable, run } from "~/server/db/schema";

/** The admitted source roster is immutable Run input; current Email status only describes its outcome. */
export async function readMailRunSources(
  client: DrizzleClient | DrizzleTransaction,
  runId: RunId,
) {
  const [owner] = await client
    .select({ input: run.input, purpose: run.purpose })
    .from(run)
    .where(eq(run.id, runId));
  if (owner?.purpose !== "mail_import") return [];
  const frozen = mailResearchRunInput.parse(owner.input).sources;
  const messages = await client
    .select()
    .from(emailTable)
    .where(
      inArray(
        emailTable.orderMailId,
        frozen.map((source) => source.orderMailId),
      ),
    );
  return frozen.map((source, position) => {
    const email = messages.find(
      (message) => message.orderMailId === source.orderMailId,
    );
    if (!email)
      throw new Error("An admitted Email is missing its durable identity.");
    return {
      ...source,
      position,
      email,
      owned: email.runId === runId,
      unchanged: email.checksum === source.checksum,
    };
  });
}

export async function assertMailRunMembership(
  client: DrizzleClient | DrizzleTransaction,
  runId: RunId,
  orderMailId: string,
) {
  const source = (await readMailRunSources(client, runId)).find(
    (item) => item.orderMailId === orderMailId,
  );
  if (!source?.owned)
    throw new Error(
      "This Mail import Run did not admit that Email; resolve only its own messages.",
    );
  if (!source.unchanged)
    throw new Error(
      "Admitted Email evidence changed; reconcile it before importing.",
    );
  return source;
}

/** An explicit member restart transfers only the original frozen roster, never discovery's pending queue. */
export async function transferMailRunSources(
  tx: DrizzleTransaction,
  fromRunId: RunId,
  toRunId: RunId,
  selected?: readonly string[],
) {
  const sources = (await readMailRunSources(tx, fromRunId)).filter(
    (source) => !selected || selected.includes(source.orderMailId),
  );
  if (
    !sources.length ||
    sources.some((source) => !source.owned || !source.unchanged)
  )
    throw new Error(
      "Mail restart evidence or ownership changed; reconcile the original Run.",
    );
  const assigned = await tx
    .update(emailTable)
    .set({ runId: toRunId, status: "researching", updatedAt: new Date() })
    .where(
      and(
        eq(emailTable.runId, fromRunId),
        inArray(
          emailTable.id,
          sources.map((source) => source.email.id),
        ),
      ),
    )
    .returning({ id: emailTable.id });
  if (assigned.length !== sources.length)
    throw new Error("Mail successor ownership transfer is incomplete.");
}
