import Database from "better-sqlite3";
import { eq, gte, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
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

const sqlite = new Database("data.db");
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

const db = drizzle(sqlite, { schema });

// ─── Helpers ───

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function hoursAgo(n: number): string {
  const d = new Date();
  d.setHours(d.getHours() - n);
  return d.toISOString();
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// Deterministic PRNG (mulberry32). The generated history below is a fixture that
// later work asserts against, so it must be identical on every run.
function makeRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Seed Data ───

async function seed() {
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

  // Every count this script reports is read back out of the database. A written
  // -down count is a count that goes stale the first time the data around it
  // changes.
  function countRows(table: SQLiteTable, where?: SQL) {
    const query = db.select({ count: sql<number>`count(*)` }).from(table);
    return (where ? query.where(where) : query).get()?.count ?? 0;
  }

  // ─── Users ───
  // 1 admin, 3 instructors (one of whom owns no courses, so the empty
  // instructor dashboard is reachable), and ~40 students.
  //
  // Students are split in two: the five named students below, who own all the
  // hand-written narrative data (comments, quiz attempts, ratings), and the
  // cohort generated further down, which supplies volume. Anything that picks a
  // student out of a list does it by email, never by array position — see
  // studentByEmail — so appending or inserting students never silently
  // re-points a coupon redemption at someone else.

  const [admin] = db
    .insert(schema.users)
    .values({
      name: "Alex Rivera",
      email: "alex.rivera@ralph.dev",
      role: UserRole.Admin,
      avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=alex",
      createdAt: daysAgo(120),
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
      createdAt: daysAgo(100),
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
      createdAt: daysAgo(95),
    })
    .returning()
    .all();

  // Owns no courses — the instructor views must survive an instructor with
  // nothing to show.
  const [instructor3] = db
    .insert(schema.users)
    .values({
      name: "Priya Nair",
      email: "priya.nair@ralph.dev",
      role: UserRole.Instructor,
      avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=priya",
      bio: "Accessibility engineer and design-systems consultant. Joined to teach, has not published a course yet.",
      createdAt: daysAgo(210),
    })
    .returning()
    .all();

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

  // The wider student body. These carry the bulk purchase and progress history
  // generated at the bottom of this file. Sign-up dates are spread across the
  // last twelve months, including the last few days.
  const cohortNames = [
    "Ava Nakamura", "Noah Blackwood", "Isla Fernandes", "Ethan Okafor",
    "Mia Lindqvist", "Lucas Moreau", "Zara Haddad", "Felix Andersen",
    "Nina Kowalski", "Omar Rahman", "Chloe Beaumont", "Dmitri Volkov",
    "Priya Raghavan", "Tomas Silva", "Hana Kim", "Gabriel Rossi",
    "Amara Diallo", "Jonas Weber", "Lena Petrova", "Kwame Mensah",
    "Sofia Ricci", "Aarav Shah", "Freya Nilsen", "Diego Castillo",
    "Yuki Tanaka", "Rosa Delgado", "Idris Bello", "Clara Hoffmann",
    "Mateo Alvarez", "Elif Demir", "Ruben Ortiz", "Anika Bose",
    "Caleb Ncube", "Marta Novak",
  ];

  const cohort = db
    .insert(schema.users)
    .values(
      cohortNames.map((name, i) => ({
        name,
        // Matches the named students above: first.last@student.dev.
        email: `${slugify(name).replace(/-/g, ".")}@student.dev`,
        role: UserRole.Student,
        avatarUrl: `https://api.dicebear.com/9.x/avataaars/svg?seed=${slugify(name)}`,
        // Spread across ~12 months, tightening towards today so the recent
        // ranges are populated. The last few sign up inside the last week.
        createdAt: daysAgo(Math.round(355 - i * 10.4)),
      }))
    )
    .returning()
    .all();

  // Every student, named and generated. Look students up by email rather than
  // by index — see the note in the users header.
  const allStudents = [...students, bossy, ...cohort];
  const studentsByEmail = new Map(allStudents.map((s) => [s.email, s]));

  function studentByEmail(email: string) {
    const student = studentsByEmail.get(email);
    if (!student) throw new Error(`No seeded student with email ${email}`);
    return student;
  }

  const instructorCount = 3;
  const studentCount = allStudents.length;

  console.log(
    `Created ${1 + instructorCount + studentCount} users (1 admin, ${instructorCount} instructors, ${studentCount} students).`
  );

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

  // ─── Course content ───

  type LessonSpec = {
    title: string;
    duration: number;
    videoUrl?: string;
    githubRepoUrl?: string;
    content?: string;
  };

  type ModuleSpec = { title: string; lessons: LessonSpec[] };

  // Inserts a course's modules and lessons in order and returns the lesson ids,
  // flattened module by module. Positions are 1-based.
  function insertCourseContent(
    courseId: number,
    moduleSpecs: ModuleSpec[],
    startDaysAgo: number
  ): number[] {
    const lessonIds: number[] = [];

    for (let mi = 0; mi < moduleSpecs.length; mi++) {
      const modData = moduleSpecs[mi];
      const [mod] = db
        .insert(schema.modules)
        .values({
          courseId,
          title: modData.title,
          position: mi + 1,
          createdAt: daysAgo(startDaysAgo - mi),
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
            createdAt: daysAgo(startDaysAgo - mi),
          })
          .returning()
          .all();
        lessonIds.push(lesson.id);
      }
    }

    return lessonIds;
  }

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
      createdAt: daysAgo(355),
      updatedAt: daysAgo(10),
    })
    .returning()
    .all();

  // Course 1 modules and lessons
  const c1Modules = [
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

  const course1LessonIds = insertCourseContent(course1.id, c1Modules, 350);

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
      createdAt: daysAgo(305),
      updatedAt: daysAgo(5),
    })
    .returning()
    .all();

  const c2Modules = [
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

  const course2LessonIds = insertCourseContent(course2.id, c2Modules, 300);

  console.log(
    `Created course "${course2.title}" with ${c2Modules.length} modules and ${course2LessonIds.length} lessons.`
  );

  // ─── Course 3: Design Systems with Tailwind (Sarah Chen) ───
  // A second selling course for Sarah, so the per-instructor views have more
  // than one row and revenue splits across courses.

  const [course3] = db
    .insert(schema.courses)
    .values({
      title: "Design Systems with Tailwind",
      slug: "design-systems-with-tailwind",
      description:
        "Build a design system that survives contact with a real product team. Tokens, component APIs, theming, and the discipline that keeps a system from rotting into a component graveyard.",
      salesCopy: `## Design Systems That Survive

Most design systems die the same way: a beautiful component library nobody uses, drifting out of sync with the product it was meant to serve.

This course is about the other kind — the system your team reaches for because it is faster than not using it.

### What You'll Learn

- **Design tokens** — colour, spacing and type scales that mean something
- **Component APIs** — variants that compose instead of multiplying
- **Theming** — light, dark, and brand themes without a fork
- **Governance** — how changes land without breaking every consumer

## Who Is This For?

Frontend developers who have built components before and watched the collection turn into a mess. Tailwind experience helps but is not required.`,
      instructorId: instructor1.id,
      categoryId: catBySlug["design"].id,
      status: CourseStatus.Published,
      coverImageUrl: "/images/course-typescript.svg",
      price: 3999,
      createdAt: daysAgo(200),
      updatedAt: daysAgo(14),
    })
    .returning()
    .all();

  const course3LessonIds = insertCourseContent(
    course3.id,
    [
      {
        title: "Foundations",
        lessons: [
          {
            title: "What a Design System Is For",
            duration: 9,
            videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
            content:
              "## What a Design System Is For\n\nA design system is a shared vocabulary, not a component folder. This lesson covers what belongs in one and — more usefully — what does not.",
          },
          {
            title: "Design Tokens",
            duration: 14,
            videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
            content:
              "## Design Tokens\n\nColour, spacing, radius and type scales expressed as named values, so a change lands in one place instead of two hundred.",
          },
          {
            title: "Spacing and Type Scales",
            duration: 12,
            videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
            content:
              "## Scales\n\nWhy a constrained scale produces better layouts than free choice, and how to pick one you can live with.",
          },
        ],
      },
      {
        title: "Components",
        lessons: [
          {
            title: "Variants and Composition",
            duration: 18,
            videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
            githubRepoUrl:
              "https://github.com/total-typescript/design-system-variants",
            content:
              "## Variants\n\nA variant API that composes beats one that enumerates. We build a button whose options multiply without the source doing the same.",
          },
          {
            title: "Accessible Primitives",
            duration: 16,
            videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
            content:
              "## Accessible Primitives\n\nFocus management, keyboard interaction and ARIA — handled once in the primitive rather than in every consumer.",
          },
          {
            title: "Theming and Dark Mode",
            duration: 15,
            videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
            content:
              "## Theming\n\nOne set of components, several themes, no forks. CSS custom properties do most of the work.",
          },
        ],
      },
      {
        title: "Living With It",
        lessons: [
          {
            title: "Documentation That Gets Read",
            duration: 11,
            videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
            content:
              "## Documentation\n\nDocs next to the code, examples that run, and the one page every new team member actually opens.",
          },
          {
            title: "Versioning and Breaking Changes",
            duration: 13,
            videoUrl: "https://www.youtube.com/watch?v=zQnBQ4tB3ZA",
            content:
              "## Breaking Changes\n\nHow to ship a breaking change to twelve teams without becoming the reason they fork.",
          },
          {
            title: "Course Wrap-Up",
            duration: 6,
            content:
              "## Wrap-Up\n\nYou have a token layer, a component API you can defend, and a story for how changes land. Go and delete some CSS.",
          },
        ],
      },
    ],
    195
  );

  console.log(
    `Created course "${course3.title}" with 3 modules and ${course3LessonIds.length} lessons.`
  );

  // ─── Course 4: Practical Data Visualisation (Marcus Johnson) ───
  // Published but has never sold. The analytics views must render a course with
  // zero revenue, zero enrolments and zero progress without dividing by it.

  const [course4] = db
    .insert(schema.courses)
    .values({
      title: "Practical Data Visualisation",
      slug: "practical-data-visualisation",
      description:
        "Turn data into charts people can actually read. Chart selection, scales, colour, and the accessibility rules most dashboards break.",
      salesCopy: `## Charts People Can Read

A chart is an argument. This course is about making the argument clearly — picking the right encoding, scaling it honestly, and colouring it so everyone can read it.

### Topics

- Choosing an encoding that matches the question
- Scales, axes, and the zero-baseline argument
- Colour palettes that survive colour blindness
- Annotating a chart so it needs no caption

## Who Is This For?

Developers and analysts who produce charts for other people to act on.`,
      instructorId: instructor2.id,
      categoryId: catBySlug["data-science"].id,
      status: CourseStatus.Published,
      coverImageUrl: "/images/course-nodejs.svg",
      price: 4499,
      createdAt: daysAgo(40),
      updatedAt: daysAgo(6),
    })
    .returning()
    .all();

  const course4LessonIds = insertCourseContent(
    course4.id,
    [
      {
        title: "Choosing a Chart",
        lessons: [
          {
            title: "Encodings and What They Say",
            duration: 12,
            videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
            content:
              "## Encodings\n\nPosition beats length beats angle beats area. Pick the strongest encoding the question allows.",
          },
          {
            title: "Time Series Done Right",
            duration: 14,
            videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
            content:
              "## Time Series\n\nRanges, resampling, and why a 30-day and a 90-day view of the same data should not look identical.",
          },
          {
            title: "Distributions",
            duration: 13,
            videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
            content:
              "## Distributions\n\nHistograms, box plots, and the mean hiding a bimodal population.",
          },
        ],
      },
      {
        title: "Making It Readable",
        lessons: [
          {
            title: "Scales and Axes",
            duration: 11,
            videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
            content:
              "## Scales\n\nWhen truncating an axis is honest, and when it is a lie with a legend.",
          },
          {
            title: "Colour and Accessibility",
            duration: 15,
            videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
            content:
              "## Colour\n\nSequential, diverging and categorical palettes, checked against the three common forms of colour blindness.",
          },
          {
            title: "Annotation and Narrative",
            duration: 10,
            content:
              "## Annotation\n\nThe label on the spike is doing more work than the spike.",
          },
        ],
      },
    ],
    35
  );

  console.log(
    `Created course "${course4.title}" with 2 modules and ${course4LessonIds.length} lessons (published, no sales).`
  );

  // ─── Course 5: Shipping with Docker and Kubernetes (Marcus Johnson) ───
  // Draft — never appears in the catalogue, and must be excluded from published
  // course counts and revenue.

  const [course5] = db
    .insert(schema.courses)
    .values({
      title: "Shipping with Docker and Kubernetes",
      slug: "shipping-with-docker-and-kubernetes",
      description:
        "Containerise an application and run it on Kubernetes without cargo-culting a YAML file you do not understand.",
      salesCopy: `## From Laptop to Cluster

Containers made deployment reproducible and Kubernetes made it configurable. This course covers both without pretending either is simple.

### Topics

- Writing a Dockerfile that builds fast and ships small
- Pods, deployments, services — what each one is actually for
- Config, secrets and the twelve-factor bits that matter
- Rolling out a change and rolling it back

## Status

This course is still in draft while the cluster examples are rewritten against the current API.`,
      instructorId: instructor2.id,
      categoryId: catBySlug["devops"].id,
      status: CourseStatus.Draft,
      coverImageUrl: "/images/course-nodejs.svg",
      price: 5499,
      createdAt: daysAgo(18),
      updatedAt: daysAgo(2),
    })
    .returning()
    .all();

  const course5LessonIds = insertCourseContent(
    course5.id,
    [
      {
        title: "Containers",
        lessons: [
          {
            title: "Why Containers",
            duration: 8,
            videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
            content:
              "## Why Containers\n\nThe problem containers solve, stated precisely enough to know when you do not have it.",
          },
          {
            title: "Writing a Dockerfile",
            duration: 17,
            videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
            content:
              "## Dockerfiles\n\nLayer caching, multi-stage builds, and getting the image under a hundred megabytes.",
          },
          {
            title: "Images and Registries",
            duration: 12,
            content:
              "## Registries\n\nTagging, pushing, and why `latest` is not a version.",
          },
        ],
      },
      {
        title: "Kubernetes Basics",
        lessons: [
          {
            title: "Pods, Deployments, Services",
            duration: 19,
            videoUrl: "https://www.youtube.com/watch?v=lsMQRaeKNDk",
            content:
              "## The Core Objects\n\nThree objects explain most of Kubernetes. This lesson is those three.",
          },
          {
            title: "Config and Secrets",
            duration: 14,
            content:
              "## Config\n\nConfigMaps, Secrets, and keeping environment differences out of the image.",
          },
        ],
      },
    ],
    15
  );

  console.log(
    `Created course "${course5.title}" with 2 modules and ${course5LessonIds.length} lessons (draft).`
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

  // Quiz 2: Generics Quiz (attached to "Generics Basics", lesson index 5 in course 1)
  const [quiz2] = db
    .insert(schema.quizzes)
    .values({
      lessonId: course1LessonIds[7], // "Generics Basics" (module 3, lesson 2)
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

  console.log(
    `Created ${countRows(schema.quizzes)} quizzes with ${countRows(schema.quizQuestions)} questions and ${countRows(schema.quizOptions)} options.`
  );

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

  console.log(`Created ${countRows(schema.enrollments)} enrollments.`);

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

  console.log(`Created ${countRows(schema.courseRatings)} course ratings.`);

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

  console.log(
    `Created ${countRows(schema.comments)} lesson comments across ${countRows(schema.comments, isNull(schema.comments.parentId))} threads.`
  );

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

  console.log(`Created ${countRows(schema.lessonProgress)} lesson progress records.`);

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

  console.log(
    `Created ${countRows(schema.quizAttempts)} quiz attempts and ${countRows(schema.quizAnswers)} answers.`
  );

  // ─── Video Watch Events ───
  //
  // The only event types the player emits are `play`, `pause`, `ended` and
  // `progress` — see app/components/youtube-player.tsx. `progress` is the
  // heartbeat it posts every 10 seconds while the video is playing, so in real
  // data it outnumbers every other type by an order of magnitude. Seed nothing
  // the player cannot produce, and never a watch session without heartbeats.

  const HEARTBEAT_INTERVAL_SECONDS = 10;

  type WatchEventRow = typeof schema.videoWatchEvents.$inferInsert;

  const watchEventRows: WatchEventRow[] = [];

  function addWatchEvent(
    userId: number,
    lessonId: number,
    eventType: string,
    positionSeconds: number,
    eventHoursAgo: number
  ) {
    watchEventRows.push({
      userId,
      lessonId,
      eventType,
      positionSeconds,
      createdAt: hoursAgo(eventHoursAgo),
    });
  }

  // One watch session: `play`, a `progress` heartbeat every 10 seconds of
  // playback, then `ended` if they reached the end or `pause` if they stopped
  // short. Clock time advances with playback position, as it does in real life.
  function addWatchSession(
    userId: number,
    lessonId: number,
    fromSeconds: number,
    toSeconds: number,
    videoDurationSeconds: number,
    startHoursAgo: number
  ) {
    // Clock time runs backwards from startHoursAgo as playback advances.
    const hoursAgoAt = (position: number) =>
      startHoursAgo - (position - fromSeconds) / 3600;

    addWatchEvent(userId, lessonId, "play", fromSeconds, startHoursAgo);

    for (
      let pos = fromSeconds + HEARTBEAT_INTERVAL_SECONDS;
      pos < toSeconds;
      pos += HEARTBEAT_INTERVAL_SECONDS
    ) {
      addWatchEvent(userId, lessonId, "progress", pos, hoursAgoAt(pos));
    }

    const reachedEnd = toSeconds >= videoDurationSeconds;
    addWatchEvent(
      userId,
      lessonId,
      reachedEnd ? "ended" : "pause",
      toSeconds,
      hoursAgoAt(toSeconds)
    );
  }

  // Emma watched course 1 lesson 1 (8 min video) in two sittings.
  addWatchSession(students[0].id, course1LessonIds[0], 0, 180, 480, 50 * 24);
  addWatchSession(students[0].id, course1LessonIds[0], 180, 480, 480, 49 * 24);

  // James watched it straight through.
  addWatchSession(students[1].id, course1LessonIds[0], 0, 480, 480, 45 * 24);

  // Liam started course 2 lesson 1 and gave up six minutes in.
  addWatchSession(students[3].id, course2LessonIds[0], 0, 300, 600, 22 * 24);
  addWatchSession(students[3].id, course2LessonIds[0], 300, 360, 600, 21 * 24);

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

  console.log(`Created ${countRows(schema.purchases)} individual purchases.`);

  // ─── Teams, Team Members, and Coupons ───
  // Bossy McBossface bought 5 team seats for course 2; Olivia and Liam redeemed coupons

  const [team1] = db
    .insert(schema.teams)
    .values({ createdAt: daysAgo(30) })
    .returning()
    .all();

  db.insert(schema.teamMembers)
    .values({
      teamId: team1.id,
      userId: bossy.id,
      role: TeamMemberRole.Admin,
      createdAt: daysAgo(30),
    })
    .run();

  // Team purchase by Bossy McBossface for course 2 (5 seats)
  const [teamPurchase] = db
    .insert(schema.purchases)
    .values({
      userId: bossy.id,
      courseId: course2.id,
      amountPaid: 5999 * 5,
      country: "US",
      createdAt: daysAgo(30),
    })
    .returning()
    .all();

  // Generate 5 coupons for the team purchase
  const couponCodes = [
    "TEAM-NODEJS-A1B2C3",
    "TEAM-NODEJS-D4E5F6",
    "TEAM-NODEJS-G7H8I9",
    "TEAM-NODEJS-J0K1L2",
    "TEAM-NODEJS-M3N4O5",
  ];

  const seededCoupons = db
    .insert(schema.coupons)
    .values(
      couponCodes.map((code) => ({
        teamId: team1.id,
        courseId: course2.id,
        code,
        purchaseId: teamPurchase.id,
        createdAt: daysAgo(30),
      }))
    )
    .returning()
    .all();

  // Redeem 2 of the 5 coupons. Redeemers are named by email, not by position in
  // the students array — position would silently re-point these redemptions at
  // different people the moment a student is inserted rather than appended.
  // Both already have an enrolment for course 2 from the enrolments section.
  db.update(schema.coupons)
    .set({
      redeemedByUserId: studentByEmail("olivia.martinez@student.dev").id,
      redeemedAt: daysAgo(30),
    })
    .where(eq(schema.coupons.id, seededCoupons[0].id))
    .run();

  db.update(schema.coupons)
    .set({
      redeemedByUserId: studentByEmail("liam.thompson@student.dev").id,
      redeemedAt: daysAgo(25),
    })
    .where(eq(schema.coupons.id, seededCoupons[1].id))
    .run();

  console.log(
    `Created 1 team with Bossy McBossface as admin, 1 team purchase, and ${seededCoupons.length} coupons (${countRows(schema.coupons, isNotNull(schema.coupons.redeemedByUserId))} redeemed, ${countRows(schema.coupons, isNull(schema.coupons.redeemedByUserId))} available).`
  );

  // ─── Generated history ───
  //
  // Everything above is hand-written narrative data: a handful of students whose
  // comments, quiz attempts and ratings are written one by one. Everything below
  // is the bulk history the analytics work is evaluated against — roughly twelve
  // months of purchases, enrolments, progress and watch events for the cohort.
  //
  // Generated from a fixed PRNG seed, so every run produces the same database and
  // a number read off the dashboard can be checked against a number computed
  // here.

  const random = makeRandom(20260731);

  const lessonDurationSeconds = new Map(
    db
      .select({
        id: schema.lessons.id,
        durationMinutes: schema.lessons.durationMinutes,
      })
      .from(schema.lessons)
      .all()
      .map((l) => [l.id, (l.durationMinutes ?? 10) * 60] as const)
  );

  // ─── Drop-off cliffs ───
  //
  // Progress is not spread evenly through a course. Each course has two lessons
  // where a large share of students stop for good, and the analytics work is
  // expected to surface exactly these lessons. They are, by lesson index
  // (0-based, in course order):
  //
  //   Course 1 — Introduction to TypeScript
  //     index 8  "Generics Basics"                 — first cliff
  //     index 13 "Mapped Types"                    — second cliff
  //
  //   Course 2 — Building REST APIs with Node.js
  //     index 5  "Custom Middleware"               — first cliff
  //     index 11 "Transactions"                    — second cliff
  //
  //   Course 3 — Design Systems with Tailwind
  //     index 3  "Variants and Composition"        — first cliff
  //     index 6  "Documentation That Gets Read"    — second cliff
  //
  // Assert against the lessons, not against a drop-off percentage. Each enrolment
  // rolls: 12% never start, 38% stop at the first cliff, 22% at the second, 13%
  // finish, and the remaining 15% stop at a uniformly random lesson — so the
  // cliffs stand out against a noisy background rather than being the only
  // stopping points. Those are per-enrolment odds, not the share of students who
  // reach a given lesson: because students who stop at the first cliff never
  // reach the second, the observed drop-off at each cliff is much steeper than
  // its roll.

  type SellableCourse = {
    course: typeof course1;
    lessonIds: number[];
    // [bigCliffIndex, secondCliffIndex] — the lesson a stopping student last
    // completed.
    cliffs: [number, number];
  };

  const sellableCourses: SellableCourse[] = [
    { course: course1, lessonIds: course1LessonIds, cliffs: [8, 13] },
    { course: course2, lessonIds: course2LessonIds, cliffs: [5, 11] },
    { course: course3, lessonIds: course3LessonIds, cliffs: [3, 6] },
  ];

  const fullPriceCountries = ["US", "GB", "DE", "CA", "AU", "NL"];
  const pppCountries = ["IN", "BR", "PH", "NG", "ID", "VN"];

  const sold = new Set<string>();
  let generatedPurchases = 0;
  let generatedEnrollments = 0;
  let generatedProgressRows = 0;

  // A student buys, enrols, and works through the course as far as they get.
  // Returns false if there was nothing they could have bought on that day — a
  // course cannot be sold before it was created, and nobody buys twice.
  function buyCourse(
    buyer: (typeof cohort)[number],
    purchasedDaysAgo: number
  ): boolean {
    const purchasedAt = Date.parse(daysAgo(purchasedDaysAgo));

    const available = sellableCourses.filter(
      (c) =>
        Date.parse(c.course.createdAt) <= purchasedAt &&
        !sold.has(`${buyer.id}:${c.course.id}`)
    );

    if (available.length === 0) return false;

    const target = available[Math.floor(random() * available.length)];
    sold.add(`${buyer.id}:${target.course.id}`);

    // Two in five buy at a parity-adjusted price.
    const ppp = random() < 0.4;
    const country = ppp
      ? pppCountries[Math.floor(random() * pppCountries.length)]
      : fullPriceCountries[Math.floor(random() * fullPriceCountries.length)];
    const amountPaid = ppp
      ? Math.round((target.course.price * 0.5) / 100) * 100
      : target.course.price;

    db.insert(schema.purchases)
      .values({
        userId: buyer.id,
        courseId: target.course.id,
        amountPaid,
        country,
        createdAt: daysAgo(purchasedDaysAgo),
      })
      .run();
    generatedPurchases++;

    db.insert(schema.enrollments)
      .values({
        userId: buyer.id,
        courseId: target.course.id,
        enrolledAt: daysAgo(purchasedDaysAgo),
      })
      .run();
    generatedEnrollments++;

    generatedProgressRows += generateProgress(
      buyer.id,
      target,
      purchasedDaysAgo
    );

    return true;
  }

  const signupDaysAgo = (student: (typeof cohort)[number]) =>
    Math.round((Date.now() - Date.parse(student.createdAt)) / 86_400_000);

  // Purchases hang off sign-up dates, which already span the year: everyone buys
  // something within days of joining, and about two in five come back for a
  // second course a few months later.
  for (const buyer of cohort) {
    const joined = signupDaysAgo(buyer);

    buyCourse(buyer, Math.max(0, joined - Math.floor(random() * 4)));

    if (random() < 0.42) {
      buyCourse(buyer, Math.max(1, joined - 90 - Math.floor(random() * 20)));
    }
  }

  // Launch week: a burst of sales from long-standing students inside the last
  // seven days, so the short date ranges are never empty and never identical to
  // the long ones.
  const launchWeekDays = [7, 6, 5, 3, 2, 1];
  const longStanding = cohort.filter((s) => signupDaysAgo(s) > 60);

  for (let i = 0; i < launchWeekDays.length; i++) {
    buyCourse(longStanding[i % longStanding.length], launchWeekDays[i]);
  }

  // Walks a student through a course as far as they got, leaving the lesson
  // after their last completed one in progress. Returns the number of rows
  // written.
  function generateProgress(
    userId: number,
    target: SellableCourse,
    startedDaysAgo: number
  ): number {
    const { lessonIds, cliffs } = target;
    const lastIndex = lessonIds.length - 1;

    const roll = random();
    let stopIndex: number;

    if (roll < 0.12) {
      // Bought it and never opened it.
      return 0;
    } else if (roll < 0.5) {
      stopIndex = cliffs[0];
    } else if (roll < 0.72) {
      stopIndex = cliffs[1];
    } else if (roll < 0.85) {
      stopIndex = lastIndex;
    } else {
      stopIndex = Math.floor(random() * lessonIds.length);
    }

    // Progress is made over the days following the purchase, and never in the
    // future.
    const daySpan = Math.min(startedDaysAgo, 30);
    let rows = 0;

    for (let li = 0; li <= stopIndex; li++) {
      const completedDaysAgo = Math.max(
        0,
        Math.round(startedDaysAgo - (daySpan * li) / lessonIds.length)
      );
      db.insert(schema.lessonProgress)
        .values({
          userId,
          lessonId: lessonIds[li],
          status: LessonProgressStatus.Completed,
          completedAt: daysAgo(completedDaysAgo),
        })
        .run();
      rows++;

      // The lesson they stopped on is left half-watched: a session that never
      // reached the end, heartbeats and all.
      if (li === stopIndex) {
        const duration = lessonDurationSeconds.get(lessonIds[li]) ?? 600;
        addWatchSession(
          userId,
          lessonIds[li],
          0,
          duration,
          duration,
          completedDaysAgo * 24 + 1
        );
      }
    }

    if (stopIndex < lastIndex) {
      const nextLessonId = lessonIds[stopIndex + 1];
      db.insert(schema.lessonProgress)
        .values({
          userId,
          lessonId: nextLessonId,
          status: LessonProgressStatus.InProgress,
        })
        .run();
      rows++;

      const duration = lessonDurationSeconds.get(nextLessonId) ?? 600;
      const abandonedAt = Math.round(duration * (0.1 + random() * 0.5));
      addWatchSession(
        userId,
        nextLessonId,
        0,
        abandonedAt,
        duration,
        Math.max(1, Math.round(startedDaysAgo * 24 * 0.4))
      );
    }

    return rows;
  }

  console.log(
    `Created ${generatedPurchases} generated purchases, ${generatedEnrollments} enrolments and ${generatedProgressRows} lesson progress rows.`
  );

  // ─── Further team purchases ───
  // Two more seat purchases so team revenue is not a single row, in mixed
  // redemption states: one team most of the way through its seats, one that has
  // bought and redeemed nothing yet.

  function createTeamPurchase(
    adminEmail: string,
    course: typeof course1,
    seats: number,
    codePrefix: string,
    purchasedDaysAgo: number,
    redeemerEmails: string[]
  ) {
    const teamAdmin = studentByEmail(adminEmail);

    const [team] = db
      .insert(schema.teams)
      .values({ createdAt: daysAgo(purchasedDaysAgo) })
      .returning()
      .all();

    db.insert(schema.teamMembers)
      .values({
        teamId: team.id,
        userId: teamAdmin.id,
        role: TeamMemberRole.Admin,
        createdAt: daysAgo(purchasedDaysAgo),
      })
      .run();

    const [purchase] = db
      .insert(schema.purchases)
      .values({
        userId: teamAdmin.id,
        courseId: course.id,
        amountPaid: course.price * seats,
        country: "US",
        createdAt: daysAgo(purchasedDaysAgo),
      })
      .returning()
      .all();

    const teamCoupons = db
      .insert(schema.coupons)
      .values(
        Array.from({ length: seats }, (_, i) => ({
          teamId: team.id,
          courseId: course.id,
          code: `${codePrefix}-${String(i + 1).padStart(2, "0")}`,
          purchaseId: purchase.id,
          createdAt: daysAgo(purchasedDaysAgo),
        }))
      )
      .returning()
      .all();

    // Redeemers named by email, for the reason given at the first team above.
    redeemerEmails.forEach((email, i) => {
      const redeemer = studentByEmail(email);
      const redeemedDaysAgo = Math.max(0, purchasedDaysAgo - (i + 1) * 2);

      db.update(schema.coupons)
        .set({
          redeemedByUserId: redeemer.id,
          redeemedAt: daysAgo(redeemedDaysAgo),
        })
        .where(eq(schema.coupons.id, teamCoupons[i].id))
        .run();

      db.insert(schema.teamMembers)
        .values({
          teamId: team.id,
          userId: redeemer.id,
          role: TeamMemberRole.Member,
          createdAt: daysAgo(redeemedDaysAgo),
        })
        .run();

      db.insert(schema.enrollments)
        .values({
          userId: redeemer.id,
          courseId: course.id,
          enrolledAt: daysAgo(redeemedDaysAgo),
        })
        .run();
    });

    return { team, purchase, coupons: teamCoupons };
  }

  // Eight seats on TypeScript, six redeemed.
  createTeamPurchase(
    "ava.nakamura@student.dev",
    course1,
    8,
    "TEAM-TS-NAKAMURA",
    120,
    [
      "noah.blackwood@student.dev",
      "isla.fernandes@student.dev",
      "ethan.okafor@student.dev",
      "mia.lindqvist@student.dev",
      "lucas.moreau@student.dev",
      "zara.haddad@student.dev",
    ]
  );

  // Four seats on Design Systems, bought during launch week, none redeemed yet.
  createTeamPurchase(
    "marta.novak@student.dev",
    course3,
    4,
    "TEAM-DS-NOVAK",
    4,
    []
  );

  // ─── Flush watch events ───
  // Batched: the heartbeat makes these by far the largest table, and one
  // statement per row would dominate the seed's runtime.

  const WATCH_EVENT_CHUNK = 400;
  for (let i = 0; i < watchEventRows.length; i += WATCH_EVENT_CHUNK) {
    db.insert(schema.videoWatchEvents)
      .values(watchEventRows.slice(i, i + WATCH_EVENT_CHUNK))
      .run();
  }

  console.log(`Created ${watchEventRows.length} video watch events.`);

  // ─── Summary ───

  const sevenDaysAgo = daysAgo(7);
  const oldestPurchase =
    db
      .select({ createdAt: sql<string>`min(${schema.purchases.createdAt})` })
      .from(schema.purchases)
      .get()?.createdAt ?? new Date().toISOString();
  const historyDays = Math.round(
    (Date.now() - Date.parse(oldestPurchase)) / 86_400_000
  );

  console.log("\n✓ Seed complete!");
  console.log(
    `  Users: ${countRows(schema.users)} (${countRows(schema.users, eq(schema.users.role, UserRole.Admin))} admin, ${countRows(schema.users, eq(schema.users.role, UserRole.Instructor))} instructors, ${countRows(schema.users, eq(schema.users.role, UserRole.Student))} students)`
  );
  console.log(`  Categories: ${countRows(schema.categories)}`);
  console.log(
    `  Courses: ${countRows(schema.courses)} (${countRows(schema.courses, eq(schema.courses.status, CourseStatus.Published))} published, ${countRows(schema.courses, eq(schema.courses.status, CourseStatus.Draft))} draft)`
  );
  console.log(
    `  Modules: ${countRows(schema.modules)}, lessons: ${countRows(schema.lessons)}`
  );
  console.log(
    `  Quizzes: ${countRows(schema.quizzes)}, attempts: ${countRows(schema.quizAttempts)}`
  );
  console.log(`  Enrollments: ${countRows(schema.enrollments)}`);
  console.log(`  Course ratings: ${countRows(schema.courseRatings)}`);
  console.log(`  Lesson comments: ${countRows(schema.comments)}`);
  console.log(
    `  Lesson progress: ${countRows(schema.lessonProgress)} (${countRows(schema.lessonProgress, eq(schema.lessonProgress.status, LessonProgressStatus.Completed))} completed)`
  );
  console.log(
    `  Video watch events: ${countRows(schema.videoWatchEvents)} (${countRows(schema.videoWatchEvents, eq(schema.videoWatchEvents.eventType, "progress"))} progress heartbeats)`
  );
  console.log(
    `  Purchases: ${countRows(schema.purchases)} (${countRows(schema.purchases, gte(schema.purchases.createdAt, sevenDaysAgo))} in the last 7 days), spanning ${historyDays} days`
  );
  console.log(
    `  Teams: ${countRows(schema.teams)}, coupons: ${countRows(schema.coupons)} (${countRows(schema.coupons, isNotNull(schema.coupons.redeemedByUserId))} redeemed)`
  );
}

seed().catch(console.error);
