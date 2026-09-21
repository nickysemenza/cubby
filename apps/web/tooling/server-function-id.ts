export interface ServerFunctionIdentity {
  filename: string;
  functionName: string;
}

function stableSourcePath(filename: string): string {
  const normalized = filename
    .replaceAll("\\", "/")
    .split(/[?#]/u, 1)[0]
    ?.replace(/^\.\//u, "");
  if (!normalized) return "unknown";

  const sourceMarker = normalized.lastIndexOf("/src/");
  const sourceRelative =
    sourceMarker === -1
      ? normalized.replace(/^src\//u, "")
      : normalized.slice(sourceMarker + "/src/".length);

  return sourceRelative
    .replace(/\.[cm]?[jt]sx?$/u, "")
    .replace(/\.functions$/u, "");
}

function readableSlug(value: string): string {
  return value
    .replace(/([a-z\d])([A-Z])/gu, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/gu, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z\d]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/**
 * Give production server-function URLs a stable, human-readable identity.
 *
 * TanStack passes a source-root-relative filename during a production build,
 * but accepting absolute and Windows paths here keeps the identity reproducible
 * across local worktrees and CI. The registry is intentionally scoped to one
 * generator instance (one Vite build): semantic normalization collisions fail
 * the build instead of falling back to TanStack's discovery-order `_1` suffix.
 */
export function createServerFunctionIdGenerator() {
  const identityById = new Map<string, string>();

  return ({ filename, functionName }: ServerFunctionIdentity): string => {
    const sourcePath = stableSourcePath(filename);
    const semanticFunctionName = functionName
      .replace(/_createServerFn_handler(?=_\d+$|$)/u, "")
      .replace(/Transport(?=_\d+$|$)/u, "");
    const functionId =
      sourcePath === "server-functions/start-operation-dispatch" &&
      semanticFunctionName === "dispatchStartOperationServerFunction"
        ? "dispatch"
        : readableSlug(`${sourcePath}-${semanticFunctionName}`);
    const identity = `${sourcePath}--${functionName}`;
    const existingIdentity = identityById.get(functionId);

    if (existingIdentity !== undefined && existingIdentity !== identity) {
      throw new Error(
        `Server function id collision for "${functionId}": ` +
          `"${existingIdentity}" and "${identity}"`,
      );
    }

    identityById.set(functionId, identity);
    return functionId || "server-function";
  };
}
