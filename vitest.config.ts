import { configDefaults, defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    // Agent worktrees live under .claude/ and hold copies of every test.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
