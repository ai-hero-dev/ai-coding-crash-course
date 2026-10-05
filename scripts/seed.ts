import Database from "better-sqlite3";
import { and, eq, gte, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import path from "path";
import { fileURLToPath } from "url";
import * as schema from "../app/db/schema";
import {
  UserRole,
  CourseStatus,
  LessonProgressStatus,
  QuestionType,
  TeamMemberRole,
} from "../app/db/schema";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsFolder = path.resolve(__dirname, "../drizzle");

// Set by seed(), so the analytics tests can seed an in-memory database.
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

// ─── Helpers ───

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// Seconds after a `daysAgo` timestamp, so a watch session's events land in
// order, ten seconds apart, the way the player sends them.
function secondsAfter(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

// Deterministic PRNG (mulberry32), so every seed run plants the same data and
// the drop-off cliffs documented below stay where they are.
function createRandom(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Reset by seed(), so every run in a process plants the same data.
let random = createRandom(42);

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// ─── Seed Data ───

type SeedLesson = {
  title: string;
  duration: number;
  videoUrl?: string;
  githubRepoUrl?: string;
  content?: string;
};

type SeedModule = { title: string; lessons: SeedLesson[] };

// Inserts a course's modules and lessons, and returns the lesson ids in course
// order (module position, then lesson position).
function insertCourseContent(
  courseId: number,
  courseModules: SeedModule[],
  createdDaysAgo: number
): number[] {
  const lessonIds: number[] = [];

  for (let mi = 0; mi < courseModules.length; mi++) {
    const modData = courseModules[mi];
    const [mod] = db
      .insert(schema.modules)
      .values({
        courseId,
        title: modData.title,
        position: mi + 1,
        createdAt: daysAgo(createdDaysAgo - mi),
      })
      .returning()
      .all();

    for (let li = 0; li < modData.lessons.length; li++) {
      const lessonData = modData.lessons[li];
      const [lesson] = db
        .insert(schema.lessons)
        .values({
          moduleId: mod.id,
          title: lessonData.title,
          content: lessonData.content ?? null,
          videoUrl: lessonData.videoUrl ?? null,
          githubRepoUrl: lessonData.githubRepoUrl ?? null,
          position: li + 1,
          durationMinutes: lessonData.duration,
          createdAt: daysAgo(createdDaysAgo - mi),
        })
        .returning()
        .all();
      lessonIds.push(lesson.id);
    }
  }

  return lessonIds;
}

/**
 * Drops every table in `target`, migrates it, and fills it with the seed
 * data. `npm run db:seed` calls it on data.db.
 */
export async function seed(target: Database.Database) {
  sqlite = target;
  sqlite.pragma("foreign_keys = ON");
  db = drizzle(sqlite, { schema });
  random = createRandom(42);

  console.log("Seeding database...");

  // Drop and recreate tables for a clean seed
  sqlite.exec(`
    DROP TABLE IF EXISTS comments;
    DROP TABLE IF EXISTS course_ratings;
    DROP TABLE IF EXISTS video_watch_events;
    DROP TABLE IF EXISTS quiz_answers;
    DROP TABLE IF EXISTS quiz_attempts;
    DROP TABLE IF EXISTS quiz_options;
    DROP TABLE IF EXISTS quiz_questions;
    DROP TABLE IF EXISTS quizzes;
    DROP TABLE IF EXISTS lesson_progress;
    DROP TABLE IF EXISTS coupons;
    DROP TABLE IF EXISTS team_members;
    DROP TABLE IF EXISTS teams;
    DROP TABLE IF EXISTS purchases;
    DROP TABLE IF EXISTS enrollments;
    DROP TABLE IF EXISTS lessons;
    DROP TABLE IF EXISTS modules;
    DROP TABLE IF EXISTS courses;
    DROP TABLE IF EXISTS categories;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS __drizzle_migrations;
  `);

  // Create tables using the same Drizzle migrations as the live database
  migrate(db, { migrationsFolder });

  console.log("Tables created.");

  // ─── Users ───
  // 1 admin, 3 instructors (Priya Natarajan owns no courses, so the analytics
  // empty state is reachable), and the students below. More students are
  // appended in "Audience at scale" further down. Append, never insert, so the
  // `students[n]` references in this file keep pointing at the same people.

  const [admin] = db
    .insert(schema.users)
    .values({
      name: "Alex Rivera",
      email: "alex.rivera@ralph.dev",
      role: UserRole.Admin,
      avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=alex",
      createdAt: daysAgo(400),
    })
    .returning()
    .all();

  const [instructor1] = db
    .insert(schema.users)
    .values({
      name: "Sarah Chen",
      email: "sarah.chen@ralph.dev",
      role: UserRole.Instructor,
      avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=sarah",
      bio: "Senior TypeScript engineer with 10 years of experience building large-scale web applications. Previously at Stripe and Vercel. Passionate about type safety and developer tooling.",
      createdAt: daysAgo(390),
    })
    .returning()
    .all();

  const [instructor2] = db
    .insert(schema.users)
    .values({
      name: "Marcus Johnson",
      email: "marcus.johnson@ralph.dev",
      role: UserRole.Instructor,
      avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=marcus",
      bio: "Full-stack developer and API architect specializing in Node.js and cloud infrastructure. Has built and scaled APIs serving millions of requests daily. Conference speaker and open-source contributor.",
      createdAt: daysAgo(370),
    })
    .returning()
    .all();

  db.insert(schema.users)
    .values({
      name: "Priya Natarajan",
      email: "priya.natarajan@ralph.dev",
      role: UserRole.Instructor,
      avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=priya",
      bio: "Data engineer turned educator. Her first course is still on the drawing board.",
      createdAt: daysAgo(20),
    })
    .run();

  const students = db
    .insert(schema.users)
    .values([
      {
        name: "Emma Wilson",
        email: "emma.wilson@student.dev",
        role: UserRole.Student,
        avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=emma",
        createdAt: daysAgo(60),
      },
      {
        name: "James Park",
        email: "james.park@student.dev",
        role: UserRole.Student,
        avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=james",
        createdAt: daysAgo(55),
      },
      {
        name: "Olivia Martinez",
        email: "olivia.martinez@student.dev",
        role: UserRole.Student,
        avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=olivia",
        createdAt: daysAgo(45),
      },
      {
        name: "Liam Thompson",
        email: "liam.thompson@student.dev",
        role: UserRole.Student,
        avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=liam",
        createdAt: daysAgo(30),
      },
      {
        name: "Sophia Davis",
        email: "sophia.davis@student.dev",
        role: UserRole.Student,
        avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=sophia",
        createdAt: daysAgo(20),
      },
    ])
    .returning()
    .all();

  const [bossy] = db
    .insert(schema.users)
    .values({
      name: "Bossy McBossface",
      email: "bossy.mcbossface@student.dev",
      role: UserRole.Student,
      avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=bossy",
      createdAt: daysAgo(40),
    })
    .returning()
    .all();

  // ─── Categories ───

  const categoriesData = db
    .insert(schema.categories)
    .values([
      { name: "Programming", slug: "programming" },
      { name: "Design", slug: "design" },
      { name: "Data Science", slug: "data-science" },
      { name: "DevOps", slug: "devops" },
      { name: "Marketing", slug: "marketing" },
    ])
    .returning()
    .all();

  const catBySlug = Object.fromEntries(categoriesData.map((c) => [c.slug, c]));

  console.log(`Created ${categoriesData.length} categories.`);

  // ─── Course 1: Introduction to TypeScript (Sarah Chen) ───

  const [course1] = db
    .insert(schema.courses)
    .values({
      title: "Introduction to TypeScript",
      slug: "introduction-to-typescript",
      description:
        "Master TypeScript from the ground up. Learn type annotations, interfaces, generics, and advanced patterns that will make your JavaScript code safer and more maintainable. Includes hands-on projects and real-world examples.",
      salesCopy: `## Why TypeScript?

If you've been writing JavaScript and wondering why your code breaks in production with cryptic "undefined is not a function" errors, TypeScript is the answer you've been looking for.

TypeScript adds a powerful type system on top of JavaScript that catches bugs before they ever reach your users. It's not just about finding errors — it's about writing code with confidence, knowing that your editor understands your code as well as you do.

## What You'll Learn

This course takes you from zero TypeScript knowledge to confidently using advanced patterns in real projects. We start with the basics — type annotations, interfaces, and simple generics — and build up to discriminated unions, mapped types, conditional types, and template literal types.

Every concept is taught through practical examples. You won't just learn what a generic is — you'll learn when and why to use one, and how to constrain them for maximum type safety.

### Course Highlights

- **19 lessons** across 5 modules, from setup to advanced patterns
- **Hands-on quizzes** to test your understanding as you go
- **Real-world React examples** showing TypeScript in production code
- **Error handling patterns** using Result types and discriminated unions

## Who Is This Course For?

This course is perfect for JavaScript developers who want to level up their code quality. Whether you're working on a personal project or a large team codebase, TypeScript will make your development experience faster, safer, and more enjoyable.

No prior TypeScript experience required — just a solid understanding of JavaScript fundamentals.

## What Makes This Course Different

Unlike courses that just show you syntax, this course focuses on *thinking in types*. You'll learn to design your types first and let them guide your implementation, catching entire categories of bugs at compile time instead of runtime.

By the end of this course, you'll understand why TypeScript has become the default choice for serious JavaScript development.`,
      instructorId: instructor1.id,
      categoryId: catBySlug["programming"].id,
      status: CourseStatus.Published,
      coverImageUrl: "/images/course-typescript.svg",
      price: 4999,
      createdAt: daysAgo(370),
      updatedAt: daysAgo(10),
    })
    .returning()
    .all();

  // Course 1 modules and lessons
  const c1Modules: SeedModule[] = [
    {
      title: "Getting Started with TypeScript",
      lessons: [
        {
          title: "What is TypeScript?",
          duration: 8,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          githubRepoUrl:
            "https://github.com/total-typescript/ts-intro-what-is-ts",
          content: `## What is TypeScript?

TypeScript is a typed superset of JavaScript that compiles to plain JavaScript. It adds optional static typing and class-based object-oriented programming to the language.

### Why TypeScript?

- Catch errors at compile time instead of runtime
- Better IDE support with autocompletion
- Easier to refactor large codebases
- Self-documenting code through types`,
        },
        {
          title: "Installing and Configuring TypeScript",
          duration: 12,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Setting Up TypeScript

Let's get TypeScript installed and configured in your development environment.

### Installation

\`\`\`bash
npm install -g typescript
tsc --version
\`\`\`

### tsconfig.json

The \`tsconfig.json\` file configures the TypeScript compiler options for your project.`,
        },
        {
          title: "Your First TypeScript Program",
          duration: 15,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          githubRepoUrl:
            "https://github.com/total-typescript/ts-intro-first-program",
          content: `## Hello, TypeScript!

Let's write our first TypeScript program and see the compilation process in action.

\`\`\`typescript
function greet(name: string): string {
  return \\\`Hello, \\\${name}!\\\`;
}

console.log(greet('World'));
\`\`\``,
        },
      ],
    },
    {
      title: "Type System Fundamentals",
      lessons: [
        {
          title: "Primitive Types",
          duration: 10,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Primitive Types

TypeScript supports the same primitive types as JavaScript, plus a few extras.

- \`string\` — text values
- \`number\` — numeric values (integer and float)
- \`boolean\` — true/false
- \`null\` and \`undefined\`
- \`symbol\` and \`bigint\``,
        },
        {
          title: "Arrays and Tuples",
          duration: 12,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Arrays and Tuples

Learn how to type arrays and fixed-length tuples in TypeScript.

\`\`\`typescript
const numbers: number[] = [1, 2, 3];
const pair: [string, number] = ['age', 25];
\`\`\``,
        },
        {
          title: "Type Aliases and Interfaces",
          duration: 18,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Type Aliases vs Interfaces

Both type aliases and interfaces let you define custom types, but they have subtle differences.

### Type Alias

\`\`\`typescript
type User = {
  name: string;
  age: number;
};
\`\`\`

### Interface

\`\`\`typescript
interface User {
  name: string;
  age: number;
}
\`\`\``,
        },
        {
          title: "Union and Intersection Types",
          duration: 14,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Union and Intersection Types

Combine types in powerful ways using unions (\`|\`) and intersections (\`&\`).

\`\`\`typescript
type StringOrNumber = string | number;
type Named = { name: string };
type Aged = { age: number };
type Person = Named & Aged;
\`\`\``,
        },
      ],
    },
    {
      title: "Functions and Generics",
      lessons: [
        {
          title: "Function Types",
          duration: 11,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Typing Functions

TypeScript lets you type function parameters, return values, and even the function itself.

\`\`\`typescript
function add(a: number, b: number): number {
  return a + b;
}

const multiply: (a: number, b: number) => number = (a, b) => a * b;
\`\`\``,
        },
        {
          title: "Generics Basics",
          duration: 20,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          githubRepoUrl:
            "https://github.com/total-typescript/ts-generics-basics",
          content: `## Introduction to Generics

Generics let you write reusable code that works with multiple types while maintaining type safety.

\`\`\`typescript
function identity<T>(value: T): T {
  return value;
}

const str = identity('hello'); // string
const num = identity(42); // number
\`\`\``,
        },
        {
          title: "Generic Constraints",
          duration: 16,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Constraining Generics

Use \`extends\` to limit what types a generic can accept.

\`\`\`typescript
function getLength<T extends { length: number }>(item: T): number {
  return item.length;
}

getLength('hello'); // OK
getLength([1, 2, 3]); // OK
// getLength(42); // Error!
\`\`\``,
        },
        {
          title: "Utility Types",
          duration: 15,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Built-in Utility Types

TypeScript provides several utility types for common type transformations.

- \`Partial<T>\` — makes all properties optional
- \`Required<T>\` — makes all properties required
- \`Pick<T, K>\` — selects specific properties
- \`Omit<T, K>\` — excludes specific properties
- \`Record<K, V>\` — creates an object type with keys K and values V`,
        },
      ],
    },
    {
      title: "Advanced Patterns",
      lessons: [
        {
          title: "Discriminated Unions",
          duration: 14,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Discriminated Unions

A pattern that combines union types with literal types to create type-safe tagged unions.

\`\`\`typescript
type Shape =
  | { kind: 'circle'; radius: number }
  | { kind: 'rectangle'; width: number; height: number };

function area(shape: Shape): number {
  switch (shape.kind) {
    case 'circle': return Math.PI * shape.radius ** 2;
    case 'rectangle': return shape.width * shape.height;
  }
}
\`\`\``,
        },
        {
          title: "Type Guards and Narrowing",
          duration: 13,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Type Guards

Type guards are expressions that narrow a type within a conditional block.

\`\`\`typescript
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function process(value: string | number) {
  if (isString(value)) {
    console.log(value.toUpperCase()); // string
  } else {
    console.log(value.toFixed(2)); // number
  }
}
\`\`\``,
        },
        {
          title: "Mapped Types",
          duration: 17,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Mapped Types

Create new types by transforming each property of an existing type.

\`\`\`typescript
type Readonly<T> = {
  readonly [K in keyof T]: T[K];
};

type Optional<T> = {
  [K in keyof T]?: T[K];
};
\`\`\``,
        },
        {
          title: "Conditional Types",
          duration: 19,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Conditional Types

Types that depend on a condition, similar to ternary expressions but at the type level.

\`\`\`typescript
type IsString<T> = T extends string ? true : false;

type A = IsString<'hello'>; // true
type B = IsString<42>; // false
\`\`\``,
        },
        {
          title: "Template Literal Types",
          duration: 10,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Template Literal Types

Construct string types using template literal syntax.

\`\`\`typescript
type Color = 'red' | 'blue' | 'green';
type CSSProperty = \\\`color-\\\${Color}\\\`;
// 'color-red' | 'color-blue' | 'color-green'
\`\`\``,
        },
      ],
    },
    {
      title: "Real-World TypeScript",
      lessons: [
        {
          title: "TypeScript with React",
          duration: 22,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          githubRepoUrl:
            "https://github.com/total-typescript/ts-react-examples",
          content: `## TypeScript + React

Learn how to use TypeScript effectively in React applications.

\`\`\`typescript
interface ButtonProps {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary';
}

function Button({ label, onClick, variant = 'primary' }: ButtonProps) {
  return <button onClick={onClick} className={variant}>{label}</button>;
}
\`\`\``,
        },
        {
          title: "Error Handling Patterns",
          duration: 14,
          videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
          content: `## Error Handling in TypeScript

Strategies for handling errors in a type-safe way.

\`\`\`typescript
type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

function divide(a: number, b: number): Result<number> {
  if (b === 0) return { ok: false, error: new Error('Division by zero') };
  return { ok: true, value: a / b };
}
\`\`\``,
        },
        {
          title: "Course Wrap-Up and Next Steps",
          duration: 8,
          content: `## Congratulations!

You've completed the Introduction to TypeScript course. Here's what we covered:

- TypeScript fundamentals and type system
- Functions, generics, and utility types
- Advanced patterns like discriminated unions and mapped types
- Real-world usage with React

### Next Steps

Practice by converting an existing JavaScript project to TypeScript. Start with strict mode enabled and work through the errors one by one.`,
        },
      ],
    },
  ];

  const course1LessonIds = insertCourseContent(course1.id, c1Modules, 370);

  console.log(
    `Created course "${course1.title}" with ${c1Modules.length} modules and ${course1LessonIds.length} lessons.`
  );

  // ─── Course 2: Building REST APIs with Node.js (Marcus Johnson) ───

  const [course2] = db
    .insert(schema.courses)
    .values({
      title: "Building REST APIs with Node.js",
      slug: "building-rest-apis-with-nodejs",
      description:
        "Learn to build production-ready REST APIs using Node.js and Express. Covers routing, middleware, authentication, database integration, error handling, testing, and deployment best practices.",
      salesCopy: `## Build APIs That Actually Work in Production

Most API tutorials teach you how to return JSON from an endpoint. This course teaches you how to build APIs that handle real traffic, real users, and real problems — the kind you'll face on the job.

From your first Express route to deploying a production-ready API, you'll learn every layer of the stack: routing, middleware, validation, authentication, database integration, testing, and deployment.

## What You'll Build

Throughout this course, you'll build a complete REST API from scratch. Not a toy project — a properly structured API with authentication, input validation, error handling, pagination, and tests.

### Topics Covered

- **Express fundamentals** — routing, middleware chains, request/response lifecycle
- **Input validation with Zod** — never trust user input, validate everything
- **Database integration** — Drizzle ORM with SQLite, CRUD operations, transactions
- **JWT authentication** — secure your endpoints with industry-standard tokens
- **Security hardening** — rate limiting, CORS, security headers with Helmet
- **Testing** — unit tests with Vitest, integration tests with Supertest
- **Deployment** — environment config, process management, CI/CD basics

## Who Should Take This Course?

This course is designed for developers who know JavaScript and want to build backend services. If you've built frontends but never created your own API, this is the perfect next step.

You should be comfortable with JavaScript basics — functions, async/await, and working with objects. No backend experience required.

## Why Node.js for APIs?

Node.js lets you use the same language on both frontend and backend. Its non-blocking I/O model handles concurrent requests efficiently, and the npm ecosystem gives you battle-tested libraries for every common backend task.

Express is the most widely-used Node.js web framework for a reason — it's minimal, flexible, and has a massive community. The patterns you learn here will transfer to any Node.js framework.

## 20 Lessons, 5 Modules, Zero Fluff

Every lesson is focused and practical. No 45-minute lectures where 40 minutes are filler. Each lesson teaches one concept, shows you how to implement it, and moves on.`,
      instructorId: instructor2.id,
      categoryId: catBySlug["programming"].id,
      status: CourseStatus.Published,
      coverImageUrl: "/images/course-nodejs.svg",
      price: 5999,
      createdAt: daysAgo(340),
      updatedAt: daysAgo(5),
    })
    .returning()
    .all();

  const c2Modules: SeedModule[] = [
    {
      title: "API Fundamentals",
      lessons: [
        {
          title: "What is a REST API?",
          duration: 10,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## REST API Fundamentals

REST (Representational State Transfer) is an architectural style for designing networked applications. RESTful APIs use HTTP methods to perform CRUD operations on resources.

### Key Principles

- Stateless communication
- Resource-based URLs
- Standard HTTP methods (GET, POST, PUT, DELETE)
- JSON as the data format`,
        },
        {
          title: "Setting Up Express",
          duration: 15,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          githubRepoUrl:
            "https://github.com/total-typescript/rest-api-express-setup",
          content: `## Express.js Setup

Express is the most popular Node.js web framework for building APIs.

\`\`\`javascript
import express from 'express';

const app = express();
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(3000, () => console.log('Server running on port 3000'));
\`\`\``,
        },
        {
          title: "HTTP Methods and Status Codes",
          duration: 12,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## HTTP Methods

- **GET** — Retrieve resources (200 OK)
- **POST** — Create resources (201 Created)
- **PUT** — Update resources (200 OK)
- **DELETE** — Remove resources (204 No Content)

### Common Status Codes

- 200 OK, 201 Created, 204 No Content
- 400 Bad Request, 401 Unauthorized, 404 Not Found
- 500 Internal Server Error`,
        },
        {
          title: "Request and Response Objects",
          duration: 14,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Working with Request & Response

Express provides rich request and response objects for handling HTTP communication.

\`\`\`javascript
app.post('/api/users', (req, res) => {
  const { name, email } = req.body;
  // ... create user
  res.status(201).json({ id: 1, name, email });
});
\`\`\``,
        },
      ],
    },
    {
      title: "Routing and Middleware",
      lessons: [
        {
          title: "Express Router",
          duration: 13,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Organizing Routes

Use Express Router to organize your API endpoints into logical groups.

\`\`\`javascript
import { Router } from 'express';

const userRouter = Router();
userRouter.get('/', getUsers);
userRouter.get('/:id', getUserById);
userRouter.post('/', createUser);

app.use('/api/users', userRouter);
\`\`\``,
        },
        {
          title: "Custom Middleware",
          duration: 16,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Middleware in Express

Middleware functions have access to the request, response, and next function in the request-response cycle.

\`\`\`javascript
function logger(req, res, next) {
  console.log(\\\`\\\${req.method} \\\${req.url}\\\`);
  next();
}

function authenticate(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
\`\`\``,
        },
        {
          title: "Error Handling Middleware",
          duration: 11,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Centralized Error Handling

Express supports error-handling middleware with four parameters.

\`\`\`javascript
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error'
  });
});
\`\`\``,
        },
        {
          title: "Validation with Zod",
          duration: 18,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Request Validation

Use Zod to validate request bodies, query parameters, and URL parameters.

\`\`\`javascript
import { z } from 'zod';

const CreateUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  age: z.number().int().positive().optional()
});

app.post('/api/users', (req, res) => {
  const result = CreateUserSchema.safeParse(req.body);
  if (!result.success) return res.status(400).json(result.error);
  // ... create user with result.data
});
\`\`\``,
        },
      ],
    },
    {
      title: "Database Integration",
      lessons: [
        {
          title: "Connecting to a Database",
          duration: 14,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Database Setup

Learn how to connect your API to a database using an ORM.

\`\`\`javascript
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';

const sqlite = new Database('app.db');
const db = drizzle(sqlite);
\`\`\``,
        },
        {
          title: "CRUD Operations",
          duration: 20,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          githubRepoUrl:
            "https://github.com/total-typescript/rest-api-crud-operations",
          content: `## Building CRUD Endpoints

Implement Create, Read, Update, Delete operations for your API resources.

\`\`\`javascript
// Create
app.post('/api/posts', async (req, res) => {
  const post = await db.insert(posts).values(req.body).returning();
  res.status(201).json(post);
});

// Read
app.get('/api/posts/:id', async (req, res) => {
  const post = await db.select().from(posts).where(eq(posts.id, req.params.id));
  if (!post) return res.status(404).json({ error: 'Not found' });
  res.json(post);
});
\`\`\``,
        },
        {
          title: "Pagination and Filtering",
          duration: 15,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Pagination

Implement cursor-based and offset-based pagination for list endpoints.

\`\`\`javascript
app.get('/api/posts', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  const results = await db.select().from(posts)
    .limit(limit).offset(offset);
  res.json({ data: results, page, limit });
});
\`\`\``,
        },
        {
          title: "Transactions",
          duration: 12,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Database Transactions

Use transactions to ensure data consistency when multiple operations must succeed or fail together.

\`\`\`javascript
await db.transaction(async (tx) => {
  const [order] = await tx.insert(orders).values({ userId, total }).returning();
  for (const item of items) {
    await tx.insert(orderItems).values({ orderId: order.id, ...item });
  }
});
\`\`\``,
        },
      ],
    },
    {
      title: "Authentication and Security",
      lessons: [
        {
          title: "JWT Authentication",
          duration: 22,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## JSON Web Tokens

Implement JWT-based authentication for your API.

\`\`\`javascript
import jwt from 'jsonwebtoken';

app.post('/api/login', async (req, res) => {
  const user = await findUser(req.body.email);
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
    expiresIn: '7d'
  });
  res.json({ token });
});
\`\`\``,
        },
        {
          title: "Rate Limiting",
          duration: 10,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Rate Limiting

Protect your API from abuse by limiting the number of requests per client.

\`\`\`javascript
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per window
});

app.use('/api/', limiter);
\`\`\``,
        },
        {
          title: "CORS and Security Headers",
          duration: 11,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## CORS Configuration

Configure Cross-Origin Resource Sharing for your API.

\`\`\`javascript
import cors from 'cors';
import helmet from 'helmet';

app.use(cors({ origin: 'https://yourapp.com' }));
app.use(helmet());
\`\`\``,
        },
      ],
    },
    {
      title: "Testing and Deployment",
      lessons: [
        {
          title: "Unit Testing API Routes",
          duration: 18,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Testing with Vitest and Supertest

Write tests for your API endpoints using Vitest and Supertest.

\`\`\`javascript
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';

describe('GET /api/users', () => {
  it('returns a list of users', async () => {
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);
  });
});
\`\`\``,
        },
        {
          title: "Integration Testing",
          duration: 16,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Integration Tests

Test complete request flows including database interactions.

\`\`\`javascript
describe('User CRUD', () => {
  it('creates and retrieves a user', async () => {
    const createRes = await request(app)
      .post('/api/users')
      .send({ name: 'Test', email: 'test@test.com' });
    expect(createRes.status).toBe(201);

    const getRes = await request(app)
      .get(\\\`/api/users/\\\${createRes.body.id}\\\`);
    expect(getRes.body.name).toBe('Test');
  });
});
\`\`\``,
        },
        {
          title: "Environment Variables and Config",
          duration: 9,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Configuration Management

Manage environment-specific settings with environment variables.

\`\`\`javascript
const config = {
  port: process.env.PORT || 3000,
  dbUrl: process.env.DATABASE_URL || 'sqlite:app.db',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret'
};
\`\`\``,
        },
        {
          title: "Deploying Your API",
          duration: 14,
          videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
          content: `## Deployment

Deploy your Node.js API to production. We'll cover various hosting options and best practices.

### Deployment Checklist

- Set NODE_ENV=production
- Use a process manager (PM2)
- Set up logging and monitoring
- Configure HTTPS
- Set up CI/CD pipeline`,
        },
        {
          title: "Course Wrap-Up",
          duration: 7,
          content: `## Congratulations!

You've completed the Building REST APIs course. You now have the skills to build, test, and deploy production-ready APIs with Node.js.

### Key Takeaways

- RESTful design principles
- Express routing and middleware
- Database integration and transactions
- Authentication and security
- Testing and deployment`,
        },
      ],
    },
  ];

  const course2LessonIds = insertCourseContent(course2.id, c2Modules, 340);

  console.log(
    `Created course "${course2.title}" with ${c2Modules.length} modules and ${course2LessonIds.length} lessons.`
  );

  // ─── Course 3: Type-Safe React Components (Sarah Chen) ───
  // Published, but nobody has bought it yet: the "zero sales" course.

  const [course3] = db
    .insert(schema.courses)
    .values({
      title: "Type-Safe React Components",
      slug: "type-safe-react-components",
      description:
        "Write React components whose props, state and events are checked by the compiler. Covers generic components, discriminated-union props, and typing hooks.",
      salesCopy: `## Stop Guessing What Your Props Are

React and TypeScript work well together, but only if you know the patterns. This short course shows you the ones that matter in real codebases.

- Generic components that infer their types from usage
- Props modelled as discriminated unions
- Hooks that return precise types`,
      instructorId: instructor1.id,
      categoryId: catBySlug["programming"].id,
      status: CourseStatus.Published,
      coverImageUrl: "/images/course-typescript.svg",
      price: 3999,
      createdAt: daysAgo(45),
      updatedAt: daysAgo(14),
    })
    .returning()
    .all();

  const course3LessonIds = insertCourseContent(
    course3.id,
    [
      {
        title: "Typing Components",
        lessons: [
          { title: "Props and Children", duration: 9 },
          { title: "Generic Components", duration: 14 },
        ],
      },
      {
        title: "Typing Hooks",
        lessons: [
          { title: "useState and useReducer", duration: 11 },
          { title: "Custom Hooks", duration: 13 },
        ],
      },
    ],
    45
  );

  console.log(
    `Created course "${course3.title}" with ${course3LessonIds.length} lessons.`
  );

  // ─── Course 4: GraphQL APIs from Scratch (Marcus Johnson) ───
  // Draft: not visible to students, no enrollments, no sales.

  const [course4] = db
    .insert(schema.courses)
    .values({
      title: "GraphQL APIs from Scratch",
      slug: "graphql-apis-from-scratch",
      description:
        "Design and build a GraphQL API with Node.js: schemas, resolvers, data loaders and authentication.",
      salesCopy: `## GraphQL, Without the Magic

Draft sales copy. Coming soon.`,
      instructorId: instructor2.id,
      categoryId: catBySlug["programming"].id,
      status: CourseStatus.Draft,
      coverImageUrl: "/images/course-nodejs.svg",
      price: 6999,
      createdAt: daysAgo(20),
      updatedAt: daysAgo(3),
    })
    .returning()
    .all();

  const course4LessonIds = insertCourseContent(
    course4.id,
    [
      {
        title: "GraphQL Basics",
        lessons: [
          { title: "Why GraphQL?", duration: 8 },
          { title: "Your First Schema", duration: 15 },
        ],
      },
    ],
    20
  );

  console.log(
    `Created course "${course4.title}" (draft) with ${course4LessonIds.length} lessons.`
  );

  // ─── Quizzes ───
  // Add quizzes to some lessons in both courses

  // Quiz 1: TypeScript Basics Quiz (attached to "Your First TypeScript Program", lesson 3 of course 1)
  const [quiz1] = db
    .insert(schema.quizzes)
    .values({
      lessonId: course1LessonIds[2], // "Your First TypeScript Program"
      title: "TypeScript Basics Quiz",
      passingScore: 0.7,
    })
    .returning()
    .all();

  const quiz1Questions = [
    {
      text: "What does TypeScript compile to?",
      type: QuestionType.MultipleChoice,
      options: [
        { text: "JavaScript", correct: true },
        { text: "WebAssembly", correct: false },
        { text: "Java bytecode", correct: false },
        { text: "Machine code", correct: false },
      ],
    },
    {
      text: "TypeScript is a superset of JavaScript.",
      type: QuestionType.TrueFalse,
      options: [
        { text: "True", correct: true },
        { text: "False", correct: false },
      ],
    },
    {
      text: "Which file configures the TypeScript compiler?",
      type: QuestionType.MultipleChoice,
      options: [
        { text: "tsconfig.json", correct: true },
        { text: "package.json", correct: false },
        { text: "typescript.config.js", correct: false },
        { text: ".tsrc", correct: false },
      ],
    },
  ];

  const quiz1OptionIds: {
    questionId: number;
    optionId: number;
    correct: boolean;
  }[] = [];

  for (let qi = 0; qi < quiz1Questions.length; qi++) {
    const q = quiz1Questions[qi];
    const [question] = db
      .insert(schema.quizQuestions)
      .values({
        quizId: quiz1.id,
        questionText: q.text,
        questionType: q.type,
        position: qi + 1,
      })
      .returning()
      .all();

    for (const opt of q.options) {
      const [option] = db
        .insert(schema.quizOptions)
        .values({
          questionId: question.id,
          optionText: opt.text,
          isCorrect: opt.correct,
        })
        .returning()
        .all();
      quiz1OptionIds.push({
        questionId: question.id,
        optionId: option.id,
        correct: opt.correct,
      });
    }
  }

  // Quiz 2: Generics Quiz (attached to "Generics Basics", lesson index 8 in course 1)
  const [quiz2] = db
    .insert(schema.quizzes)
    .values({
      lessonId: course1LessonIds[8], // "Generics Basics" (module 3, lesson 2)
      title: "Generics Knowledge Check",
      passingScore: 0.6,
    })
    .returning()
    .all();

  const quiz2Questions = [
    {
      text: "What is the primary benefit of generics?",
      type: QuestionType.MultipleChoice,
      options: [
        { text: "Code reusability with type safety", correct: true },
        { text: "Faster execution speed", correct: false },
        { text: "Smaller bundle size", correct: false },
        { text: "Better error messages", correct: false },
      ],
    },
    {
      text: "Generic type parameters can be constrained using the 'extends' keyword.",
      type: QuestionType.TrueFalse,
      options: [
        { text: "True", correct: true },
        { text: "False", correct: false },
      ],
    },
  ];

  const quiz2OptionIds: {
    questionId: number;
    optionId: number;
    correct: boolean;
  }[] = [];

  for (let qi = 0; qi < quiz2Questions.length; qi++) {
    const q = quiz2Questions[qi];
    const [question] = db
      .insert(schema.quizQuestions)
      .values({
        quizId: quiz2.id,
        questionText: q.text,
        questionType: q.type,
        position: qi + 1,
      })
      .returning()
      .all();

    for (const opt of q.options) {
      const [option] = db
        .insert(schema.quizOptions)
        .values({
          questionId: question.id,
          optionText: opt.text,
          isCorrect: opt.correct,
        })
        .returning()
        .all();
      quiz2OptionIds.push({
        questionId: question.id,
        optionId: option.id,
        correct: opt.correct,
      });
    }
  }

  // Quiz 3: REST API Basics (attached to "HTTP Methods and Status Codes", lesson index 2 in course 2)
  const [quiz3] = db
    .insert(schema.quizzes)
    .values({
      lessonId: course2LessonIds[2], // "HTTP Methods and Status Codes"
      title: "HTTP Methods Quiz",
      passingScore: 0.7,
    })
    .returning()
    .all();

  const quiz3Questions = [
    {
      text: "Which HTTP method is used to create a new resource?",
      type: QuestionType.MultipleChoice,
      options: [
        { text: "POST", correct: true },
        { text: "GET", correct: false },
        { text: "PUT", correct: false },
        { text: "PATCH", correct: false },
      ],
    },
    {
      text: "A 404 status code means the server encountered an internal error.",
      type: QuestionType.TrueFalse,
      options: [
        { text: "True", correct: false },
        { text: "False", correct: true },
      ],
    },
    {
      text: "Which status code indicates successful resource creation?",
      type: QuestionType.MultipleChoice,
      options: [
        { text: "201 Created", correct: true },
        { text: "200 OK", correct: false },
        { text: "204 No Content", correct: false },
        { text: "202 Accepted", correct: false },
      ],
    },
  ];

  const quiz3OptionIds: {
    questionId: number;
    optionId: number;
    correct: boolean;
  }[] = [];

  for (let qi = 0; qi < quiz3Questions.length; qi++) {
    const q = quiz3Questions[qi];
    const [question] = db
      .insert(schema.quizQuestions)
      .values({
        quizId: quiz3.id,
        questionText: q.text,
        questionType: q.type,
        position: qi + 1,
      })
      .returning()
      .all();

    for (const opt of q.options) {
      const [option] = db
        .insert(schema.quizOptions)
        .values({
          questionId: question.id,
          optionText: opt.text,
          isCorrect: opt.correct,
        })
        .returning()
        .all();
      quiz3OptionIds.push({
        questionId: question.id,
        optionId: option.id,
        correct: opt.correct,
      });
    }
  }

  console.log("Created quizzes with questions and options.");

  // ─── Enrollments ───
  // Varied enrollment patterns:
  // - Emma: enrolled in both courses (nearly complete in course 1, mid-way in course 2)
  // - James: enrolled in course 1 only (completed)
  // - Olivia: enrolled in both courses (just started course 1, mid-way in course 2)
  // - Liam: enrolled in course 2 only (just started, abandoned)
  // - Sophia: enrolled in course 1 only (recently enrolled, barely started)

  db.insert(schema.enrollments)
    .values([
      { userId: students[0].id, courseId: course1.id, enrolledAt: daysAgo(50) },
      { userId: students[0].id, courseId: course2.id, enrolledAt: daysAgo(40) },
      {
        userId: students[1].id,
        courseId: course1.id,
        enrolledAt: daysAgo(45),
        completedAt: daysAgo(10),
      },
      { userId: students[2].id, courseId: course1.id, enrolledAt: daysAgo(35) },
      { userId: students[2].id, courseId: course2.id, enrolledAt: daysAgo(30) },
      { userId: students[3].id, courseId: course2.id, enrolledAt: daysAgo(25) },
      { userId: students[4].id, courseId: course1.id, enrolledAt: daysAgo(15) },
    ])
    .run();

  console.log("Created hand-written enrollments.");

  // ─── Course Ratings ───
  // Star ratings from enrolled students only. Not everyone rates.
  // Course 1 averages 4.3 (4 ratings), course 2 averages 4.5 (2 ratings).

  db.insert(schema.courseRatings)
    .values([
      {
        userId: students[0].id,
        courseId: course1.id,
        rating: 5,
        createdAt: daysAgo(20),
        updatedAt: daysAgo(20),
      },
      {
        userId: students[1].id,
        courseId: course1.id,
        rating: 5,
        createdAt: daysAgo(9),
        updatedAt: daysAgo(9),
      },
      {
        userId: students[2].id,
        courseId: course1.id,
        rating: 4,
        createdAt: daysAgo(18),
        updatedAt: daysAgo(18),
      },
      {
        userId: students[4].id,
        courseId: course1.id,
        rating: 3,
        createdAt: daysAgo(5),
        updatedAt: daysAgo(5),
      },
      {
        userId: students[0].id,
        courseId: course2.id,
        rating: 4,
        createdAt: daysAgo(12),
        updatedAt: daysAgo(12),
      },
      {
        userId: students[3].id,
        courseId: course2.id,
        rating: 5,
        createdAt: daysAgo(8),
        updatedAt: daysAgo(8),
      },
    ])
    .run();

  console.log("Created hand-written course ratings.");

  // ─── Lesson Comments ───
  // Covers every state the Q&A feature can be in, so the instructor queue and
  // the lesson thread both have something real to render: answered threads,
  // questions still waiting (two of them stale enough to flag), a question only
  // another student replied to (still unanswered), an edited comment, and a
  // deleted question kept as a tombstone because it has a reply.
  // Only enrolled students comment.

  function comment(values: typeof schema.comments.$inferInsert) {
    const [row] = db.insert(schema.comments).values(values).returning().all();
    return row;
  }

  // Answered: student asks, Sarah answers, student confirms.
  const c1q1 = comment({
    lessonId: course1LessonIds[2],
    userId: students[0].id,
    body: "I'm getting `tsc: command not found` when I run the compile step. Did I miss an install somewhere?",
    createdAt: daysAgo(30),
  });
  comment({
    lessonId: course1LessonIds[2],
    userId: instructor1.id,
    parentId: c1q1.id,
    body: "That usually means TypeScript is installed locally but not on your PATH. Two options:\n\n```bash\nnpx tsc --version\n```\n\nor install it globally with `npm i -g typescript`. I'd stick with `npx` — it keeps the version pinned to the project.",
    createdAt: daysAgo(29),
  });
  comment({
    lessonId: course1LessonIds[2],
    userId: students[0].id,
    parentId: c1q1.id,
    body: "`npx` did it. Thank you!",
    createdAt: daysAgo(29),
  });

  // Waiting, and stale enough to flag amber in the queue.
  comment({
    lessonId: course1LessonIds[7],
    userId: students[2].id,
    body: "Why does this fail to infer? I expected `T` to come out as `string`.\n\n```typescript\nfunction first<T>(items: T[]): T {\n  return items[0];\n}\n\nconst x = first([]);\n```",
    createdAt: daysAgo(6),
  });

  // Waiting, but posted today — should look calm in the queue.
  comment({
    lessonId: course1LessonIds[4],
    userId: students[4].id,
    body: "Is there a reason to prefer `interface` over `type` here, or is it purely style?",
    createdAt: daysAgo(1),
  });

  // Another student replied, but no staff has — still counts as unanswered.
  const c1q4 = comment({
    lessonId: course1LessonIds[3],
    userId: students[1].id,
    body: "Does strict mode change anything about how this example behaves?",
    createdAt: daysAgo(4),
  });
  comment({
    lessonId: course1LessonIds[3],
    userId: students[0].id,
    parentId: c1q4.id,
    body: "I think it only affects the null checks, but I'd like a second opinion too.",
    createdAt: daysAgo(4),
  });

  // Edited by its author — renders an "(edited)" marker.
  const c1q5 = comment({
    lessonId: course1LessonIds[0],
    userId: students[1].id,
    body: "Coming from JavaScript, how much of this will feel familiar? (Edited to add: I've used JSDoc types before.)",
    createdAt: daysAgo(40),
    editedAt: daysAgo(39),
  });
  comment({
    lessonId: course1LessonIds[0],
    userId: instructor1.id,
    parentId: c1q5.id,
    body: "Most of it. If you've written JSDoc types you already understand the mental model — the syntax is just less noisy.",
    createdAt: daysAgo(39),
  });

  // Deleted question that keeps its reply — renders as a tombstone.
  const c1q6 = comment({
    lessonId: course1LessonIds[1],
    userId: students[4].id,
    body: "Posted this on the wrong lesson, sorry!",
    createdAt: daysAgo(12),
    deletedAt: daysAgo(12),
  });
  comment({
    lessonId: course1LessonIds[1],
    userId: instructor1.id,
    parentId: c1q6.id,
    body: "No problem at all — asked and answered over on the generics lesson.",
    createdAt: daysAgo(12),
  });

  // Course 2: waiting a long time.
  comment({
    lessonId: course2LessonIds[2],
    userId: students[3].id,
    body: "When would you return a 422 instead of a 400? The distinction still isn't clicking for me.",
    createdAt: daysAgo(9),
  });

  // Course 2: answered by an admin rather than the owning instructor.
  const c2q2 = comment({
    lessonId: course2LessonIds[0],
    userId: students[2].id,
    body: "Are the example requests in this lesson hitting a real API, or is it all mocked?",
    createdAt: daysAgo(14),
  });
  comment({
    lessonId: course2LessonIds[0],
    userId: admin.id,
    parentId: c2q2.id,
    body: "All mocked — nothing leaves your machine. The repo linked on the lesson has the fixtures.",
    createdAt: daysAgo(13),
  });

  // An instructor's own top-level post never queues up as work for themselves.
  comment({
    lessonId: course2LessonIds[1],
    userId: instructor2.id,
    body: "Heads up: the status code table was updated this week to include 418. Refresh if you cached the old one.",
    createdAt: daysAgo(7),
  });

  console.log("Created lesson comments.");

  // ─── Lesson Progress ───

  // Helper to mark lessons as complete
  function markComplete(
    userId: number,
    lessonId: number,
    daysAgoCompleted: number
  ) {
    db.insert(schema.lessonProgress)
      .values({
        userId,
        lessonId,
        status: LessonProgressStatus.Completed,
        completedAt: daysAgo(daysAgoCompleted),
      })
      .run();
  }

  function markInProgress(userId: number, lessonId: number) {
    db.insert(schema.lessonProgress)
      .values({
        userId,
        lessonId,
        status: LessonProgressStatus.InProgress,
      })
      .run();
  }

  // Emma (students[0]) — nearly complete in course 1 (17 of 19 lessons done)
  for (let i = 0; i < 17; i++) {
    markComplete(students[0].id, course1LessonIds[i], 50 - i);
  }
  markInProgress(students[0].id, course1LessonIds[17]);

  // Emma — mid-way through course 2 (10 of 20 lessons done)
  for (let i = 0; i < 10; i++) {
    markComplete(students[0].id, course2LessonIds[i], 40 - i);
  }
  markInProgress(students[0].id, course2LessonIds[10]);

  // James (students[1]) — completed all of course 1
  for (let i = 0; i < course1LessonIds.length; i++) {
    markComplete(students[1].id, course1LessonIds[i], 45 - i);
  }

  // Olivia (students[2]) — just started course 1 (3 lessons done)
  for (let i = 0; i < 3; i++) {
    markComplete(students[2].id, course1LessonIds[i], 30 - i);
  }
  markInProgress(students[2].id, course1LessonIds[3]);

  // Olivia — mid-way through course 2 (8 lessons done)
  for (let i = 0; i < 8; i++) {
    markComplete(students[2].id, course2LessonIds[i], 28 - i);
  }

  // Liam (students[3]) — just started course 2, abandoned (2 lessons done)
  for (let i = 0; i < 2; i++) {
    markComplete(students[3].id, course2LessonIds[i], 22 - i);
  }

  // Sophia (students[4]) — barely started course 1 (1 lesson done)
  markComplete(students[4].id, course1LessonIds[0], 12);
  markInProgress(students[4].id, course1LessonIds[1]);

  console.log("Created lesson progress records.");

  // ─── Quiz Attempts ───

  // Helper to record a quiz attempt with answers
  function recordQuizAttempt(
    userId: number,
    quizId: number,
    optionIds: { questionId: number; optionId: number; correct: boolean }[],
    selectedCorrectIndices: number[], // which questions (0-based) the student got right
    attemptDaysAgo: number
  ) {
    const totalQuestions = new Set(optionIds.map((o) => o.questionId)).size;
    const correctCount = selectedCorrectIndices.length;
    const score = correctCount / totalQuestions;

    // Determine passing based on quiz passingScore (we'll just use 0.7 as default)
    const passed = score >= 0.7;

    const [attempt] = db
      .insert(schema.quizAttempts)
      .values({
        userId,
        quizId,
        score,
        passed,
        attemptedAt: daysAgo(attemptDaysAgo),
      })
      .returning()
      .all();

    // Build answer selections
    const questionIds = [...new Set(optionIds.map((o) => o.questionId))];
    for (let qi = 0; qi < questionIds.length; qi++) {
      const qId = questionIds[qi];
      const qOptions = optionIds.filter((o) => o.questionId === qId);
      let selectedOption: (typeof qOptions)[0];

      if (selectedCorrectIndices.includes(qi)) {
        // Pick correct answer
        selectedOption = qOptions.find((o) => o.correct)!;
      } else {
        // Pick wrong answer
        selectedOption = qOptions.find((o) => !o.correct)!;
      }

      db.insert(schema.quizAnswers)
        .values({
          attemptId: attempt.id,
          questionId: qId,
          selectedOptionId: selectedOption.optionId,
        })
        .run();
    }
  }

  // Emma — passed quiz 1 (3/3 correct)
  recordQuizAttempt(students[0].id, quiz1.id, quiz1OptionIds, [0, 1, 2], 35);

  // Emma — passed quiz 2 (2/2 correct)
  recordQuizAttempt(students[0].id, quiz2.id, quiz2OptionIds, [0, 1], 30);

  // Emma — passed quiz 3 (2/3 correct, just barely at 67% with 70% passing = fail, then retake)
  recordQuizAttempt(students[0].id, quiz3.id, quiz3OptionIds, [0, 2], 28);
  // Retake — all correct
  recordQuizAttempt(students[0].id, quiz3.id, quiz3OptionIds, [0, 1, 2], 27);

  // James — passed quiz 1 (3/3 correct)
  recordQuizAttempt(students[1].id, quiz1.id, quiz1OptionIds, [0, 1, 2], 40);

  // James — passed quiz 2 (2/2 correct)
  recordQuizAttempt(students[1].id, quiz2.id, quiz2OptionIds, [0, 1], 35);

  // Olivia — failed quiz 1 first attempt (1/3 correct), then passed on retry (3/3)
  recordQuizAttempt(students[2].id, quiz1.id, quiz1OptionIds, [0], 25);
  recordQuizAttempt(students[2].id, quiz1.id, quiz1OptionIds, [0, 1, 2], 24);

  // Olivia — passed quiz 3 (3/3 correct)
  recordQuizAttempt(students[2].id, quiz3.id, quiz3OptionIds, [0, 1, 2], 20);

  // Sophia — failed quiz 1 (1/3 correct, hasn't retaken yet)
  recordQuizAttempt(students[4].id, quiz1.id, quiz1OptionIds, [1], 10);

  console.log("Created quiz attempts and answers.");

  // ─── Video Watch Events ───
  // Only the event types the player in app/components/youtube-player.tsx
  // sends: "play" when playback starts, a "progress" heartbeat every 10
  // seconds while it plays, then "pause" or "ended".

  const PROGRESS_HEARTBEAT_SECONDS = 10;

  // One stretch of playback, from `fromSeconds` to `toSeconds`.
  function watchSession(
    userId: number,
    lessonId: number,
    fromSeconds: number,
    toSeconds: number,
    end: "pause" | "ended",
    sessionDaysAgo: number
  ) {
    const startedAt = daysAgo(sessionDaysAgo);
    const events: (typeof schema.videoWatchEvents.$inferInsert)[] = [
      {
        userId,
        lessonId,
        eventType: "play",
        positionSeconds: fromSeconds,
        createdAt: startedAt,
      },
    ];

    for (
      let elapsed = PROGRESS_HEARTBEAT_SECONDS;
      fromSeconds + elapsed < toSeconds;
      elapsed += PROGRESS_HEARTBEAT_SECONDS
    ) {
      events.push({
        userId,
        lessonId,
        eventType: "progress",
        positionSeconds: fromSeconds + elapsed,
        createdAt: secondsAfter(startedAt, elapsed),
      });
    }

    events.push({
      userId,
      lessonId,
      eventType: end,
      positionSeconds: toSeconds,
      createdAt: secondsAfter(startedAt, toSeconds - fromSeconds),
    });

    db.insert(schema.videoWatchEvents).values(events).run();
  }

  // Emma watching course 1 lesson 1 (8 min video), in two sittings
  watchSession(students[0].id, course1LessonIds[0], 0, 180, "pause", 50);
  watchSession(students[0].id, course1LessonIds[0], 180, 480, "ended", 49);

  // James watching course 1 lesson 1 in one go
  watchSession(students[1].id, course1LessonIds[0], 0, 480, "ended", 45);

  // Liam started watching course 2 lesson 1, rewound, and stopped mid-way
  watchSession(students[3].id, course2LessonIds[0], 0, 300, "pause", 22);
  watchSession(students[3].id, course2LessonIds[0], 150, 360, "pause", 21);

  console.log("Created video watch events.");

  // ─── Purchases ───
  // Individual purchases for enrolled students

  const [purchase1] = db
    .insert(schema.purchases)
    .values({
      userId: students[0].id, // Emma — bought course 1 individually
      courseId: course1.id,
      amountPaid: 4999,
      country: "US",
      createdAt: daysAgo(50),
    })
    .returning()
    .all();

  db.insert(schema.purchases)
    .values({
      userId: students[0].id, // Emma — bought course 2 individually
      courseId: course2.id,
      amountPaid: 5999,
      country: "US",
      createdAt: daysAgo(40),
    })
    .run();

  db.insert(schema.purchases)
    .values({
      userId: students[1].id, // James — bought course 1 with PPP discount (India)
      courseId: course1.id,
      amountPaid: 2500,
      country: "IN",
      createdAt: daysAgo(45),
    })
    .run();

  db.insert(schema.purchases)
    .values({
      userId: students[2].id, // Olivia — bought course 1 individually
      courseId: course1.id,
      amountPaid: 4999,
      country: "US",
      createdAt: daysAgo(35),
    })
    .run();

  db.insert(schema.purchases)
    .values({
      userId: students[4].id, // Sophia — bought course 1 individually
      courseId: course1.id,
      amountPaid: 4999,
      country: "US",
      createdAt: daysAgo(15),
    })
    .run();

  console.log("Created hand-written individual purchases.");

  // ─── Audience at scale ───
  // Everything above is hand-written so that individual screens have
  // something specific to render. This section adds the volume the instructor
  // analytics dashboard needs: about a year of purchases, team purchases,
  // enrolments, lesson progress with planted drop-off cliffs, quiz attempts,
  // ratings and watch events, with rows inside the last 7 days.
  //
  // People are found by email, never by array position, so adding people here
  // cannot silently re-point a purchase or a coupon at someone else.

  type CourseKey = "typescript" | "node";

  const seededCourses: Record<
    CourseKey,
    {
      id: number;
      price: number;
      lessonIds: number[];
      lessonDurations: number[];
    }
  > = {
    typescript: {
      id: course1.id,
      price: course1.price,
      lessonIds: course1LessonIds,
      lessonDurations: c1Modules.flatMap((m) =>
        m.lessons.map((l) => l.duration)
      ),
    },
    node: {
      id: course2.id,
      price: course2.price,
      lessonIds: course2LessonIds,
      lessonDurations: c2Modules.flatMap((m) =>
        m.lessons.map((l) => l.duration)
      ),
    },
  };

  // Purchasing-power-parity discount by country. Countries not listed pay
  // full price.
  const PPP_FACTOR: Record<string, number> = {
    IN: 0.5,
    BR: 0.55,
    NG: 0.4,
    MX: 0.6,
    PL: 0.7,
  };

  function pppPrice(price: number, country: string) {
    return Math.round(price * (PPP_FACTOR[country] ?? 1));
  }

  function userByEmail(email: string) {
    const user = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .get();
    if (!user) throw new Error(`Seed: no user with email ${email}`);
    return user;
  }

  function emailFor(name: string) {
    return `${slugify(name).replace(/-/g, ".")}@student.dev`;
  }

  type Buy = { course: CourseKey; daysAgo: number };

  // New students, appended after the hand-written ones. `buys` are individual
  // purchases. People with no `buys` reach a course only through a team
  // coupon (see TEAM_PURCHASES), or are team buyers who never enrol.
  const AUDIENCE: { name: string; country: string; buys: Buy[] }[] = [
    // Bought both courses
    {
      name: "Noah Becker",
      country: "DE",
      buys: [
        { course: "typescript", daysAgo: 358 },
        { course: "node", daysAgo: 328 },
      ],
    },
    {
      name: "Ava Robinson",
      country: "US",
      buys: [
        { course: "typescript", daysAgo: 355 },
        { course: "node", daysAgo: 300 },
      ],
    },
    {
      name: "Lucas Silva",
      country: "BR",
      buys: [
        { course: "typescript", daysAgo: 350 },
        { course: "node", daysAgo: 320 },
      ],
    },
    {
      name: "Mia Kowalski",
      country: "PL",
      buys: [
        { course: "typescript", daysAgo: 340 },
        { course: "node", daysAgo: 250 },
      ],
    },
    {
      name: "Ethan Wright",
      country: "GB",
      buys: [
        { course: "typescript", daysAgo: 330 },
        { course: "node", daysAgo: 180 },
      ],
    },
    {
      name: "Isabella Rossi",
      country: "IT",
      buys: [
        { course: "typescript", daysAgo: 300 },
        { course: "node", daysAgo: 290 },
      ],
    },
    {
      name: "Arjun Mehta",
      country: "IN",
      buys: [
        { course: "typescript", daysAgo: 280 },
        { course: "node", daysAgo: 120 },
      ],
    },
    {
      name: "Chloe Dubois",
      country: "FR",
      buys: [
        { course: "typescript", daysAgo: 250 },
        { course: "node", daysAgo: 245 },
      ],
    },
    {
      name: "Mateo Garcia",
      country: "MX",
      buys: [
        { course: "typescript", daysAgo: 220 },
        { course: "node", daysAgo: 95 },
      ],
    },
    {
      name: "Hana Sato",
      country: "JP",
      buys: [
        { course: "typescript", daysAgo: 200 },
        { course: "node", daysAgo: 60 },
      ],
    },
    {
      name: "Oliver Smith",
      country: "AU",
      buys: [
        { course: "typescript", daysAgo: 170 },
        { course: "node", daysAgo: 160 },
      ],
    },
    {
      name: "Amara Okafor",
      country: "NG",
      buys: [
        { course: "typescript", daysAgo: 150 },
        { course: "node", daysAgo: 40 },
      ],
    },
    {
      name: "Freya Nilsson",
      country: "SE",
      buys: [
        { course: "typescript", daysAgo: 120 },
        { course: "node", daysAgo: 75 },
      ],
    },
    {
      name: "Daniel Kim",
      country: "CA",
      buys: [
        { course: "typescript", daysAgo: 97 },
        { course: "node", daysAgo: 85 },
      ],
    },
    {
      name: "Zara Ahmed",
      country: "GB",
      buys: [
        { course: "typescript", daysAgo: 70 },
        { course: "node", daysAgo: 22 },
      ],
    },
    {
      name: "Rafael Costa",
      country: "BR",
      buys: [
        { course: "typescript", daysAgo: 50 },
        { course: "node", daysAgo: 12 },
      ],
    },
    {
      name: "Sienna Clarke",
      country: "US",
      buys: [
        { course: "typescript", daysAgo: 28 },
        { course: "node", daysAgo: 6 },
      ],
    },
    {
      name: "Tomas Novak",
      country: "PL",
      buys: [
        { course: "typescript", daysAgo: 16 },
        { course: "node", daysAgo: 3 },
      ],
    },
    // Bought the TypeScript course only
    {
      name: "Grace Lee",
      country: "US",
      buys: [{ course: "typescript", daysAgo: 345 }],
    },
    {
      name: "Ravi Patel",
      country: "IN",
      buys: [{ course: "typescript", daysAgo: 190 }],
    },
    {
      name: "Elena Petrova",
      country: "DE",
      buys: [{ course: "typescript", daysAgo: 9 }],
    },
    {
      name: "Jack Turner",
      country: "US",
      buys: [{ course: "typescript", daysAgo: 2 }],
    },
    // Bought the Node.js course only
    {
      name: "Fatima Bello",
      country: "NG",
      buys: [{ course: "node", daysAgo: 310 }],
    },
    {
      name: "Leo Martin",
      country: "FR",
      buys: [{ course: "node", daysAgo: 140 }],
    },
    {
      name: "Yuki Tanaka",
      country: "JP",
      buys: [{ course: "node", daysAgo: 1 }],
    },
    // Team coupon redeemers, some of whom also bought the other course
    { name: "Ben Carter", country: "GB", buys: [] },
    {
      name: "Ruby Evans",
      country: "GB",
      buys: [{ course: "node", daysAgo: 100 }],
    },
    {
      name: "Owen Hughes",
      country: "GB",
      buys: [{ course: "node", daysAgo: 65 }],
    },
    {
      name: "Isla Morgan",
      country: "GB",
      buys: [{ course: "node", daysAgo: 33 }],
    },
    {
      name: "Finn Walsh",
      country: "GB",
      buys: [{ course: "node", daysAgo: 8 }],
    },
    {
      name: "Aiko Mori",
      country: "JP",
      buys: [{ course: "node", daysAgo: 130 }],
    },
    {
      name: "Sora Ito",
      country: "JP",
      buys: [{ course: "node", daysAgo: 260 }],
    },
    // Team buyers who never enrol themselves
    { name: "Dana Whitfield", country: "GB", buys: [] },
    { name: "Kenji Watanabe", country: "JP", buys: [] },
  ];

  // Further purchases by the hand-written students.
  const EXTRA_PURCHASES: { email: string; country: string; buy: Buy }[] = [
    {
      email: "james.park@student.dev",
      country: "IN",
      buy: { course: "node", daysAgo: 20 },
    },
    {
      email: "sophia.davis@student.dev",
      country: "US",
      buy: { course: "node", daysAgo: 10 },
    },
    {
      email: "liam.thompson@student.dev",
      country: "US",
      buy: { course: "typescript", daysAgo: 18 },
    },
  ];

  // ─── Teams, Team Members, and Coupons ───
  // A team purchase is one purchase row for several seats, at full price, plus
  // one coupon per seat. A redeemer enrols with no purchase row of their own.
  //
  // - Bossy McBossface: 5 seats of the Node.js course, 30 days ago (exactly on
  //   the 30-day boundary). 3 redeemed, 2 unredeemed.
  // - Dana Whitfield: 4 seats of the TypeScript course, 210 days ago. All 4
  //   redeemed.
  // - Kenji Watanabe: 8 seats of the TypeScript course, 4 days ago (launch
  //   week). 2 redeemed, 6 unredeemed.

  const TEAM_PURCHASES: {
    buyerEmail: string;
    course: CourseKey;
    country: string;
    daysAgo: number;
    couponCodes: string[];
    redeemers: { email: string; daysAgo: number }[];
  }[] = [
    {
      buyerEmail: "bossy.mcbossface@student.dev",
      course: "node",
      country: "US",
      daysAgo: 30,
      couponCodes: [
        "TEAM-NODEJS-A1B2C3",
        "TEAM-NODEJS-D4E5F6",
        "TEAM-NODEJS-G7H8I9",
        "TEAM-NODEJS-J0K1L2",
        "TEAM-NODEJS-M3N4O5",
      ],
      redeemers: [
        { email: "olivia.martinez@student.dev", daysAgo: 30 },
        { email: "liam.thompson@student.dev", daysAgo: 25 },
        { email: emailFor("Ben Carter"), daysAgo: 28 },
      ],
    },
    {
      buyerEmail: emailFor("Dana Whitfield"),
      course: "typescript",
      country: "GB",
      daysAgo: 210,
      couponCodes: [
        "TEAM-TS-WHITFIELD-1",
        "TEAM-TS-WHITFIELD-2",
        "TEAM-TS-WHITFIELD-3",
        "TEAM-TS-WHITFIELD-4",
      ],
      redeemers: [
        { email: emailFor("Ruby Evans"), daysAgo: 208 },
        { email: emailFor("Owen Hughes"), daysAgo: 205 },
        { email: emailFor("Isla Morgan"), daysAgo: 200 },
        { email: emailFor("Finn Walsh"), daysAgo: 150 },
      ],
    },
    {
      buyerEmail: emailFor("Kenji Watanabe"),
      course: "typescript",
      country: "JP",
      daysAgo: 4,
      couponCodes: Array.from(
        { length: 8 },
        (_, i) => `TEAM-TS-WATANABE-${i + 1}`
      ),
      redeemers: [
        { email: emailFor("Aiko Mori"), daysAgo: 3 },
        { email: emailFor("Sora Ito"), daysAgo: 1 },
      ],
    },
  ];

  // Each new user is created the day before their first purchase or coupon
  // redemption.
  function firstActivityDaysAgo(email: string, buys: Buy[]) {
    const teamDays = TEAM_PURCHASES.flatMap((team) => [
      ...(team.buyerEmail === email ? [team.daysAgo] : []),
      ...team.redeemers.filter((r) => r.email === email).map((r) => r.daysAgo),
    ]);
    return Math.max(0, ...buys.map((b) => b.daysAgo), ...teamDays);
  }

  db.insert(schema.users)
    .values(
      AUDIENCE.map((person) => ({
        name: person.name,
        email: emailFor(person.name),
        role: UserRole.Student,
        avatarUrl: `https://api.dicebear.com/9.x/avataaars/svg?seed=${slugify(person.name)}`,
        createdAt: daysAgo(
          firstActivityDaysAgo(emailFor(person.name), person.buys) + 1
        ),
      }))
    )
    .run();

  // Enrolments created in this section. Their progress is generated below.
  const newEnrollments: {
    enrollmentId: number;
    userId: number;
    course: CourseKey;
    enrolledDaysAgo: number;
  }[] = [];

  function enrol(userId: number, course: CourseKey, enrolledDaysAgo: number) {
    const [enrollment] = db
      .insert(schema.enrollments)
      .values({
        userId,
        courseId: seededCourses[course].id,
        enrolledAt: daysAgo(enrolledDaysAgo),
      })
      .returning()
      .all();
    newEnrollments.push({
      enrollmentId: enrollment.id,
      userId,
      course,
      enrolledDaysAgo,
    });
  }

  const individualPurchases = [
    ...AUDIENCE.flatMap((person) =>
      person.buys.map((buy) => ({
        email: emailFor(person.name),
        country: person.country,
        buy,
      }))
    ),
    ...EXTRA_PURCHASES,
  ];

  for (const { email, country, buy } of individualPurchases) {
    const user = userByEmail(email);
    const course = seededCourses[buy.course];
    db.insert(schema.purchases)
      .values({
        userId: user.id,
        courseId: course.id,
        amountPaid: pppPrice(course.price, country),
        country,
        createdAt: daysAgo(buy.daysAgo),
      })
      .run();
    enrol(user.id, buy.course, buy.daysAgo);
  }

  for (const team of TEAM_PURCHASES) {
    const buyer = userByEmail(team.buyerEmail);
    const course = seededCourses[team.course];

    const [teamRow] = db
      .insert(schema.teams)
      .values({ createdAt: daysAgo(team.daysAgo) })
      .returning()
      .all();

    db.insert(schema.teamMembers)
      .values({
        teamId: teamRow.id,
        userId: buyer.id,
        role: TeamMemberRole.Admin,
        createdAt: daysAgo(team.daysAgo),
      })
      .run();

    const [purchase] = db
      .insert(schema.purchases)
      .values({
        userId: buyer.id,
        courseId: course.id,
        amountPaid: course.price * team.couponCodes.length,
        country: team.country,
        createdAt: daysAgo(team.daysAgo),
      })
      .returning()
      .all();

    const coupons = db
      .insert(schema.coupons)
      .values(
        team.couponCodes.map((code) => ({
          teamId: teamRow.id,
          courseId: course.id,
          code,
          purchaseId: purchase.id,
          createdAt: daysAgo(team.daysAgo),
        }))
      )
      .returning()
      .all();

    team.redeemers.forEach((redeemer, i) => {
      const user = userByEmail(redeemer.email);
      db.update(schema.coupons)
        .set({
          redeemedByUserId: user.id,
          redeemedAt: daysAgo(redeemer.daysAgo),
        })
        .where(eq(schema.coupons.id, coupons[i].id))
        .run();

      // The hand-written students already have their enrolment above.
      const existing = db
        .select()
        .from(schema.enrollments)
        .where(
          and(
            eq(schema.enrollments.userId, user.id),
            eq(schema.enrollments.courseId, course.id)
          )
        )
        .get();
      if (!existing) enrol(user.id, team.course, redeemer.daysAgo);
    });
  }

  // ─── Lesson progress, quizzes, ratings and watch events at scale ───
  //
  // PLANTED DROP-OFF CLIFFS. Later tickets assert against these. Each new
  // enrollee's furthest lesson comes from FURTHEST_REACHED, taken in
  // enrolment order and cycled, then capped at two lessons per day enrolled.
  // "Reached" means a lesson_progress row exists (completed or in progress)
  // for that lesson or a later one.
  //
  // - Introduction to TypeScript, "Generics Basics" (lesson index 8, module 3
  //   "Functions and Generics"): the biggest cliff, 23 -> 12 of 33 enrolled.
  //   Many students reach "Function Types" (index 7) and stop.
  // - Introduction to TypeScript, "TypeScript with React" (lesson index 16,
  //   first lesson of module 5 "Real-World TypeScript"): a second, smaller
  //   cliff, 12 -> 7. Students who reach "Template Literal Types" (index 15)
  //   stop.
  // - Building REST APIs with Node.js, "JWT Authentication" (lesson index 12,
  //   first lesson of module 4 "Authentication and Security"): 23 -> 9 of 33
  //   enrolled. Students who reach "Transactions" (index 11) stop.
  //
  // Reached-at-least counts per lesson index, hand-written students included
  // (the seed prints these again at the end):
  //   TypeScript: 33 33 32 28 27 24 24 23 | 12 12 12 12 12 12 12 12 | 7 7 6
  //   Node.js:    33 33 29 28 28 28 28 25 24 24 24 23 | 9 8 8 6 6 6 6 6
  //
  // Also planted, for the funnel's edge cases:
  // - Skipped lessons: every fourth enrollee (from the second) who gets past
  //   lesson index 5 and does not finish skips one lesson ("Arrays and
  //   Tuples", index 4, in TypeScript; "Custom Middleware", index 5, in
  //   Node.js) but carries on past it.
  // - In-progress: every second enrollee who does not finish has their
  //   furthest lesson in progress rather than completed.
  // - Finished students: only every second one has the enrolment marked
  //   completed, so the finished count and enrollments.completed_at disagree.

  const FURTHEST_REACHED: Record<CourseKey, number[]> = {
    typescript: [18, 7, 7, 7, 15, 2, 7, 18, 15, 4],
    node: [11, 11, 19, 11, 6, 11, 14, 1, 11, 19],
  };

  const SKIPPED_LESSON: Record<CourseKey, number> = {
    typescript: 4,
    node: 5,
  };

  const QUIZZES_BY_LESSON: Record<
    CourseKey,
    {
      lessonIndex: number;
      quizId: number;
      optionIds: typeof quiz1OptionIds;
      chanceCorrect: number;
    }[]
  > = {
    typescript: [
      {
        lessonIndex: 2,
        quizId: quiz1.id,
        optionIds: quiz1OptionIds,
        chanceCorrect: 0.8,
      },
      {
        lessonIndex: 8,
        quizId: quiz2.id,
        optionIds: quiz2OptionIds,
        chanceCorrect: 0.55,
      },
    ],
    node: [
      {
        lessonIndex: 2,
        quizId: quiz3.id,
        optionIds: quiz3OptionIds,
        chanceCorrect: 0.7,
      },
    ],
  };

  const enrolleeCount: Record<CourseKey, number> = { typescript: 0, node: 0 };

  for (const enrollment of newEnrollments) {
    const course = seededCourses[enrollment.course];
    const n = enrolleeCount[enrollment.course]++;
    const pattern = FURTHEST_REACHED[enrollment.course];
    const lastIndex = course.lessonIds.length - 1;
    const furthest = Math.min(
      pattern[n % pattern.length],
      enrollment.enrolledDaysAgo * 2,
      lastIndex
    );
    const finished = furthest === lastIndex;
    const skipped =
      !finished && n % 4 === 1 && furthest > SKIPPED_LESSON[enrollment.course]
        ? SKIPPED_LESSON[enrollment.course]
        : -1;
    const endsInProgress = !finished && n % 2 === 0;

    // Lessons are spread evenly from enrolment to today, at most 3 days apart.
    const step = Math.min(3, enrollment.enrolledDaysAgo / (furthest + 1));
    const completedDaysAgo = (i: number) =>
      Math.max(0, Math.round(enrollment.enrolledDaysAgo - (i + 1) * step));

    const progressRows: (typeof schema.lessonProgress.$inferInsert)[] = [];
    for (let i = 0; i <= furthest; i++) {
      if (i === skipped) continue;
      const inProgress = i === furthest && endsInProgress;
      progressRows.push({
        userId: enrollment.userId,
        lessonId: course.lessonIds[i],
        status: inProgress
          ? LessonProgressStatus.InProgress
          : LessonProgressStatus.Completed,
        completedAt: inProgress ? null : daysAgo(completedDaysAgo(i)),
      });
    }
    db.insert(schema.lessonProgress).values(progressRows).run();

    if (finished && n % 4 === 0) {
      db.update(schema.enrollments)
        .set({ completedAt: daysAgo(completedDaysAgo(lastIndex)) })
        .where(eq(schema.enrollments.id, enrollment.enrollmentId))
        .run();
    }

    // Quiz attempts on quiz lessons the student completed. A failed attempt
    // is retaken and passed half the time.
    for (const quiz of QUIZZES_BY_LESSON[enrollment.course]) {
      const completed =
        quiz.lessonIndex <= furthest &&
        quiz.lessonIndex !== skipped &&
        !(quiz.lessonIndex === furthest && endsInProgress);
      if (!completed) continue;

      const questionCount = new Set(quiz.optionIds.map((o) => o.questionId))
        .size;
      const correct = Array.from(
        { length: questionCount },
        (_, qi) => qi
      ).filter(() => random() < quiz.chanceCorrect);
      const attemptDaysAgo = completedDaysAgo(quiz.lessonIndex);
      recordQuizAttempt(
        enrollment.userId,
        quiz.quizId,
        quiz.optionIds,
        correct,
        attemptDaysAgo
      );
      if (correct.length / questionCount < 0.7 && random() < 0.5) {
        recordQuizAttempt(
          enrollment.userId,
          quiz.quizId,
          quiz.optionIds,
          Array.from({ length: questionCount }, (_, qi) => qi),
          Math.max(0, attemptDaysAgo - 1)
        );
      }
    }

    // Finishers rate the course; some who stopped early rate it too.
    if (finished || (n % 3 === 0 && furthest >= 3)) {
      const ratedAt = daysAgo(completedDaysAgo(furthest));
      db.insert(schema.courseRatings)
        .values({
          userId: enrollment.userId,
          courseId: course.id,
          rating: finished ? (random() < 0.6 ? 5 : 4) : random() < 0.5 ? 3 : 4,
          createdAt: ratedAt,
          updatedAt: ratedAt,
        })
        .run();
    }

    // Watch the first lesson to the end on the day of enrolment, then the
    // furthest lesson: to the end if completed, else stopped part-way.
    const firstSeconds = course.lessonDurations[0] * 60;
    watchSession(
      enrollment.userId,
      course.lessonIds[0],
      0,
      firstSeconds,
      "ended",
      enrollment.enrolledDaysAgo
    );
    if (furthest > 0) {
      const furthestSeconds = course.lessonDurations[furthest] * 60;
      watchSession(
        enrollment.userId,
        course.lessonIds[furthest],
        0,
        endsInProgress ? Math.round(furthestSeconds * 0.4) : furthestSeconds,
        endsInProgress ? "pause" : "ended",
        completedDaysAgo(furthest)
      );
    }
  }

  // ─── Summary ───
  // Counted from the database, so it cannot go stale.

  function countRows(table: SQLiteTable, where?: SQL): number {
    const query = db.select({ n: sql<number>`count(*)` }).from(table);
    return (where ? query.where(where) : query).get()!.n;
  }

  const purchaseCount = countRows(schema.purchases);
  const teamPurchaseCount = db
    .select({ n: sql<number>`count(distinct ${schema.coupons.purchaseId})` })
    .from(schema.coupons)
    .get()!.n;
  const couponCount = countRows(schema.coupons);
  const unredeemedCount = countRows(
    schema.coupons,
    isNull(schema.coupons.redeemedByUserId)
  );

  console.log("\n✓ Seed complete!");
  console.log(
    `  Users: ${countRows(schema.users)} (${countRows(schema.users, eq(schema.users.role, UserRole.Admin))} admin, ${countRows(schema.users, eq(schema.users.role, UserRole.Instructor))} instructors, ${countRows(schema.users, eq(schema.users.role, UserRole.Student))} students)`
  );
  console.log(`  Categories: ${countRows(schema.categories)}`);
  console.log(
    `  Courses: ${countRows(schema.courses)} (${countRows(schema.courses, eq(schema.courses.status, CourseStatus.Draft))} draft), ${countRows(schema.lessons)} lessons`
  );
  console.log(`  Quizzes: ${countRows(schema.quizzes)}`);
  console.log(`  Quiz attempts: ${countRows(schema.quizAttempts)}`);
  console.log(`  Enrollments: ${countRows(schema.enrollments)}`);
  console.log(`  Lesson progress: ${countRows(schema.lessonProgress)}`);
  console.log(`  Course ratings: ${countRows(schema.courseRatings)}`);
  console.log(`  Lesson comments: ${countRows(schema.comments)}`);
  console.log(
    `  Purchases: ${purchaseCount} (${purchaseCount - teamPurchaseCount} individual + ${teamPurchaseCount} team)`
  );
  console.log(
    `  Teams: ${countRows(schema.teams)} (${couponCount} coupons, ${unredeemedCount} unredeemed)`
  );
  console.log(
    `  Purchases in the last 7 days: ${countRows(schema.purchases, gte(schema.purchases.createdAt, daysAgo(7)))}`
  );
  console.log(
    `  Video watch events: ${countRows(schema.videoWatchEvents)} (${countRows(schema.videoWatchEvents, eq(schema.videoWatchEvents.eventType, "progress"))} progress heartbeats)`
  );

  // Reached-at-least counts per lesson, for checking the planted cliffs.
  for (const [key, course] of Object.entries(seededCourses)) {
    const reached = course.lessonIds.map((_, index) => {
      const laterLessonIds = course.lessonIds.slice(index);
      return db
        .select({
          n: sql<number>`count(distinct ${schema.lessonProgress.userId})`,
        })
        .from(schema.lessonProgress)
        .where(inArray(schema.lessonProgress.lessonId, laterLessonIds))
        .get()!.n;
    });
    console.log(
      `  Reached at least, by lesson index (${key}): ${reached.join(", ")}`
    );
  }
}

// Seed data.db only when run as a script, not when a test imports seed().
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const dataDb = new Database("data.db");
  dataDb.pragma("journal_mode = WAL");
  seed(dataDb).catch(console.error);
}
