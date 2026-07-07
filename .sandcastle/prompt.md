# INPUTS

Here is a PRD for the feature you need to build:

<prd>

!`cat {{ PRD_LOCATION }}`

</prd>

And here is the multi-phase plan for it:

<plan>

!`cat {{ PLAN_LOCATION }}`

</plan>

Each phase should be considered a single task.

If there are no more tasks to complete, output <promise>NO MORE TASKS</promise>.

# EXPLORATION

Explore the repo.

# IMPLEMENTATION

Complete the task.

# FEEDBACK LOOPS

Before committing, run the feedback loops:

- `npm run test` to run the tests
- `npm run typecheck` to run the type checker

# COMMIT

Make a git commit. The commit message must:

1. Include key decisions made
2. Include files changed
3. Blockers or notes for next iteration

# FINAL RULES

ONLY WORK ON A SINGLE TASK. If you receive a multi-phase plan, only work on a single phase of that plan.
