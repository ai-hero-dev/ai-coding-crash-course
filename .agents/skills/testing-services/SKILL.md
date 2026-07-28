---
name: testing-services
description: Writing tests against the database — mock `~/db`, build a test database, seed it. Use when adding or changing a test under `app/services` or `app/lib`, or when a test writes to `data.db` instead of an in-memory database.
---

# Testing Services

Services import the shared `db` singleton rather than receiving a handle, so a test substitutes the database by **mocking the module**, not by passing an argument.

## The mock

Mock `~/db` with a **getter**, and import the module under test **after** the mock:

```ts
import { createTestDb, seedBaseData } from "~/test/setup";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import { getCourseById } from "~/services/courseService";

beforeEach(() => {
  testDb = createTestDb();
});
```

Two details carry the whole pattern, and both fail silently when missed:

- **The getter.** `beforeEach` rebinds `testDb` to a fresh database on every test. A plain `{ db: testDb }` captures the value once at mock time — every test after the first runs against a stale, closed database.
- **The import order.** `vi.mock` is hoisted, but a static import written *above* it still reads more naturally to a human and is the common edit. Move that import above the mock and the service captures the real `data.db` — the tests pass, and they pass against your development data.

If a test run leaves rows in `data.db`, one of those two is wrong.

## The test database

`app/test/setup.ts` exports two helpers:

- `createTestDb()` — a fresh in-memory SQLite database with the real migrations from `drizzle/` applied, so test and production schemas cannot drift. Call it in `beforeEach`; each call is isolated.
- `seedBaseData(testDb)` — inserts a student, an instructor, a category, and a published course, returning `{ user, instructor, category, course }` for assertions. Start here rather than hand-rolling rows, and insert only what your case adds on top.

Schema changes reach tests through `drizzle/`, so a test failing on a missing column means the migration has not been generated — see the `database-migrations` skill.

## Running them

```bash
npx vitest run app/services/courseService.test.ts              # one file
npx vitest run app/services/courseService.test.ts -t "published" # one test
```

`globals: true` and `vite-tsconfig-paths` are configured, so `describe`/`it`/`expect` need no import and `~/*` resolves.

Done when the new tests pass, the full `npm test` run passes, and `data.db` is unchanged.
