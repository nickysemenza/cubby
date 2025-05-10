/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import { NextConfig } from "next";
import CopyPlugin from "copy-webpack-plugin";
import "./src/env.js";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [new URL("https://foobucket.nicky.fun/**")],
  },

  webpack(config, { isServer, dev }) {
    // cf github.com/vercel/next.js/issues/29362#issuecomment-1973553746
    https: if (!dev && isServer) {
      const patterns = [];

      const destinations = [
        "../static/wasm/[name][ext]", // -> .next/static/wasm
        "./static/wasm/[name][ext]", // -> .next/server/static/wasm
        ".", // -> .next/server/chunks (for some reason this is necessary)
      ];
      for (const dest of destinations) {
        patterns.push({
          context: ".next/server/chunks",
          from: ".",
          to: dest,
          filter: (resourcePath: string) => resourcePath.endsWith(".wasm"),
          noErrorOnMissing: true,
        });
      }

      config.plugins.push(new CopyPlugin({ patterns }));
    }

    config.module.rules.push({
      test: /\.wasm$/,
      type: "webassembly/async",
    });
    config.experiments = {
      asyncWebAssembly: true,
      topLevelAwait: true,
      layers: true,
    };
    return config;
  },
};

export default nextConfig;
