import type { ActorContext } from "@cubby/schemas/context";
import type { EntityReportInput } from "@cubby/schemas/entity-report";

import type { Database } from "~/server/db";
import type { RequestServices } from "~/server/request-services";

import type { ReportViewer } from "./records";

export interface ReportRequest {
  db: Database;
  id: string;
  slots: readonly EntityReportInput["slot"][];
  cursor?: string;
  viewer: ReportViewer;
  actor: ActorContext;
  services?: RequestServices["services"];
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
