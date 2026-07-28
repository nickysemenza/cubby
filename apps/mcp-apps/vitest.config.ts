import { defineConfig } from "vite";

export default defineConfig({
  test: {
    // The apps are DOM code; origin.unit.test.ts parses documents.
    environment: "jsdom",
    include: ["src/**/*.unit.test.ts"],
  },
});
