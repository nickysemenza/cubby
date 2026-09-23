interface Closeable {
  close(): Promise<void>;
}

export interface E2EWorkerResources {
  proxy?: Closeable;
  harness?: Closeable;
  database?: Closeable;
  objectStorage?: Closeable;
}

/** Close every acquired resource even when an earlier close fails. */
export async function closeE2EWorkerResources(
  resources: E2EWorkerResources,
): Promise<void> {
  const errors: unknown[] = [];
  for (const [label, resource] of [
    ["proxy", resources.proxy],
    ["harness", resources.harness],
    ["database", resources.database],
    ["object storage", resources.objectStorage],
  ] as const) {
    if (!resource) continue;
    try {
      await resource.close();
    } catch (error) {
      errors.push(new Error(`Failed to close E2E ${label}`, { cause: error }));
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "E2E worker cleanup failed");
  }
}
