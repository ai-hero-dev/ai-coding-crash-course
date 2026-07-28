---
name: adding-a-route
description: Adding a page — create the route module, register it in the route table, wire the loader. Use when adding or removing a page, URL, or route, or when a new route renders a 404.
---

# Adding a Route

Routing is **config-based, not file-based**. Creating a file under `app/routes/` does nothing on its own — a new page is two edits, and skipping the second is why a new route 404s.

## Steps

1. **Create the module** in `app/routes/`. Name it with dots for path segments and `$` for params: `courses.$slug.lessons.$lessonId.tsx`. The filename is convention only; the route table is what binds it to a URL.

2. **Register it** in `app/routes.ts` — the route table. Use `route("path", "routes/file.tsx")`, and nest it inside the `layout("routes/layout.app.tsx", [...])` block, where most pages sit. Only pages that deliberately shed the app chrome go outside it.

3. **Import the generated types** — `import type { Route } from "./+types/<route-file-name>"`, matching the module's own filename. These are generated from the route table, so they exist only after the route is registered in step 2.

4. **Write the loader and action.** Loaders and actions own HTTP concerns — redirects, status codes, `data()` responses — and call services for data. Keep queries out of the route: the flow is route → service → Drizzle.

5. **Authorise the loader and the action separately.** A guard in the loader does not protect the action on the same route. Mutating actions call their own `require*` guard from `~/lib/access.server` — see that module's header for which guard fits.

6. **Typecheck** — `npm run typecheck`.

Done when the page renders at its URL, the loader and any action each carry their own guard, and the typecheck passes.

## `./+types/*` cannot be found

`npm run typecheck` runs `react-router typegen` before `tsc`, regenerating the per-route types under `.react-router/types`. Running `tsc` alone reports every `./+types/*` import as missing — that error means typegen has not run, not that the import is wrong.
