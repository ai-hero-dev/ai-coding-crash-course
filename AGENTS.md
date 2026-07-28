Requests flow **route → service → Drizzle**. Routes own HTTP concerns and rendering; services own data access and use the shared `db` instance directly rather than receiving a handle.

## When something breaks

| Symptom                                         | Cause                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 401 "Select a user from the DevUI panel"        | No user in the session — switch users and country in the floating panel (`app/components/dev-ui.tsx`). |
| `tsc` reports every `./+types/*` import missing | Typegen has not run. Use `npm run typecheck`, which runs `react-router typegen` first.                 |
| A test run leaves rows in `data.db`             | The `~/db` mock is wrong — see the `testing-services` skill.                                           |
