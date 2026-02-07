// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot);

config.watchFolders = [monorepoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

// Required for @better-auth/expo subpath exports (e.g. /client)
config.resolver.unstable_enablePackageExports = true;

// Force single copies of React packages to prevent duplicate-instance hook errors.
// In a pnpm monorepo Metro can resolve react from different filesystem paths
// (project vs root node_modules), creating two React instances in the bundle.
const singletonPackages = ["react", "react-dom", "react-native"];
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const topLevel = moduleName.split("/")[0];
  if (singletonPackages.includes(topLevel)) {
    try {
      const filePath = require.resolve(moduleName, {
        paths: [path.resolve(projectRoot, "node_modules")],
      });
      return { type: "sourceFile", filePath };
    } catch {
      // Fall through
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
