import {
  ASSESSMENT_READ_RULES_VERSION,
  ASSESSMENT_READ_TARGET,
  assessmentReadResult,
} from "@cubby/schemas/assessment-read-publication";
import {
  connectionEdgeFromKey,
  connectionEdgeKey,
  type ConnectionEdge,
} from "@cubby/schemas/entity-connections";
import { and, eq, sql, type SQL } from "drizzle-orm";

import { householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import {
  readConnectionAssessmentEdges,
  readConnectionEdgeAssessmentIds,
} from "~/server/domains/connection/repo/existing-assessments";
import {
  assessmentReadStageBlocked,
  writeAssessmentReadStage,
  readAssessmentReadFrame,
  readAssessmentReadStage,
  readOpenAssessmentReadIds,
  withAssessmentReadSnapshot,
  type AssessmentReadStagePlan,
  type AssessmentReadStageWrite,
} from "~/server/generic/assessment/repo/read-publication";
import {
  prepareSuggestionAdmission,
  suggestionKeyFacts,
} from "~/server/generic/assessment/repo/suggestion-list";
import type {
  DerivedSinkPublication,
  DerivedSinkContinuation,
} from "~/server/generic/derived/repo/compute";
import { DERIVED_DRAIN } from "~/server/generic/derived/repo/drain";
import { fanoutTargetMatches } from "~/server/generic/derived/repo/fanout";
import {
  observePendingWork,
  type WorkItem,
} from "~/server/generic/jobs/repo/work-items";
import { stopsDrainPage } from "~/server/generic/jobs/service/drain";
import { sha256CanonicalJson } from "~/server/lib/canonical-json";

const PREPARATION_LIMIT = 20;
const ticketKey = ({
  target,
  ref,
  ticket,
}: Pick<WorkItem, "target" | "ref" | "ticket">) =>
  JSON.stringify([target, ref, ticket]);
type ReadSourceScope = (
  snapshot: Database,
  frame: Pick<AssessmentReadStagePlan, "assessmentIds" | "groups">,
) => Promise<NonNullable<AssessmentReadStageWrite["sourceScope"]>>;

export type AssessmentReadPreparationPlan = {
  stage: AssessmentReadStagePlan;
  previousStageIds: string[];
  idsToPrepare: string[];
  currentGroups: ReadonlyMap<string, string>;
  work: readonly WorkItem[];
  sourceScope: NonNullable<AssessmentReadStageWrite["sourceScope"]>;
};

/** One connected component shares a repeatable snapshot and exact work observations. */
async function prepareAssessmentReadComponent<Prepared>(
  db: Database,
  seed: string,
  limit: number,
  prepare: (
    snapshot: Database,
    plan: AssessmentReadPreparationPlan,
  ) => Promise<Prepared>,
  readSourceScope: ReadSourceScope | undefined,
): Promise<{ plan: AssessmentReadPreparationPlan; prepared: Prepared }> {
  return withAssessmentReadSnapshot(db, async (snapshot) => {
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
        const peerIds = (
          await readConnectionEdgeAssessmentIds(snapshot, requested)
        ).filter((id) => !members.has(id));
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
    const clockDay = orderedGroups.some(
      (group) => connectionEdgeFromKey(group)?.relation === "project-tool",
    )
      ? householdLocalDate()
      : null;
    // The metadata reads already fixed this repeatable snapshot. Observe only
    // relevant sources before canonical preparation, and reuse this predicate
    // with the exact observations at both publication barriers.
    const sourceScope =
      (await readSourceScope?.(snapshot, {
        assessmentIds,
        groups: orderedGroups,
      })) ?? (() => sql`true`);
    const fanouts = await observePendingWork(snapshot, {
      drain: DERIVED_DRAIN.key,
      eligible: (target, ref) =>
        and(
          fanoutTargetMatches(target, sql`${ASSESSMENT_READ_TARGET}::text`),
          sourceScope({ target, ref }),
        )!,
    });
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
    const observed = new Set(existing?.tickets.map(ticketKey));
    const reusable =
      existing &&
      existing.rulesVersion === ASSESSMENT_READ_RULES_VERSION &&
      existing.clockDay === clockDay &&
      JSON.stringify(existing.assessmentIds) ===
        JSON.stringify(assessmentIds) &&
      observations.every((item) => observed.has(ticketKey(item)));
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
          clockDay,
        };
    previousStages.delete(stage.id);
    const plan: AssessmentReadPreparationPlan = {
      stage,
      previousStageIds: [...previousStages],
      currentGroups,
      work: direct,
      sourceScope,
      idsToPrepare: stage.assessmentIds.slice(
        stage.nextIndex,
        stage.nextIndex + limit,
      ),
    };
    return { plan, prepared: await prepare(snapshot, plan) };
  });
}

type AssessmentReadPreparation<Prepared> = {
  components: { plan: AssessmentReadPreparationPlan; prepared: Prepared }[];
  failures: ReadonlyMap<string, unknown>;
  /** Claimed inputs outside the shared preparation budget stay owed. */
  retained: readonly string[];
};

/** Unrelated claimed records never share activation or preparation-failure fate. */
export async function prepareAssessmentReadPublication<Prepared>(
  db: Database,
  ids: readonly string[],
  prepare: (
    snapshot: Database,
    plan: AssessmentReadPreparationPlan,
  ) => Promise<Prepared>,
  readSourceScope?: ReadSourceScope,
): Promise<AssessmentReadPreparation<Prepared>> {
  const remaining = new Set(ids);
  const components: {
    plan: AssessmentReadPreparationPlan;
    prepared: Prepared;
  }[] = [];
  const failures = new Map<string, unknown>();
  let budget = PREPARATION_LIMIT;
  for (const seed of remaining) {
    if (budget === 0) break;
    let claimed = [seed];
    try {
      const component = await prepareAssessmentReadComponent(
        db,
        seed,
        budget,
        async (snapshot, plan) => {
          claimed = plan.stage.assessmentIds.filter((id) => remaining.has(id));
          for (const id of claimed) remaining.delete(id);
          // Failed preparation still spent work; independent components share
          // one page budget rather than each opening another twenty-item wave.
          budget -= plan.idsToPrepare.length;
          return prepare(snapshot, plan);
        },
        readSourceScope,
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
  return { components, failures, retained: [...remaining] };
}

/** Canonical preparation owns facts; this owner only assembles their staged publication. */
export async function prepareCanonicalAssessmentReadPublication(
  db: Database,
  ids: readonly string[],
  readSourceScope: ReadSourceScope,
): Promise<AssessmentReadPreparation<AssessmentReadStageWrite>> {
  return prepareAssessmentReadPublication(
    db,
    ids,
    async (snapshot, plan): Promise<AssessmentReadStageWrite> => {
      const openIds = await readOpenAssessmentReadIds(
        snapshot,
        plan.idsToPrepare,
      );
      const admitted = await prepareSuggestionAdmission(snapshot, openIds);
      const open = new Set(openIds);
      const results = plan.idsToPrepare.map((assessmentId) => {
        const groupKey = plan.currentGroups.get(assessmentId);
        if (!groupKey)
          throw new Error(
            "Assessment publication has no canonical competitor group",
          );
        const dependencies = admitted.dependencies.get(assessmentId);
        // A closed record may publish empty and release its old memberships.
        // An unobserved open record must retain its last publication instead.
        // Present observations still require complete declared source capture.
        if (open.has(assessmentId) && !dependencies)
          throw new Error(
            "Assessment canonical input observations are unavailable",
          );
        const facts = admitted.keys
          .filter((key) => key.assessmentId === assessmentId)
          .map((key) => {
            const row = admitted.rows.get(assessmentId);
            if (!row)
              throw new Error(
                "Admitted Assessment has no canonical review row",
              );
            return {
              key: { ...key, createdAt: key.createdAt.toISOString() },
              filters: suggestionKeyFacts(key),
              row,
            };
          });
        return assessmentReadResult.parse({
          assessmentId,
          groupKey,
          facts,
          memberships: admitted.memberships.get(assessmentId) ?? [],
          dependencies: open.has(assessmentId) ? dependencies : [],
        });
      });
      return {
        stage: plan.stage,
        previousStageIds: plan.previousStageIds,
        sourceScope: plan.sourceScope,
        results,
      };
    },
    readSourceScope,
  );
}

/** A mixed chunk proceeds when any component can publish; each writer fences its own scope. */
export function assessmentReadPublicationBlocked(
  prepared: AssessmentReadPreparation<AssessmentReadStageWrite>,
  ids: readonly string[],
): SQL {
  const held = new Set(ids);
  const components = prepared.components.filter(({ plan }) =>
    plan.stage.assessmentIds.some((id) => held.has(id)),
  );
  return components.length === 0
    ? sql`false`
    : sql`${sql.join(
        components.map(
          ({ prepared: component }) =>
            sql`(${assessmentReadStageBlocked(component.stage, component.sourceScope)})`,
        ),
        sql` AND `,
      )}`;
}

/** WorkItem settlement stays with the generic drain; the sink reports exact covered generations. */
export async function publishPreparedAssessmentReadPublication(
  db: Database,
  ids: readonly string[],
  prepared: AssessmentReadPreparation<AssessmentReadStageWrite>,
  publication: DerivedSinkPublication,
): Promise<DerivedSinkContinuation> {
  const held = new Set(ids);
  const retain = new Set(ids);
  const changed = new Set<string>();
  const covered = new Map<string, WorkItem>();
  for (const component of prepared.components) {
    const controllers = component.plan.stage.assessmentIds.filter((id) =>
      held.has(id),
    );
    if (controllers.length === 0) continue;
    const observed = new Map(
      component.plan.work.map((item) => [item.ref, item.ticket]),
    );
    if (
      controllers.some((id) => {
        const ticket = observed.get(id);
        return ticket === undefined || ticket !== publication.tickets.get(id);
      })
    )
      continue;
    const outcome = await writeAssessmentReadStage(
      db,
      component.prepared,
      publication,
    );
    if (outcome.kind !== "activated") continue;
    for (const id of controllers) retain.delete(id);
    for (const id of outcome.changed) changed.add(id);
    const applied = new Set(component.prepared.stage.tickets.map(ticketKey));
    for (const item of component.plan.work)
      if (!held.has(item.ref) && applied.has(ticketKey(item)))
        covered.set(ticketKey(item), item);
  }
  return {
    changed: [...changed],
    retain: [...retain],
    covered: [...covered.values()],
  };
}
