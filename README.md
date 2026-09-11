# ProjectFlow

ProjectFlow is a lightweight project and task tracker for software teams.
Organizations own projects, projects own tasks, and tasks carry a status, a
priority and a discussion thread.

It is a TypeScript monorepo: a NestJS + MongoDB API and a Next.js App Router
frontend, sharing a small package of domain types and enums.

**Also in this repository**

- [`ASSESSMENT_NOTES.md`](./ASSESSMENT_NOTES.md) — architecture, decisions and
  ambiguities, risks, a code review, and notes on scaling.
- [`BUG_REPORT.md`](./BUG_REPORT.md) — the two defects found and fixed.
- [`AI_LOG.md`](./AI_LOG.md) — where AI assistance was used, and where it was
  overridden.

---

## Technology stack

| Area         | Choice                                           |
| ------------ | ------------------------------------------------ |
| Monorepo     | pnpm workspaces + Turborepo                      |
| Language     | TypeScript 5.9                                   |
| API          | NestJS 11, Mongoose 8, MongoDB                   |
| Auth         | JWT bearer tokens, bcrypt password hashing       |
| Web          | Next.js 16 (App Router), React 19                |
| Styling      | Tailwind CSS 4, Radix primitives, Phosphor Icons |
| Server state | TanStack Query 5                                 |
| Forms        | React Hook Form + Zod                            |
| Testing      | Jest, Supertest, mongodb-memory-server           |

---

## Prerequisites

- **Node.js 20.19+** (22 or 24 recommended)
- **pnpm 10+** — `npm install -g pnpm`
- **MongoDB 7+** running locally

On macOS:

```bash
brew tap mongodb/brew
brew install mongodb-community@7.0
brew services start mongodb-community@7.0
```

Any reachable MongoDB works — point `MONGODB_URI` wherever you like.

---

## Installation

```bash
pnpm install
```

## Environment setup

Configuration lives in a single `.env` file at the repository root; both apps
read it.

```bash
cp .env.example .env
```

| Variable              | Purpose                          | Default                                 |
| --------------------- | -------------------------------- | --------------------------------------- |
| `MONGODB_URI`         | MongoDB connection string        | `mongodb://127.0.0.1:27017/projectflow` |
| `JWT_SECRET`          | Signing secret for access tokens | — (required)                            |
| `JWT_EXPIRES_IN`      | Access token lifetime            | `7d`                                    |
| `API_PORT`            | Port the API listens on          | `4732`                                  |
| `WEB_ORIGIN`          | Origin allowed by CORS           | `http://localhost:3742`                 |
| `NEXT_PUBLIC_API_URL` | API base URL used by the browser | `http://localhost:4732`                 |

The API refuses to boot if `MONGODB_URI` or `JWT_SECRET` is missing.

## Database

Make sure MongoDB is running, then load development data:

```bash
pnpm seed
```

The seed is repeatable — it clears the ProjectFlow collections and reinserts a
fresh organization, users, projects, tasks and comments.

## Running the apps

```bash
pnpm dev
```

- Web — <http://localhost:3742>
- API — <http://localhost:4732>

Both apps deliberately avoid the usual 3000/4000 defaults so they do not clash
with other projects. To move the web app, set `WEB_PORT` in your shell and
update `WEB_ORIGIN` in `.env` to match, so CORS keeps working:

```bash
WEB_PORT=3800 pnpm --filter @projectflow/web dev
```

The API port comes from `API_PORT` in `.env`; change `NEXT_PUBLIC_API_URL` to
match if you move it.

Run one at a time if you prefer:

```bash
pnpm --filter @projectflow/api dev
pnpm --filter @projectflow/web dev
```

## From a clean checkout

```bash
pnpm install
cp .env.example .env
pnpm seed
pnpm dev
```

---

## Commands

| Command          | Description                                |
| ---------------- | ------------------------------------------ |
| `pnpm dev`       | Run the API and web app in watch mode      |
| `pnpm build`     | Build every package and app                |
| `pnpm lint`      | ESLint across the workspace                |
| `pnpm typecheck` | TypeScript project-wide, no emit           |
| `pnpm test`      | API test suite (uses an in-memory MongoDB) |
| `pnpm seed`      | Reset and reload development data          |
| `pnpm format`    | Prettier write                             |

---

## Tests

```bash
pnpm test                                  # the whole suite
pnpm --filter @projectflow/api test        # same, explicitly
pnpm --filter @projectflow/api test -- task-assignee   # one suite
```

No running MongoDB is required — the suite starts a throwaway in-memory server
for the duration of the run. The first run downloads a MongoDB binary (around
100 MB) and caches it, so expect it to be slower.

The tests are end-to-end: a real Nest application, real HTTP requests through
Supertest, and a real database. Each test resets the collections first, so
suites are independent and order does not matter.

| Suite                       | Covers                                                   |
| --------------------------- | -------------------------------------------------------- |
| `auth.e2e.spec.ts`          | Registration, login, token handling, `/auth/me`          |
| `projects.e2e.spec.ts`      | Project access, membership, organization-role escalation |
| `tasks.e2e.spec.ts`         | Task CRUD, status changes, numbering under concurrency   |
| `task-assignee.e2e.spec.ts` | Assignment rules, membership enforcement, unassignment   |
| `task-activity.e2e.spec.ts` | Activity shape, ordering, pagination, authorization      |
| `comments.e2e.spec.ts`      | Comment creation and listing                             |

Two of these are regression tests for the defects described in
[`BUG_REPORT.md`](./BUG_REPORT.md) — a non-member being refused a status change,
and ten concurrent creates receiving ten distinct task numbers. Both were
confirmed to fail against the original code before the fixes landed.

Note that the in-memory server runs standalone, not as a replica set, so
transactions are unavailable in tests. That constraint shaped the task-numbering
fix; see [Technical decisions](#technical-decisions).

---

## Development credentials

Seeded accounts, all sharing the password `Password123!`:

| Name         | Email                 | Access                    |
| ------------ | --------------------- | ------------------------- |
| Ammar Yaser  | `ammar@example.com`   | Organization owner        |
| Sarah Ahmed  | `sarah@example.com`   | Organization admin        |
| Ahmed Hassan | `ahmed@example.com`   | Project manager on `ENG`  |
| Magd Ali     | `magd@example.com`    | Member of `ENG` and `WEB` |
| Outside User | `outside@example.com` | No organization           |

These are local development accounts only.

---

## Architecture

```
projectflow/
├── apps/
│   ├── api/                     NestJS API
│   │   ├── src/
│   │   │   ├── auth/            register / login / current user
│   │   │   ├── users/
│   │   │   ├── organizations/
│   │   │   ├── organization-members/
│   │   │   ├── projects/        projects + ProjectAccessService
│   │   │   ├── project-members/
│   │   │   ├── tasks/
│   │   │   ├── comments/
│   │   │   ├── activity/        task activity history
│   │   │   ├── common/          guards, decorators, filters, shared DTOs
│   │   │   └── database/seed.ts
│   │   └── test/                e2e suites and fixtures
│   │
│   └── web/                     Next.js App Router frontend
│       └── src/
│           ├── app/             routes and layouts
│           ├── components/      design system primitives + app shell
│           ├── features/        auth, projects, tasks, comments
│           ├── lib/             API client, query keys, formatting
│           └── providers/       TanStack Query provider
│
└── packages/
    ├── shared/                  enums, constants, API response types
    ├── eslint-config/           flat ESLint configs
    └── tsconfig/                base TypeScript configs
```

### API layering

Each module follows the same shape: controller → service → Mongoose model, with
DTOs validating input at the boundary. Controllers stay thin; business rules
live in services.

### Domain model

```
User
Organization        ── OrganizationMember ── User      (OWNER | ADMIN | MEMBER)
Organization  ── Project
Project             ── ProjectMember      ── User      (PROJECT_MANAGER | MEMBER)
Project       ── Task ── Comment
Task          ── TaskActivity
Project       ── TaskCounter                           (one document per project)
```

Membership is stored in its own collection rather than as arrays on the parent
document, so it can be indexed and queried directly. Both membership
collections carry a unique compound index on their two foreign keys.

Tasks are numbered per project and identified by a human-readable key derived
from the project key: `ENG-1`, `ENG-2`, `WEB-1`.

A task carries both `createdBy` and `assignee`, and they are deliberately
distinct: `createdBy` is required and never changes, `assignee` is nullable and
changes often.

`task_activities` is an append-only log of task changes. Today it records
assignee transitions only. `fromUserId` and `toUserId` are both nullable, which
is what lets one row shape express all three transitions — assigned
(`null → user`), reassigned (`user → user`) and unassigned (`user → null`).

`task_counters` holds one document per project with the highest task number
issued so far. It is not a domain entity; it exists to make number allocation
atomic.

Indexes beyond the defaults:

```
tasks             { projectId, number }  unique
                  { projectId, status }
                  { projectId, assignee }
                  { createdAt: -1 }
task_activities   { taskId, createdAt: -1, _id: -1 }
task_counters     { projectId }          unique
```

### Authorization

`ProjectAccessService` answers "may this user touch this project?" in one
place. Access comes from either an elevated organization role (`OWNER` or
`ADMIN`, which grants access to every project in the organization) or an
explicit project membership row. `assertCanView` gates reads, `assertCanManage`
gates configuration and membership changes.

Authentication is a JWT bearer token. `JwtAuthGuard` is registered globally;
routes opt out with the `@Public()` decorator.

Rules narrower than view/manage live in the service that owns the action.
Assignment is the main example:

- Only members of a task's project may be assigned to it.
- `OWNER`, `ADMIN` and a project's `PROJECT_MANAGER` may assign anyone on the
  project; a regular member may assign or unassign only themselves.

All of this is enforced in the API. The frontend mirrors the same rules to
disable controls rather than offer actions that will fail, but that copy has no
security value.

### API surface

```
POST   /auth/register
POST   /auth/login
GET    /auth/me

GET    /organizations

GET    /projects
POST   /projects
GET    /projects/:projectId
GET    /projects/:projectId/members
POST   /projects/:projectId/members

GET    /projects/:projectId/tasks
POST   /projects/:projectId/tasks
GET    /tasks/:taskId
PATCH  /tasks/:taskId
PATCH  /tasks/:taskId/status
PATCH  /tasks/:taskId/assignee
DELETE /tasks/:taskId

GET    /tasks/:taskId/activity

GET    /tasks/:taskId/comments
POST   /tasks/:taskId/comments
```

`PATCH /tasks/:taskId/assignee` takes `{ "assigneeId": "<userId>" | null }`.
`null` clears the assignee. It returns the updated task.

`GET /tasks/:taskId/activity` is paginated newest-first with `page` and
`pageSize`, and returns actors and both sides of each change already resolved:

```json
{
  "items": [
    {
      "id": "...",
      "type": "TASK_ASSIGNEE_CHANGED",
      "actor": { "id": "...", "name": "Ammar Yaser", "email": "...", "avatarUrl": null },
      "task": { "id": "...", "key": "ENG-1" },
      "metadata": { "from": null, "to": { "id": "...", "name": "Magd Ali", "...": "..." } },
      "createdAt": "2026-09-11T09:14:02.418Z"
    }
  ],
  "total": 3,
  "page": 1,
  "pageSize": 20
}
```

Errors share one shape:

```json
{
  "statusCode": 403,
  "message": "You do not have access to this project",
  "error": "Forbidden"
}
```

### Frontend

Routes are thin; the work happens in `features/`. Server state is owned by
TanStack Query — query keys live in `lib/query-keys.ts` so invalidation stays
predictable — and local UI state stays in React. The API client in
`lib/api-client.ts` centralises the base URL, the auth header and error
parsing.

Components are server components by default; `"use client"` is added only where
interactivity or hooks require it.

---

## Technical decisions

**Task numbers come from an atomic counter, not a count.** Allocation is a
single `findOneAndUpdate` with `$inc` against a per-project counter document.
MongoDB guarantees atomicity on one document, so two concurrent creates cannot
receive the same number. A transaction would also work but requires a replica
set, which neither the local setup above nor the in-memory test server provides
— it would have made the fix untestable. A unique index on
`{ projectId, number }` backs the invariant at the database level.

**Authorization is answered in one place.** `ProjectAccessService` resolves the
caller's organization role and project role together and returns them as a
context. Services interpret that context; they do not re-derive it. The one
rule the frontend also needs — who may manage a project — lives in
`packages/shared` as `canManageProject` so both sides cannot drift.

**Elevated organization roles do not need a project membership row.** `OWNER`
and `ADMIN` reach every project in their organization. This is pre-existing
behaviour and the assignment rules follow it, so an organization owner can
assign a task on a project they have never been added to.

**Activity is one row shape, not one per event type.** `fromUserId` and
`toUserId` are nullable references, which covers assignment, reassignment and
unassignment without a discriminated union. `type` is an enum with room to grow.

**Activity reads resolve users in batches.** Both the activity feed and the task
list collect every referenced user id for the whole page and fetch them with one
`$in` query. Page size does not affect query count.

**No-op assignments write nothing.** Setting the assignee to its current value
returns `200` with no database write and no activity entry, so re-selecting the
current assignee in the UI cannot pollute the history.

**Status changes stay open to any project member.** Moving a card across the
board is ordinary member work. The general task update keeps its stricter rule
(`canManage` or the creator) because it rewrites titles and descriptions.

**The frontend updates assignment optimistically, with rollback.** The selector
writes the new assignee into the task and board caches immediately, snapshots
both first, and restores them verbatim if the request fails. In-flight queries
are cancelled before the optimistic write so a late refetch cannot undo it.
Task creation is _not_ optimistic — the server owns the generated key and
number, and a placeholder row would have to invent them.

Longer reasoning, the ambiguities in the brief and how they were resolved, and
a review of the supplied `assignTask` function are in
[`ASSESSMENT_NOTES.md`](./ASSESSMENT_NOTES.md).

---

## Known limitations

- **No frontend tests.** Coverage is end-to-end against the API only. The
  assignee selector's permission branches and the optimistic rollback path are
  not exercised.
- **Activity records assignee changes only.** Status, priority and title edits
  are not logged. The schema anticipates them; the rendering and metadata
  shapes do not exist yet.
- **The task write and the activity write are not atomic.** A crash between
  them leaves the assignment applied with no history entry. Closing this needs
  a transaction, and therefore a replica set.
- **Pagination is offset-based.** `skip`/`limit` degrades with page depth, and
  an insert between requests shifts subsequent pages. The activity index already
  carries `_id` as a tiebreaker, so moving to cursors is a contract change
  rather than a data change.
- **Tokens cannot be revoked.** A JWT stays valid until it expires
  (`JWT_EXPIRES_IN`, 7 days by default). There is no refresh flow and no
  denylist.
- **No rate limiting** on any endpoint, including `/auth/login`.
- **The board does not show assignees.** Task rows still show the creator's
  avatar. Deliberately unchanged — see `ASSESSMENT_NOTES.md`.
- **The assignee selector is not searchable.** It is a native-style select with
  typeahead, which suits single-digit project membership. Larger projects would
  need a filterable combobox and a server-side member search.
- **Deleted users leave dangling references.** Tasks and activity entries
  render `"Unknown user"` rather than failing, but there is no soft-delete or
  anonymisation model.
- **Existing duplicate task numbers are not repaired.** The fix prevents new
  ones; any duplicates already in a database predate it and would need a
  migration.
