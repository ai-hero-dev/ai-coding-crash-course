<div align="center">
<a href="https://www.aihero.dev/ai-coding-crash-course">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://res.cloudinary.com/total-typescript/image/upload/v1786022423/github-project-header-dark_2x.png" />
    <source media="(prefers-color-scheme: light)" srcset="https://res.cloudinary.com/total-typescript/image/upload/v1786022424/github-project-header-light_2x.png" />
    <img src="https://res.cloudinary.com/total-typescript/image/upload/v1786022424/github-project-header-light_2x.png" width="421" height="102" />
    </picture>
</a>
</div>
<br/>


> The exercise repo for the [AI Coding Crash Course](https://www.aihero.dev/ai-coding-crash-course) — a self-paced course from Matt Pocock on AI-assisted engineering with Claude Code.

This is a full-stack course platform (think a mini Udemy) built with React Router, TypeScript, SQLite, and Drizzle ORM. Throughout the course, you'll use Claude Code to explore, extend, and refactor this codebase — learning real engineering workflows for AI-assisted development along the way.

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
| `npm run reset <slug>`         | Reset your repo to a lesson checkpoint |
| `npm run cherry-pick <slug>`   | Cherry-pick a lesson's solution        |

## Course Structure

The crash course works through this codebase in six sections:

1. **Before We Start** — Repo setup, how to run the exercises, database migrations, and making your first change.
2. **Concepts** — The core mental models for AI-assisted coding — reference material, no code changes.
3. **Getting to Know Claude Code** — Sessions, context, permissions, IDE integration, and subagents.
4. **Fundamentals** — Exploring the codebase, building features, and using skills (`grill-me`, `handoff`) to drive real work.
5. **Steering** — Steering the agent with `AGENTS.md`/`CLAUDE.md`, custom skills, and pruning context.
6. **Planning** — Writing a spec, turning it into multi-phase tickets, and implementing it phase by phase.

## Navigating Lessons

Each lesson that involves code has a checkpoint commit on the `live-run-through` branch, addressed by its **slug**. To jump to any point:

```bash
# Reset to a lesson's checkpoint
npm run reset try-the-cli

# Cherry-pick a lesson's solution if you want to skip ahead
npm run cherry-pick course-star-ratings
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

This repository is for students of the [AI Coding Crash Course](https://www.aihero.dev/ai-coding-crash-course). All rights reserved.
