/** Background coverage follows changed runtime surfaces; prose alone never bills a model. */
export function classifyTesterArmyChanges(files: readonly string[]) {
  const code = files.filter((file) => !/\.(?:md|mdx|markdown)$/iu.test(file));
  const shared = code.some((file) =>
    /^(?:packages\/|cubby-ffi\/|recipebridge\/|scripts\/|\.github\/|[^/]+$)/u.test(
      file,
    ),
  );
  const backend = code.some((file) =>
    /^apps\/web\/src\/(?:server\/|contracts\/|routes\/api\/)/u.test(file),
  );
  return {
    web: code.length > 0,
    ios:
      shared || backend || code.some((file) => file.startsWith("apps/apple/")),
    imports:
      shared ||
      backend ||
      code.some((file) =>
        /^apps\/web\/(?:src\/(?:server\/|.*(?:import|vendor|run))|tooling\/(?:tester-army\/|scenarios\/tester-army)|tests\/tester-army\/)/u.test(
          file,
        ),
      ),
  };
}
