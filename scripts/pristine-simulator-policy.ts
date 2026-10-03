const runnerApp = "com.callstack.agentdevice.runner";
const runnerTests = `${runnerApp}.uitests`;
const runnerApps = new Set([
  runnerApp,
  runnerTests,
  `${runnerTests}.xctrunner`,
]);

export function assertPristineSimulatorApps(
  ids: string[],
  runnerPrepared: boolean,
) {
  if (
    ids.some(
      (id) =>
        !id.startsWith("com.apple.") && !(runnerPrepared && runnerApps.has(id)),
    )
  )
    throw new Error(
      "Refusing to cache a simulator with applications outside the seed policy",
    );
}

export function pristineRunnerEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  // The AI lane has credentials in its environment. Seed only public apps,
  // with tool locations and fixed runner identity rather than inherited env.
  return {
    PATH: env.PATH,
    HOME: env.HOME,
    TMPDIR: env.TMPDIR,
    DEVELOPER_DIR: env.DEVELOPER_DIR,
    AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID: runnerApp,
    AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID: runnerTests,
    E2E_TELEMETRY_DISABLED: "1",
  };
}
