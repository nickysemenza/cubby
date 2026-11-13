import { connectionCandidate } from "@cubby/schemas/entity-connections";

import { connectionCandidateEvidence } from "~/server/db/retained-tables";
import {
  defineEvidence,
  defineModule,
  defineReconciler,
  rowKey,
  source,
} from "~/server/kernel/api";

export const connectionEvidence = defineEvidence({
  kind: "connection-candidate",
  table: connectionCandidateEvidence,
  keys: (row) => [
    `connection:${row.scopeKey}`,
    rowKey(row.sourceEntity, row.sourceId),
    rowKey(row.targetEntity, row.targetId),
  ],
  discovers: (row) => [{ kind: "connections", key: row.scopeKey }],
});
export const connectionSubject = (key: string) => `connection/${key}`;
const connectionReconciler = defineReconciler({
  scope: "connections",
  lane: "catalog",
  version: 1,
  reads: [source.evidence(connectionEvidence)],
  writes: [],
  async load(reads, keys) {
    const found = await reads.facts(
      connectionEvidence,
      keys.map((key) => `connection:${key}`),
    );
    const rows = [
      ...new Map(
        [...found.values()].flat().map((row) => [row.id, row]),
      ).values(),
    ];
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const previous = latest.get(row.scopeKey);
      if (
        !previous ||
        row.createdAt > previous.createdAt ||
        (row.createdAt.getTime() === previous.createdAt.getTime() &&
          row.id > previous.id)
      )
        latest.set(row.scopeKey, row);
    }
    return latest;
  },
  reconcile(row, c) {
    const subject = connectionSubject(row.scopeKey);
    const choice = c.decision("assignment", subject, "link");
    const candidate = connectionCandidate.parse(row.candidate);
    if (choice?.kind === "set" && choice.value === true)
      c.bind(
        { kind: connectionEvidence.kind, id: row.id },
        `${row.targetEntity}:${row.targetId}`,
        "decision",
      );
    else if (!choice || choice.kind === "release")
      c.gap.decision(candidate.label, {
        actions: [
          {
            channel: "assignment",
            kind: "set",
            subject,
            field: "link",
            value: true,
            label: "Link",
          },
          {
            channel: "assignment",
            kind: "set",
            subject,
            field: "link",
            value: false,
            label: "Dismiss",
          },
        ],
      });
    return c.done();
  },
});
export const connectionKernelModule = defineModule({
  name: "connections",
  evidence: [connectionEvidence],
  reconcilers: [connectionReconciler],
});
