import { parseEntityRef, runShortcode } from "@cubby/schemas/identifiers";

import { connectionContract } from "~/contracts/entity-graph.contract";
import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import {
  readEntityConnections,
  readEntityConnectionsBatch,
} from "~/server/domains/connection/repo/entity-connections";
import { scheduleConnectionRefresh } from "~/server/domains/run/repo/connection-refresh";
import { lookupShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const connectionHandlers = implementOperationDomain(connectionContract, {
  read: async (context, source) => ({
    source,
    proposals: await readEntityConnections(context.db, source),
  }),
  readBatch: async (context, { sources }) => {
    const proposals = await readEntityConnectionsBatch(context.db, sources);
    return sources.map((source, index) => ({
      source,
      proposals: proposals[index] ?? [],
    }));
  },
  discover: async (context, source) => {
    const activation = await readAiRefreshActivation(context.db);
    if (!activation?.enabled)
      throw new Error(
        "Connection discovery requires an active AI refresh generation",
      );
    const runId = await scheduleConnectionRefresh(
      context.db,
      source,
      context.actorContext,
    );
    const codes = runId
      ? await lookupShortcodes(context.db, [parseEntityRef("run", runId)])
      : new Map<string, string>();
    const discoveryRunId = runId
      ? runShortcode.parse(codes.get(`run:${runId}`))
      : null;
    return {
      source,
      proposals: await readEntityConnections(context.db, source),
      discoveryRunId,
    };
  },
});
