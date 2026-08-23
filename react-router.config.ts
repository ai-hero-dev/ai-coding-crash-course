import type { Config } from "@react-router/dev/config";

export default {
  // Config options...
  // Server-side render by default, to enable SPA mode set this to `false`
  ssr: true,

  // Explicitly opt out of every v8 future flag for now. Leaving these
  // unset makes react-router print a "Future Flag Warning" for each one on
  // every `npm run dev` / `npm run build` — accurate, but confusing noise
  // for anyone new to the repo. Setting them to `false` keeps today's (v7)
  // behavior and silences the warnings; flip individual flags to `true`
  // when we're ready to adopt that v8 behavior ahead of the real upgrade.
  future: {
    v8_middleware: false,
    v8_splitRouteModules: false,
    v8_viteEnvironmentApi: false,
    v8_passThroughRequests: false,
    v8_trailingSlashAwareDataRequests: false,
  },
} satisfies Config;
