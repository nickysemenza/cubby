import {
  ASSESSMENT_READ_RULES_VERSION,
  ASSESSMENT_READ_TARGET,
} from "@cubby/schemas/assessment-read-publication";
import {
  connectionEdgeFromKey,
  connectionEdgeKey,
  type ConnectionEdge,
} from "@cubby/schemas/entity-connections";
import { eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  readConnectionAssessmentEdges,
  readConnectionEdgeAssessmentIds,
  readPotentialConnectionAssessmentIds,
} from "~/server/domains/connection/repo/existing-assessments";
import {
  readAssessmentReadFrame,
  readAssessmentReadStage,
  readOpenAssessmentReadIds,
  withAssessmentReadSnapshot,
  type AssessmentReadStagePlan,
} from "~/server/generic/assessment/repo/read-publication";
import { DERIVED_DRAIN } from "~/server/generic/derived/repo/drain";
import { fanoutTargetMatches } from "~/server/generic/derived/repo/fanout";
import {
  observePendingWork,
  type WorkItem,
} from "~/server/generic/jobs/repo/work-items";
import { stopsDrainPage } from "~/server/generic/jobs/service/drain";
import { sha256CanonicalJson } from "~/server/lib/canonical-json";

const PREPARATION_LIMIT = 20;

export type AssessmentReadPreparationPlan = {
  stage: AssessmentReadStagePlan;
  previousStageIds: string[];
  idsToPrepare: string[];
  currentGroups: ReadonlyMap<string, string>;
  work: readonly WorkItem[];
};

/** One connected component shares a repeatable snapshot and exact work observations. */
async function prepareAssessmentReadComponent<Prepared>(
  db: Database,
  seed: string,
  prepare: (
    snapshot: Database,
    plan: AssessmentReadPreparationPlan,
  ) => Promise<Prepared>,
): Promise<{ plan: AssessmentReadPreparationPlan; prepared: Prepared }> {
  return withAssessmentReadSnapshot(db, async (snapshot) => {
    // Observing fanouts fixes the snapshot before mutable identity discovery.
    // Later writes remain owed and the publication barrier rejects their tickets.
    const fanouts = await observePendingWork(snapshot, {
      drain: DERIVED_DRAIN.key,
      eligible: (target) =>
        fanoutTargetMatches(target, sql`${ASSESSMENT_READ_TARGET}::text`),
    });
    const members = new Set([seed]);
    const groups = new Set<string>();
    const currentGroups = new Map<string, string>();
    const edges = new Map<string, ConnectionEdge>();
    const read = new Set<string>();
    const probed = new Set<string>();
    const previousStages = new Set<string>();
    for (;;) {
      const before = members.size + groups.size;
      const unread = [...members].filter((id) => !read.has(id));
      const current = await readConnectionAssessmentEdges(snapshot, unread);
      for (const id of unread) {
        read.add(id);
        const edge = current.get(id);
        const group = edge ? connectionEdgeKey(edge) : `assessment:${id}`;
        currentGroups.set(id, group);
        groups.add(group);
        if (edge) edges.set(group, edge);
      }
      const frame = await readAssessmentReadFrame(
        snapshot,
        [...members],
        [...groups],
      );
      for (const header of frame.headers) {
        members.add(header.id);
        groups.add(header.groupKey);
      }
      for (const stage of frame.stages) {
        previousStages.add(stage.id);
        stage.assessmentIds.forEach((id) => members.add(id));
        stage.groups.forEach((group) => groups.add(group));
      }
      const requested = [...groups]
        .filter((group) => !probed.has(group))
        .flatMap((group) => {
          probed.add(group);
          const edge = edges.get(group) ?? connectionEdgeFromKey(group);
          return edge ? [edge] : [];
        });
      if (requested.length) {
        const sources = [
          ...new Map(
            requested
              .flatMap((edge) => [edge.source, edge.target])
              .map((ref) => [`${ref.entityKind}:${ref.entityId}`, ref]),
          ).values(),
        ];
        const peerIds = [
          ...new Set([
            ...(await readConnectionEdgeAssessmentIds(snapshot, requested)),
            ...(await readPotentialConnectionAssessmentIds(snapshot, sources)),
          ]),
        ].filter((id) => !members.has(id));
        const open = await readOpenAssessmentReadIds(snapshot, peerIds);
        const peers = await readConnectionAssessmentEdges(snapshot, open);
        for (const [id, edge] of peers) {
          const group = connectionEdgeKey(edge);
          if (!groups.has(group)) continue;
          members.add(id);
          read.add(id);
          currentGroups.set(id, group);
          edges.set(group, edge);
        }
      }
      if (before === members.size + groups.size) break;
    }
    const assessmentIds = [...members].sort();
    const orderedGroups = [...groups].sort();
    const componentKey = await sha256CanonicalJson(orderedGroups);
    const direct = await observePendingWork(snapshot, {
      drain: DERIVED_DRAIN.key,
      eligible: (target) => eq(target, ASSESSMENT_READ_TARGET),
      scope: { target: ASSESSMENT_READ_TARGET, refs: assessmentIds },
    });
    const observations = [...fanouts, ...direct].map(
      ({ target, ref, ticket }) => ({ target, ref, ticket }),
    );
    const existing = await readAssessmentReadStage(snapshot, componentKey);
    if (
      existing &&
      JSON.stringify(existing.groups) !== JSON.stringify(orderedGroups)
    )
      throw new Error("Assessment component hash matched different groups");
    const observed = new Set(existing?.tickets.map((item) => item.ticket));
    const reusable =
      existing &&
      existing.rulesVersion === ASSESSMENT_READ_RULES_VERSION &&
      JSON.stringify(existing.assessmentIds) ===
        JSON.stringify(assessmentIds) &&
      observations.every((item) => observed.has(item.ticket));
    if (existing && !reusable) previousStages.add(existing.id);
    const stage: AssessmentReadStagePlan = reusable
      ? existing
      : {
          id: crypto.randomUUID(),
          revision: crypto.randomUUID(),
          componentKey,
          groups: orderedGroups,
          assessmentIds,
          tickets: observations,
          nextIndex: 0,
          rulesVersion: ASSESSMENT_READ_RULES_VERSION,
        };
    previousStages.delete(stage.id);
    const plan: AssessmentReadPreparationPlan = {
      stage,
      previousStageIds: [...previousStages],
      currentGroups,
      work: direct,
      idsToPrepare: stage.assessmentIds.slice(
        stage.nextIndex,
        stage.nextIndex + PREPARATION_LIMIT,
      ),
    };
    return { plan, prepared: await prepare(snapshot, plan) };
  });
}

/** Unrelated claimed records never share activation or preparation-failure fate. */
export async function prepareAssessmentReadPublication<Prepared>(
  db: Database,
  ids: readonly string[],
  prepare: (
    snapshot: Database,
    plan: AssessmentReadPreparationPlan,
  ) => Promise<Prepared>,
): Promise<{
  components: { plan: AssessmentReadPreparationPlan; prepared: Prepared }[];
  failures: ReadonlyMap<string, unknown>;
}> {
  const remaining = new Set(ids);
  const components: {
    plan: AssessmentReadPreparationPlan;
    prepared: Prepared;
  }[] = [];
  const failures = new Map<string, unknown>();
  for (const seed of remaining) {
    let claimed = [seed];
    try {
      const component = await prepareAssessmentReadComponent(
        db,
        seed,
        async (snapshot, plan) => {
          claimed = plan.stage.assessmentIds.filter((id) => remaining.has(id));
          for (const id of claimed) remaining.delete(id);
          return prepare(snapshot, plan);
        },
      );
      components.push(component);
    } catch (error) {
      // A failed SQL preparation aborts only this component's snapshot. Control
      // failures still stop the page through the existing drain policy owner.
      if (stopsDrainPage(error)) throw error;
      for (const id of claimed) {
        remaining.delete(id);
        failures.set(id, error);
      }
    }
  }
  return { components, failures };
}
