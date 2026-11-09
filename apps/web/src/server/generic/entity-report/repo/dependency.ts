import type { ActorContext } from "@cubby/schemas/context";
import type {
  EntityReportOut,
  ReportBlock,
  EntityReportInput,
} from "@cubby/schemas/entity-report";

import type { Database } from "~/server/db";
import type { RecipeCostingService } from "~/server/domains/recipe/repo/recipe-costing";
import type { AvailabilityService } from "~/server/domains/recipe/service/availability.service";

import type { ReportViewer } from "./records";

/** Request-scoped services a report builder may read. */
export interface ReportServices {
  availability: AvailabilityService;
  recipeCosting: RecipeCostingService;
}

export interface ReportRequest {
  db: Database;
  id: string;
  slots: readonly EntityReportInput["slot"][];
  cursor?: string;
  viewer: ReportViewer;
  actor: ActorContext;
  services?: ReportServices;
}

/** Tokens own their result type; dependencies may read other declared tokens. */
export interface ReportDependency<T> {
  load: (execution: ReportExecution) => Promise<T>;
}

export function reportDependency<T>(
  load: ReportDependency<T>["load"],
): ReportDependency<T> {
  return { load };
}

/** A memo belongs to one request, including its actor, viewer, cursor and record. */
export class ReportExecution {
  private readonly results = new Map<object, Promise<unknown>>();

  constructor(readonly request: ReportRequest) {}

  read<T>(dependency: ReportDependency<T>): Promise<T> {
    let result = this.results.get(dependency);
    if (!result) {
      result = Promise.resolve().then(() => dependency.load(this));
      this.results.set(dependency, result);
    }
    // SAFETY: only this token's typed loader writes the result under its identity.
    return result as Promise<T>;
  }
}

export const identityBuilder = <T>(
  identity: ReportDependency<T>,
  build: (db: Database, id: T) => Promise<ReportBlock[]>,
) =>
  reportDependency(async (execution): Promise<EntityReportOut> => ({
    blocks: await build(execution.request.db, await execution.read(identity)),
  }));

type ReportBuilder = (
  db: Database,
  code: string,
  viewer: ReportViewer,
  actor: ActorContext,
  cursor?: string,
  services?: ReportServices,
) => Promise<EntityReportOut["blocks"] | EntityReportOut>;

export const reportBuilder = (build: ReportBuilder) =>
  reportDependency(async ({ request }): Promise<EntityReportOut> => {
    const report = await build(
      request.db,
      request.id,
      request.viewer,
      request.actor,
      request.cursor,
      request.services,
    );
    return Array.isArray(report) ? { blocks: report } : report;
  });
