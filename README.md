<div align="center">
<a href="https://www.aihero.dev/cohorts/ai-coding-for-real-engineers-with-claude-code-2026-04">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://res.cloudinary.com/total-typescript/image/upload/v1778752130/github-project-header-june-dark_2x.png" />
    <source media="(prefers-color-scheme: light)" srcset="https://res.cloudinary.com/total-typescript/image/upload/v1778752130/github-project-header-june-light_2x.png" />
    <img src="https://res.cloudinary.com/total-typescript/image/upload/v1778752130/github-project-header-june-light_2x.png" width="421" height="102" />
    </picture>
</a>
</div>
<br/>

> The exercise repo for [AI Coding for Real Engineers with Claude Code](https://www.aihero.dev/cohorts/ai-coding-for-real-engineers-with-claude-code-2026-04) — a 2-week learning cohort starting March 30, 2026.

This is a full-stack course platform (think a mini Udemy) built with React Router, TypeScript, SQLite, and Drizzle ORM. Throughout the cohort, you'll use Claude Code to explore, extend, and refactor this codebase — learning real engineering workflows for AI-assisted development along the way.

## Prerequisites

- [Node.js](https://nodejs.org/) v22+ (ships with npm v10+)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- A Claude Pro or Max subscription

## Getting Started

```bash
# Install dependencies
npm install

# Run database migrations and seed data
npm run db:migrate
npm run db:seed

# Start the dev server
npm run dev
```

The app will be running at `http://localhost:5173`.

## Scripts

| Command                     | Description                            |
| --------------------------- | -------------------------------------- |
| `npm run dev`                  | Start the development server           |
| `npm run build`                | Build for production                   |
| `npm run test`                 | Run tests with Vitest                  |
| `npm run test:watch`           | Run tests in watch mode                |
| `npm run typecheck`            | Type-check the project                 |
| `npm run db:migrate`           | Run database migrations                |
| `npm run db:seed`              | Seed the database                      |
| `npm run reset <commit>`       | Reset your repo to a lesson checkpoint |
| `npm run cherry-pick <commit>` | Cherry-pick a lesson's solution        |

## Course Structure

The cohort is split across 6 days of content:

1. **Before We Start** — Repo setup, playground walkthrough, model recommendations
2. **Getting to Know Claude Code** — Sessions, prompting, IDE integration, permissions
3. **Day 1: Fundamentals** — LLM constraints, subagents, codebase exploration, building features
4. **Day 2: Steering** — Agent files (CLAUDE.md), skills, memory, custom workflows
5. **Day 3: Planning** — Writing PRDs, multi-phase plans, tracer bullet development
6. **Day 4: Feedback Loops** — Test-driven development, red-green-refactor with AI
7. **Day 5: Ralph** — Agent automation, loops, background tasks
8. **Day 6: Human in the Loop** — Kanban workflows, research, prototyping, architecture improvement

## Navigating Lessons

Each lesson that involves code has a starting commit and solution commits. To jump to any point:

```bash
# Reset to a lesson's starting point
npm run reset 03.04.01

# Example: reset to the start of "Build a Feature"
npm run reset main

# Cherry-pick a solution if you want to skip ahead
npm run cherry-pick 03.04.01
```

## Tech Stack

- **Framework:** [React Router](https://reactrouter.com/) v7 with SSR
- **Language:** TypeScript 5.9
- **Database:** SQLite via [Drizzle ORM](https://orm.drizzle.team/)
- **Styling:** Tailwind CSS 4 + [shadcn/ui](https://ui.shadcn.com/)
- **Testing:** [Vitest](https://vitest.dev/)
- **Build:** [Vite](https://vite.dev/) 7
- **Real-time:** [Ably](https://ably.com/) for live presence

## License

This repository is for enrolled students of the [AI Coding for Real Engineers](https://www.aihero.dev/cohorts/ai-coding-for-real-engineers-with-claude-code-2026-04) cohort. All rights reserved.
