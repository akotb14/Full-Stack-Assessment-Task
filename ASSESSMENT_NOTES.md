# Assessment Notes

ProjectFlow, task assignment and activity history. This document covers how the
application is put together, the decisions I made and why, what I consider
weak about the result, a review of the supplied `assignTask` function, and what
would have to change to carry this to 500,000 users.

---

## Architecture

### How the application is structured, and what the major modules are

It is a pnpm workspace driven by Turborepo, with two applications and three
shared packages:

```
apps/api      NestJS 11 + Mongoose 8 + MongoDB
apps/web      Next.js 16 (App Router) + React 19 + TanStack Query 5
packages/shared          enums, constants, API response types, shared rules
packages/tsconfig        base TypeScript configs
packages/eslint-config   flat ESLint configs
```

The API is organised by domain, not by technical layer: `auth`, `users`,
`organizations`, `organization-members`, `projects`, `project-members`, `tasks`,
`comments`, `activity`, plus a `common` module for guards, decorators, the
exception filter and shared DTOs. Each module owns its schema, its DTOs, its
service and its controller. A module that needs another domain injects that
domain's _service_ rather than its model — `TasksService` asks
`ProjectMembersService` whether a user is on a project instead of querying the
membership collection itself.

The frontend mirrors that split. `src/app` holds routes and layouts and stays
thin; the work lives in `src/features/{auth,projects,tasks,comments}`, each with
its own `api.ts` (typed fetch calls), `hooks.ts` (TanStack Query wrappers) and
`components/`. `src/components/ui` is the design-system layer — Radix
primitives wrapped with the project's own styling. `src/lib` holds the API
client, the query-key registry and formatting helpers.

`packages/shared` is the seam between the two. It is not a dumping ground: it
holds the enums that must agree on both sides (`TaskStatus`, `ProjectRole`,
`TaskActivityType`), the response shapes the API promises (`TaskDetail`,
`Paginated<T>`, `TaskActivityEntry`), validation constants, and the handful of
pure predicates that encode a rule both sides need to know
(`isElevatedOrganizationRole`, `canManageProject`). It is consumed as compiled
`dist/` output, so it has to be rebuilt after an edit or consumers fail
typecheck.

### Where business logic lives

In the API's services, and only there.

Controllers do three things: bind the route, convert route params to
`ObjectId`s, and hand off. They contain no branching. DTOs handle shape and
type validation at the boundary through `class-validator`, with a global
`ValidationPipe` configured `whitelist: true, forbidNonWhitelisted: true,
transform: true` — so an unexpected field is a `400`, not something silently
ignored.

Everything past that is service code. `TasksService.updateAssignee` is the
clearest example: it resolves project access, applies the two permission rules,
verifies project membership of the target, detects a no-op, writes the task and
records the activity entry. The controller above it is nine lines of parameter
plumbing.

Authorization is the one piece of logic deliberately pulled out of the domain
services and centralised, in `ProjectAccessService`. It answers _"may this user
touch this project, and in what capacity?"_ in one place, returning a context
that the caller then interprets. Duplicating that answer across seven modules
is how you end up with Bug 1.

The frontend holds no business rules, only _mirrors_ of them.
`useProjectPermissions` recomputes `canManage` client-side so the UI can disable
a dropdown option rather than offer it and then show an error. The server
enforces the same rule independently, and the frontend copy is treated as a
UX affordance with no security value.

### How the frontend talks to the backend, and how server state is handled

Over plain REST with JSON, through one client (`src/lib/api-client.ts`) that
owns the base URL, attaches the bearer token, and converts a non-2xx response
into an `Error` carrying the API's `message`. Feature `api.ts` files are thin
typed wrappers over it, and every return type is imported from
`@projectflow/shared` — so a contract change in the API surfaces as a
TypeScript error in the web app rather than as a runtime surprise.

Server state belongs to TanStack Query. Nothing fetched from the API is
copied into React state. Query keys live in one registry (`src/lib/query-keys.ts`)
so that invalidation is written against a shared vocabulary instead of
hand-assembled arrays, which is what makes "after an assignment, refresh the
task, the board and the timeline" a three-line statement rather than a hunt.

For assignment specifically I used an **optimistic update with rollback**:

- `onMutate` cancels in-flight queries for the task and the board (otherwise a
  refetch already on the wire can land _after_ the optimistic write and restore
  the old assignee), snapshots both caches, then writes the new value into both.
- `onError` restores the snapshots verbatim.
- `onSettled` invalidates the task, the board and the activity feed, so the
  server has the final word on both success and failure.

Two details worth calling out. The snapshot is stored whole rather than
reconstructed in reverse, because restoring the previous value also correctly
restores _"nothing was cached"_ — a reverse patch cannot express that. And the
mutation takes the resolved `UserSummary` alongside the id, not just the id, so
the optimistic paint can show a name and avatar instead of flashing an id and
then correcting itself; the selector already has the member list, so this costs
nothing.

Optimistic updating is the right trade here because assignment is small,
frequent, almost always succeeds, and is cheap to undo. I did not apply it to
task creation, where the server owns the generated key and number and an
optimistic row would have to invent values it cannot know.

### How authentication and authorization are implemented

**Authentication** is a JWT bearer token. `POST /auth/register` and
`POST /auth/login` verify credentials against a bcrypt hash and issue a signed
token; `JwtAuthGuard` is registered globally as an `APP_GUARD`, so routes are
protected by default and must opt out explicitly with `@Public()`. Default-deny
is the important property: forgetting to add a guard cannot expose an endpoint,
because there is no guard to forget. The decoded user is attached to the request
and read in controllers through `@CurrentUser('id')`.

**Authorization** is separate and layered on top, and this distinction is
exactly what Bug 1 came down to — that endpoint was authenticated but never
authorized.

Two role systems compose:

- **Organization role** — `OWNER`, `ADMIN`, `MEMBER`. `OWNER` and `ADMIN` are
  _elevated_: they reach every project in the organization without needing a
  membership row.
- **Project role** — `PROJECT_MANAGER`, `MEMBER`, stored as an explicit
  `ProjectMember` row.

`ProjectAccessService.resolve` loads both in parallel and returns them with the
project. Two predicates sit on top: `canView` (elevated org role **or** any
project membership) and `canManage` (elevated org role **or**
`PROJECT_MANAGER`). `assertCanView` gates reads and member-level actions;
`assertCanManage` gates project configuration and deletion.

`canManage`'s rule lives in `packages/shared/src/roles.ts` as `canManageProject`
because the frontend needs the same answer to decide whether to enable a
control. Sharing the predicate rather than re-implementing it means the two
copies cannot drift.

Per-action rules that are narrower than view/manage live in the service that
owns the action — for example, a regular member may set the assignee to
themselves but not to a teammate. That rule is specific to assignment and does
not belong in a general access service.

### How the main entities relate

```
User
Organization  ── OrganizationMember ── User     (OWNER | ADMIN | MEMBER)
Organization  ── Project
Project       ── ProjectMember      ── User     (PROJECT_MANAGER | MEMBER)
Project       ── Task ── Comment
Task          ── TaskActivity
Project       ── TaskCounter                    (one document per project)
```

Membership is modelled as its own collection on both levels rather than as an
array on the parent document. That keeps it indexable and queryable from either
side, avoids unbounded document growth, and gives each edge a place to carry its
own role.

On `Task`, `createdBy` and `assignee` are deliberately distinct: `createdBy` is
required and never changes, `assignee` is nullable and changes often. Conflating
them is the mistake the brief warns about, and it would make "unassigned"
unrepresentable.

`TaskActivity` is append-only, timestamped with `createdAt` only, and stores
`fromUserId`/`toUserId` as nullable references. That nullability is what lets a
single row shape express all three transitions — assigned (`null → user`),
reassigned (`user → user`) and unassigned (`user → null`) — without a
discriminated union or three separate event types.

`TaskCounter` is not a domain entity; it is a per-project sequence that exists
purely to make number allocation atomic. See `BUG_REPORT.md`.

---

## What I built

- **Assignee on tasks** — nullable `assignee` reference, exposed on both
  `TaskSummary` and `TaskDetail`, with `PATCH /tasks/:taskId/assignee`
  enforcing project membership and the two permission rules server-side.
- **Activity history** — `TaskActivity` collection, one entry per real assignee
  transition, and `GET /tasks/:taskId/activity`: paginated newest-first,
  authorized against project access, and resolving every referenced user for the
  page in one query.
- **Two bug fixes** — the cross-project task-modification hole and the task
  numbering race. Both documented in `BUG_REPORT.md`.
- **Frontend** — an assignee selector on the task detail page and an activity
  timeline that reads as plain history, paged newest-first against the
  endpoint's own pagination.
- **Tests** — 48 end-to-end tests across six suites, covering all nine scenarios
  named in the brief.

---

## Decisions worth explaining

### The brief's permission rule names roles that do not all exist at the same level

Rule #2 says _"`OWNER`, `ADMIN` and `PROJECT_MANAGER` may assign other project
members."_ In this codebase `OWNER` and `ADMIN` are **organization** roles while
`PROJECT_MANAGER` is a **project** role — three names spanning two systems.
Read literally, the rule is not directly expressible.

I resolved it as: _elevated organization role, **or** `PROJECT_MANAGER` on this
project_ — which is exactly the existing `canManage` predicate. The alternative
reading (requiring an `OWNER`/`ADMIN` to also hold a project membership row)
would contradict how the rest of the application already works, where elevated
organization roles reach every project without one. I extracted that rule into
`canManageProject` in the shared package so the API and the web app answer it
identically, and added a test asserting that an organization `OWNER` with no
project membership row can assign — because that is the case the ambiguity
turns on.

### "A regular member may assign a task to themselves" — taking over vs. claiming

The brief grants a regular member the right to assign a task _to themselves_. It
does not say whether that holds when the task is currently assigned to someone
else.

I implemented the permissive reading: a member may claim a task regardless of
who holds it, and may unassign only themselves. The check is on _who is being
assigned_, not on who is being displaced:

```ts
if (!canManage(access)) {
  const target = next ?? previous;
  if (target !== null && !target.equals(userId)) {
    throw new ForbiddenException('You can only change your own assignment on this task');
  }
}
```

The reasoning: the rule as written is about who you may put on a task, and
"myself" is always the permitted answer. Teams pick up each other's work
constantly, and the activity history makes every takeover attributable — which
is a better control than a permission error. The restrictive reading is a
one-line change if the product disagrees.

Note the asymmetry this produces, which is intentional: a member can _take_ a
task from a colleague but cannot _remove_ them from it, because unassigning a
colleague leaves the work owned by nobody.

### A no-op assignment writes nothing

Setting the assignee to the value it already has returns `200` with the task
unchanged and records no activity. Without that check, re-selecting the current
assignee — which the UI makes easy — would fill the timeline with entries saying
nothing happened. `PATCH` is idempotent in the sense that matters here; the
history should record changes, not requests.

### Searchable selector: not yet, and why

The brief asks for a selector that is _"searchable when appropriate"_. I built a
Radix `Select` matching the existing `TaskStatusSelect` pattern rather than a
combobox with a filter field.

"When appropriate" is doing the work in that sentence. Projects in this
application have single-digit member counts; the member list is already fetched
in full for the permission check; and Radix `Select` has built-in typeahead, so
pressing `s` jumps to Salma. A search input over eight names adds a control to
operate and an empty-search state to design, for no gain. The threshold where
this flips is somewhere around twenty or thirty members — at which point the
right change is a `Command`-style combobox with a server-side member search, not
a client-side filter over a list that has itself become too large to fetch. I
would rather note that boundary than pre-build for it.

### Status changes stayed open to members

Fixing Bug 1 required adding _an_ authorization check to the status endpoint; it
did not dictate _which_. I used `assertCanView` — any project member can move a
card — rather than the stricter `canManage || isCreator` rule used by the
general task update. Moving a card across a board is the ordinary work of a
project member; the general update rewrites titles and descriptions and should
be tighter. Full reasoning in `BUG_REPORT.md`.

### The board rows were left alone

Task rows on the project board still show the _creator's_ avatar, not the
assignee's. Showing assignment there would be an improvement, and I would raise
it — but the brief asks for a selector and a timeline, and says explicitly not
to redesign the application. Changing what the board communicates is a product
decision, not an implementation detail of this task. It is listed under
[If I Had Two More Days](#if-i-had-two-more-days).

### No transactions

The task write and the activity write are two operations. A crash between them
loses the history entry. A transaction would close that window but requires a
replica set, which neither the documented local setup nor the in-memory test
server provides. Given that the failure mode is a missing timeline row rather
than incorrect task state, and that the fix imposes infrastructure on every
developer, I took the gap knowingly. It is listed as a risk below.

---

## Risks and weaknesses

### 1. Authorization is a convention, not a constraint

**What I noticed.** Every service method is individually responsible for
remembering to call `ProjectAccessService`. Nothing structural enforces it. Bug
1 was one method that forgot — and it did not merely skip the call, it never
accepted the `userId` that would have made the call possible, so the omission
was invisible at the call site.

**Why it could be a problem.** The failure mode is silent and the blast radius
is cross-tenant. The next endpoint someone adds under time pressure has exactly
the same opportunity to forget, and the tests only catch it if the author
thought to write the negative case — which is precisely the thing an author who
forgot the check would also not think to write.

**Now or later.** Later, but soon — and deliberately, not opportunistically.

**Why.** The right fix is a design change, not a patch: either a
`@RequiresProjectAccess()` guard that resolves the project from the route and
populates the request, or a repository layer that will not return a task without
an access context. Both are a meaningful refactor of every task and comment
endpoint, and doing that in the same change as a security fix would make the
security fix hard to review. The immediate hole is closed and tested; the
structural fix deserves its own change.

### 2. Tokens cannot be revoked, so permission changes do not take effect

**What I noticed.** JWTs are stateless and issued with a 7-day default lifetime
(`JWT_EXPIRES_IN`). Nothing consults a revocation list.

**Why it could be a problem.** Removing someone from a project or an
organization does not remove their access. It removes their _membership rows_ —
and since access is resolved from those rows on every request, that part
actually works correctly here. The real exposure is narrower but real: a leaked
or stolen token stays valid for up to a week with no way to invalidate it, and a
user who deletes their account or changes their password keeps a working
credential. There is also no refresh-token flow, so shortening the lifetime
today would simply log people out more often.

**Now or later.** Later.

**Why.** Doing it properly means a refresh-token flow plus a revocation
mechanism (a token version on the user document is the cheap version; a denylist
in Redis is the thorough one). That is a feature, not a hardening tweak, and it
is the wrong thing to bundle into an assessment focused on assignment. It should
precede any real production deployment.

### 3. The login endpoint has no rate limiting

**What I noticed.** `POST /auth/login` will accept unlimited attempts from a
single origin. Nothing throttles, locks out, or backs off.

**Why it could be a problem.** Credential stuffing needs nothing more than this.
bcrypt makes each attempt expensive enough to be a denial-of-service vector in
its own right — a few hundred concurrent login attempts will saturate the API's
event loop and degrade the entire application, not just authentication.

**Now or later.** Later, but it is the item I would move first if this were
going to be internet-facing.

**Why.** It is genuinely small — `@nestjs/throttler` with a per-IP limit on the
auth routes is under an hour — but it interacts with deployment topology
(is there a proxy in front? is `X-Forwarded-For` trustworthy? one instance or
several sharing a store?) and those answers are not knowable from inside the
repository. Guessing them produces a limiter that either does nothing behind a
load balancer or locks out an office NAT.

### 4. The task write and the activity write are not atomic

**What I noticed.** `updateAssignee` saves the task and then creates the
activity entry as two separate operations, with no transaction.

**Why it could be a problem.** A process crash or a connection failure between
the two leaves the assignment applied with no record of who applied it. The
history silently becomes incomplete — and unlike a visible error, nobody finds
out. If the timeline is ever used to answer a question that matters ("who
reassigned this before the incident?"), quiet gaps are worse than loud failures.

**Now or later.** Later.

**Why.** It requires a replica set, which neither the documented local setup nor
`mongodb-memory-server` provides, so adopting it now means either untestable
code or forcing every developer to run a replica set. The window is small and
the consequence is a missing history row rather than wrong task state. When the
deployment target is known — managed MongoDB is a replica set by default — this
becomes a small change: wrap both writes in a session. I would take it then,
together with risk 6.

### 5. Offset pagination will not survive growth

**What I noticed.** Both the task list and the activity feed paginate with
`skip`/`limit`.

**Why it could be a problem.** `skip(n)` walks and discards `n` documents, so
cost grows linearly with page depth. Worse for correctness: an insert between
two requests shifts every subsequent page, so a client paging through a busy
task's history can see an entry twice or miss one entirely — and the activity
feed is sorted newest-first, which is exactly where new rows land.

**Now or later.** Later.

**Why.** At current data volumes neither symptom is observable, and the shape is
consistent with the rest of the API (`PaginationQueryDto`, `Paginated<T>`).
Introducing cursors for one endpoint would make the API inconsistent to solve a
problem nobody has. The compound index `{ taskId, createdAt: -1, _id: -1 }` is
already the index a cursor implementation would need, and `_id` is already the
tiebreaker, so the migration is deliberately cheap when it is time. See
[Scaling](#scaling-to-500000-users).

### 6. A deleted user leaves dangling references

**What I noticed.** `createdBy`, `assignee`, and the activity `actorId`/`from`/
`to` fields are plain `ObjectId` references with no cleanup and no soft-delete
model. Both the task serializer and the activity serializer fall back to a
placeholder `"Unknown user"` when a reference no longer resolves.

**Why it could be a problem.** The placeholder is the right _behaviour_ — a
history entry should not disappear because someone left the company — but it is
a defensive patch over an unmodelled concept. There is no way to distinguish
"this user was deleted" from "this reference is corrupt," history becomes
unattributable, and a future GDPR-style deletion request has no defined answer
beyond "the rows keep pointing at a gap."

**Now or later.** Later.

**Why.** It needs a product decision before it needs code: does deactivating a
user anonymise their history, preserve their name, or block deletion while
references exist? Each has different legal and UX consequences. Writing the
mechanism before that question is answered means writing the wrong one. The
placeholder keeps the application correct in the meantime.

---

## Code Review

The function under review:

```ts
async assignTask(taskId: string, assigneeId: string, userId: string) {
  const task = await this.taskModel.findById(taskId);
  if (!task) { throw new NotFoundException(); }

  const user = await this.userModel.findById(assigneeId);
  if (!user) { throw new NotFoundException(); }

  task.assignee = user._id;
  await task.save();
  return task;
}
```

It reads as reasonable code. It has a null check on each lookup, it uses
`await` correctly, and it does what its name says. Everything below is about
what it does not do.

### Blocking: `userId` is accepted and never used

This is the most serious problem, and it is worse than a missing check. The
parameter is in the signature — someone thought about the caller, threaded it
through the controller, and then never consulted it. A reviewer skimming the
signature sees an authorization argument and assumes authorization happens.

Concretely: **any authenticated user can reassign any task in the system**,
given only its id. Not a project member, not an organization member — any
account. This is the same defect class as the production bug in
`BUG_REPORT.md`, and it would be the second instance in the same service.

Neither of the brief's permission rules can be applied at all, because the only
input that could distinguish `OWNER` from a regular member is unused. Note also
that there is no `assertCanView` on the _actor_ — so a user who cannot even read
the task can reassign it.

### Blocking: the assignee is checked for existence, not for membership

`this.userModel.findById(assigneeId)` answers _"is this a real user account?"_.
The rule is _"is this user a member of the project this task belongs to?"_. Any
account on the platform — including one from an entirely different organization
— can be assigned.

The consequence is a cross-tenant leak in an unusual direction: the outsider now
appears in another organization's task list, would receive its notifications,
and shows up in its activity history by name. The check needs the task's
`projectId` and the project membership collection, not the users collection —
which means this query is not merely insufficient, it is the wrong query.

### Blocking: unassignment is unrepresentable

`assigneeId: string` is non-nullable, and the body of the function assumes a
user was found. There is no value a caller can pass to clear the assignee.
Rule #3 cannot be implemented without changing the signature to
`assigneeId: string | null` and branching — which also means every call site,
DTO and client type has to acknowledge that null is a legitimate value rather
than a missing argument.

### Blocking: nothing is recorded

The task is mutated and the change vanishes. No activity entry, no audit trail,
no way to answer "who reassigned this?". Given that the change is what the
history exists to record, the write and the record should be adjacent in the
code — separating them is how you end up with one being added later and
sometimes forgotten.

### Significant: both failures throw the same bare exception

`throw new NotFoundException()` with no message, twice. The caller receives
`404` in both cases and cannot tell whether the task does not exist or the
proposed assignee does not.

The second one is also the wrong status. The task _does_ exist and the URL is
valid; what is wrong is a field in the request body. `404` tells a client "this
resource is not here," which sends them looking in the wrong place. A missing
assignee is a `400` — and a non-member assignee, once that check exists, is
likewise a `400`, because the request is malformed with respect to the domain,
not pointed at something absent.

### Significant: raw Mongoose documents leak out of the service

`return task` hands the caller a hydrated document: `_id` rather than `id`,
`__v`, internal field names, and whatever gets added to the schema next year.
The API's response contract becomes "whatever the schema currently is," and
adding an internal field silently publishes it.

It is also unusable by the client for the stated purpose. `task.assignee` is a
bare `ObjectId`, so the UI receives an id where it needs a name and an avatar
and has to make another request to render the change it just made.

Everything else in this codebase returns an explicitly serialized DTO
(`TaskDetail`, built by `toDetail`). This function should too — and it should
declare `Promise<TaskDetail>` as its return type rather than letting Mongoose
infer the contract.

### Moderate: ids are unvalidated

`taskId` and `assigneeId` are `string` and go straight into `findById`. A
malformed id makes Mongoose throw a `CastError`, which without an exception
filter surfaces as a `500`. A client typo should be a `400`. This codebase has a
`toObjectId(value, label)` helper at the controller boundary for exactly this
reason; the signature taking `string` instead of `Types.ObjectId` is what
invites the mistake.

### Moderate: read-modify-write, and no no-op detection

`findById` → mutate → `save()` reads the whole document, sends the whole
document back, and resolves concurrent assignments as last-write-wins with no
detection. A targeted `findOneAndUpdate` writes one field and, with the previous
value in the filter, can detect that it lost a race.

Separately, assigning the user who is already assigned still calls `save()` and
— once activity exists — would write a history entry recording no change. A
cheap equality check before the write avoids polluting the timeline.

### Moderate: architectural coupling

The service injects `userModel` directly. In a codebase where cross-domain
access goes through services (`UsersService`, `ProjectMembersService`), reaching
into another module's model spreads knowledge of the user schema into the task
domain and makes the user module's internals harder to change. The
membership check this function is missing would, correctly implemented, go
through `ProjectMembersService` — at which point `userModel` is not needed here
at all.

### Performance

Two sequential round trips where there could be fewer is the least of this
function's problems, but worth noting: the task load and the membership lookup
are independent once the task's `projectId` is known, and the existence check on
the assignee becomes redundant the moment membership is verified — a membership
row implies a user.

### What the corrected shape looks like

Not a rewrite, just the contract the above implies:

```ts
async updateAssignee(
  taskId: Types.ObjectId,
  userId: Types.ObjectId,
  dto: UpdateTaskAssigneeDto,   // { assigneeId: string | null }
): Promise<TaskDetail>
```

with, in order: resolve project access for the actor; apply the
self-vs-others permission rule; verify the target's project membership; return
early if nothing changed; write the task; record the activity entry; return a
serialized DTO. That is the implementation in
`apps/api/src/tasks/tasks.service.ts`.

### Summary

The function is a reasonable sketch of the _mechanics_ of assignment and is
missing essentially all of its _rules_. Four blocking issues — no
authorization, no membership check, no unassignment, no audit trail — plus
incorrect status codes, a leaked persistence model, and unvalidated input. The
underlying pattern is that it treats assignment as a field update, when it is a
permissioned domain operation that happens to update a field.

---

## Scaling to 500,000 users

A hundredfold growth in users is closer to a thousandfold growth in tasks,
comments and activity rows, because the heaviest users generate the most of
each. What follows is ordered by when the pain arrives, with the observable
signal that should trigger each change. None of it is worth doing early.

### First: observability, because everything below is stated as a trigger

None of the signals this list depends on are visible today. The minimum:
structured JSON logs with a request id propagated through every line; RED
metrics per endpoint (rate, errors, duration at p95/p99 — averages hide exactly
the tail that hurts); and MongoDB's slow-query log with a low threshold, which
is where missing indexes announce themselves. The alerts worth having are p99
latency by endpoint, error rate by status class, and the database cache hit
ratio. **Cost:** two or three days, and it pays for itself the first time
something is slow for a reason nobody can guess.

### Indexes and query shape

A missing index is the difference between 2 ms and a scan of ten million
documents, so this comes before anything architectural.

Today's indexes cover today's reads: `{ projectId, number }` unique,
`{ projectId, status }`, `{ projectId, assignee }`, and
`{ taskId, createdAt: -1, _id: -1 }` for activity — the last covering its only
read pattern with a stable tiebreaker. The gap I would close first is
`{ assignee, status }`: "my open tasks across all projects" is the query every
user runs on every page load, and it has no supported access path.

I would also make batched resolution a review standard. `toSummaries` and
`toEntries` already collect every user reference for a page into one `$in`, so
page size does not change query count — but a single `await` inside a `.map()`
silently turns a 20-row page into 21 queries. **Trigger:** continuous.
**Cost:** near zero.

### Cursor pagination

`skip(n)` walks and discards `n` documents, so the hundredth page costs a
hundred times the first — and an insert between requests shifts every later
page, so a client paging a busy activity feed can see a row twice or miss one.
Keyset pagination fixes both: the client sends the sort key of the last row it
saw (`createdAt` plus `_id`) and the server asks for rows after it, at constant
cost.

The groundwork is deliberate — the index already carries `_id` as its
tiebreaker and the sort already uses it — so this is a contract change
(`nextCursor` replacing `page`), not a data migration. **Trigger:** any feed
regularly exceeding a few pages, or p99 tracking page depth. **Cost:** a day,
mostly client-side.

### Data growth, retention and archiving

Activity is append-only and its value decays sharply: the last twenty entries
answer almost every question asked of a task. I would not archive early — small
rows with a good index stay unremarkable into the tens of millions. What I would
do early is decide the _policy_, because retroactive retention decisions are
painful. Keep activity hot for N months, then roll older rows into cold storage
behind the same API, served slower. A TTL index is the trivial implementation if
the policy is "delete", and the wrong one if the data is ever needed for audit —
a question to settle before writing the index rather than after. The same
reasoning moves completed projects to a separate collection, so the working set
stays proportional to active work rather than to all work ever done.
**Trigger:** the collection's working set outgrowing RAM, visible as a falling
cache hit ratio long before users notice. **Cost:** days, plus a product
decision.

### Asynchronous work and queues

Nothing here needs a queue today. What forces one is _additions_: the moment
assignment sends an email, pushes a notification or updates a search index, the
user waits on a third-party API before their dropdown updates, and a provider
outage becomes a failed assignment. At that point the write and its consequences
separate — the request persists the task and the activity row and returns, and a
queue carries the side effects with retries and a dead-letter queue. The same
machinery then covers digest emails, retention sweeps and counter rebuilds.

I would use whatever the deployment already runs. If Redis is present for
caching, BullMQ adds no new infrastructure. Kafka solves durable, replayable,
multi-consumer streaming — not a problem this application has at this size.
**Trigger:** the first side effect that is not a database write. **Cost:** a few
days, mostly operational.

### Real-time updates

Today a user sees someone else's change on their next refetch; on a shared board
that becomes visibly wrong. Cheapest sufficient option first:
`refetchOnWindowFocus` (already on, and it covers tab-switching); then
short-interval polling scoped to the visible board; then server-sent events,
which match the one-directional shape of this problem; and only then WebSockets,
which are bidirectional and therefore more infrastructure than it needs.

The real cost of any push mechanism at this size is persistent connections
spread across instances, which needs a shared pub/sub layer so an event
published on one instance reaches subscribers on another — and that is the
reason to delay until polling genuinely hurts. **Trigger:** stale-board reports,
or poll traffic outweighing a push channel. **Cost:** a week including pub/sub.

### Caching

The most valuable cache is on the hottest repetitive query, not the most
interesting data. Project access resolution runs on every authorized request and
reads stable rows; a short-TTL cache keyed by `(userId, projectId)`, invalidated
on membership change, removes a large fraction of all database reads. Caching
tasks or feeds instead invites staleness on precisely the data users are
watching change, for reads that are already indexed and fast. At the edge,
`ETag` and `Cache-Control` let browsers and any CDN skip round trips entirely —
cheaper than any server-side cache, because the request never arrives.
**Trigger:** read load, rather than latency, becoming the constraint.
**Cost:** a couple of days.

### What I would not do

Not microservices: the bottleneck at this size is the database, and splitting
the application multiplies the services querying it while adding network hops
and distributed-transaction problems that do not exist today. Not event sourcing
or CQRS — the activity log already provides the audit trail without rebuilding
the write model. Not Kubernetes as a goal in itself. Each solves a real problem;
none solves one this application has at 500,000 users.

---

## If I Had Two More Days

In priority order.

1. **Make authorization structural rather than conventional.** A
   `@RequiresProjectAccess()` guard that resolves the project from the route and
   attaches the access context, so a new endpoint cannot silently skip the check.
   This is Bug 1's root cause and the highest-leverage change on the list.
2. **Rate-limit the auth endpoints.** `@nestjs/throttler` on `/auth/login` and
   `/auth/register`, with the proxy question settled so the limit actually binds.
3. **Frontend tests.** There are none. The assignee selector's permission
   branches and the optimistic rollback path are both logic that end-to-end API
   tests cannot reach — React Testing Library plus MSW for the selector,
   covering the disabled-option cases and a failed mutation restoring the
   previous assignee.
4. **Show the assignee on the board.** Task rows show the creator's avatar.
   Making assignment visible where people actually look at tasks is most of this
   feature's day-to-day value, and I left it out only because it changes what
   an existing screen communicates.
5. **Cursor pagination on the activity feed,** with `nextCursor` in the
   envelope, replacing the timeline's page controls with infinite scroll. The
   index already supports it.
6. **Broaden the activity log beyond assignment.** Status transitions,
   priority changes, title edits. The schema was designed for it —
   `TaskActivityType` is an enum with one member — but each type needs its own
   metadata shape and its own sentence in the timeline, which is more design
   work than it first appears.
7. **Wrap the task and activity writes in a transaction,** once a replica set is
   part of the development setup. Closes risk 4 and unblocks the same treatment
   for any future multi-write operation.
8. **Decide the deleted-user story** and replace the `"Unknown user"`
   placeholder with a modelled soft-delete.
9. **OpenAPI generation** from the existing DTOs (`@nestjs/swagger`). The
   contract is already fully typed; publishing it costs little and removes the
   README's API surface list as a thing that can go stale.
