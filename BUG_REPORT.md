# Bug Report

Two defects were investigated. Both were real, both are fixed, and both have a
regression test that was proven to fail against the old code.

---

## Bug 1 — Any authenticated user could change the status of any task

**Reported as:** _"Some users appear to be able to modify tasks belonging to
projects they are not members of."_

**Verdict:** confirmed. The report is accurate, and it is narrower than it
sounds — exactly one endpoint was affected.

### Root cause

`PATCH /tasks/:taskId/status` never resolved the caller's relationship to the
project. The service signature is the tell:

```ts
// apps/api/src/tasks/tasks.service.ts, before the fix
async updateStatus(taskId: Types.ObjectId, dto: UpdateTaskStatusDto): Promise<TaskDetail> {
  const task = await this.findTaskOrFail(taskId);

  task.status = dto.status;
  await task.save();

  return this.toDetail(task);
}
```

There is no `userId` parameter. The controller did not pass one, so the
information required to make an authorization decision was not in scope, and no
check could have been written without changing the signature. Every sibling
operation — `findByProject`, `create`, `findOne`, `update`, `remove` — takes the
caller and routes it through `ProjectAccessService`. This one did not.

What made it survive review is that the endpoint _was_ protected, just not by
the right thing. `JwtAuthGuard` is registered globally as an `APP_GUARD`, so an
anonymous request was correctly rejected with `401`. The endpoint answered
_"is this a real user?"_ and never asked _"is this user allowed to touch this
task?"_. Authentication was mistaken for authorization.

I audited the rest of the surface for the same shape. `PATCH /tasks/:taskId`,
`DELETE /tasks/:taskId`, both task reads, and the comment endpoints all resolve
access before acting. The status endpoint was the only gap.

### Impact

- **Severity: high.** Any user who could register an account could move any task
  on the platform to any status, given only its id.
- **The blast radius crosses tenants.** Access is derived from organization and
  project membership, so nothing confined this to one organization. A user in
  organization A could alter tasks in organization B.
- **Ids are guessable enough to matter.** Mongo `ObjectId`s are not secrets —
  they leak through URLs, shared links, screenshots and API responses. The
  attack does not require enumeration to be useful; one leaked id is enough.
- **Silent in the audit trail.** Status changes are not recorded anywhere, so a
  team would see the board change and have no way to find out who did it.
- **Not a data-loss bug.** Only `status` could be written. Titles, descriptions,
  priorities, assignees and comments were never exposed by this path.

### Reproduction

Against the code as it was:

1. Register user A. As A, create an organization, a project `ENG`, and a task.
   Note the task id from the response.
2. Register user B. Give B no membership in that organization and none in that
   project.
3. As B: `PATCH /tasks/<taskId>/status` with `{"status": "DONE"}`.

Expected `403`. Actual `200 OK`, with the task moved to `DONE`.

I confirmed this empirically rather than by reading. After writing the fix I
temporarily removed the `assertCanView` call and re-ran the suite; the new
regression test failed with exactly the reported behaviour:

```
● Tasks › status updates › refuses a status change from a user outside the project

    expected 403 "Forbidden", got 200 "OK"
```

The check was then restored and the full suite re-run.

### Fix

`apps/api/src/tasks/tasks.service.ts` and `apps/api/src/tasks/tasks.controller.ts`

`updateStatus` now takes the caller and resolves access the same way every other
task operation does:

```ts
async updateStatus(
  taskId: Types.ObjectId,
  userId: Types.ObjectId,
  dto: UpdateTaskStatusDto,
): Promise<TaskDetail> {
  const task = await this.findTaskOrFail(taskId);
  const access = await this.projectAccessService.assertCanView(task.projectId, userId);

  task.status = dto.status;
  await task.save();

  return this.toDetail(task, access.project);
}
```

**Why `assertCanView` and not something stricter.** Moving a card across a board
is what a member of a project is _for_; it is not an edit of the task's content.
`update` keeps its stricter rule (`canManage || isCreator`) because that path
rewrites titles and descriptions. Tightening status changes to managers-only
would have fixed the security hole by breaking the product, and nothing in the
report asks for that. The bug was the absence of any boundary, not the
looseness of the boundary.

`assertCanView` also returns the project it already loaded, which the method
needs for serialization — so the fix removes a redundant project lookup that
`toDetail` was previously doing on its own.

### Regression prevention

- **A test that reproduces the report.** `apps/api/test/tasks.e2e.spec.ts`
  registers an outsider with no membership and asserts `403` _and_ that the task
  is still `TODO` afterwards. Asserting the status code alone would pass against
  a fix that rejects the request but writes anyway.
- **The test was proven to work.** As described above, it fails with
  `expected 403 "Forbidden", got 200 "OK"` when the check is removed. A
  regression test that has never failed is a guess.
- **The structural fix is the real prevention.** Access is answered in one place
  (`ProjectAccessService`), and every task mutation now takes `userId`. A future
  endpoint that forgets the check has to actively drop an argument it was given,
  which is a visible omission in review rather than an invisible one.
- **Neighbouring coverage.** `apps/api/test/task-assignee.e2e.spec.ts` and
  `apps/api/test/task-activity.e2e.spec.ts` both assert that a non-member gets
  `403`, so the two endpoints added in this assessment are held to the boundary
  from the start.

---

## Bug 2 — Concurrent task creation could produce duplicate task numbers

**Verdict:** confirmed, and it was a live correctness bug rather than a
theoretical one.

### Root cause

Task numbers were derived from a count taken in a separate round trip from the
insert that used it:

```ts
// apps/api/src/tasks/tasks.service.ts, before the fix
const taskCount = await this.taskModel.countDocuments({ projectId });
const number = taskCount + 1;
```

Read and write are two operations with a gap between them, and nothing holds the
value still across that gap. Two requests that arrive close together both count
`2`, both compute `3`, and both insert `ENG-3`. Nothing in the schema objected —
`number` was indexed but not unique — so the duplicates were accepted and
persisted.

This is not rare under normal use. A double-clicked submit button, a retried
request, an import script, or two people filing tickets during the same standup
are all enough.

### Impact

- Two tasks sharing a key (`ENG-3`) in the same project.
- `key` is the human identifier people paste into chat and commit messages, so
  the ambiguity is user-facing and permanent.
- Ordering by `number` becomes non-deterministic between the duplicates, which
  makes board order unstable across refreshes.
- Historic data may already contain duplicates; the fix prevents new ones but
  does not clean up existing rows (see Known Limitations in the README).

### Fix

**Decision: an atomic counter document, not a transaction.**

`apps/api/src/tasks/schemas/task-counter.schema.ts` (new) holds one document per
project with the highest number issued. Allocation is a single atomic
`findOneAndUpdate` with `$inc`:

```ts
const counter = await this.taskCounterModel
  .findOneAndUpdate({ projectId }, { $inc: { seq: 1 } }, { new: true, upsert: true })
  .exec();

return counter.seq;
```

MongoDB guarantees atomicity on a single document, so the read and the write
are one operation and concurrent callers cannot observe the same value.

**Why not a transaction.** A multi-document transaction would also work, but it
requires a replica set. Standalone MongoDB — which is what the README's local
setup and `mongodb-memory-server` in the test suite both use — does not support
them, so the fix would have been untestable in CI and would have imposed an
infrastructure requirement on every developer. A single-document counter needs
nothing beyond what the project already runs, and it is the cheaper operation of
the two at runtime.

**Why not just a retry loop on the unique index.** Retrying on duplicate-key
errors would work, but it turns a common case into an exception path and gets
slower precisely when contention is highest. The counter makes contention a
non-event.

**A unique index as the backstop.**
`TaskSchema.index({ projectId: 1, number: 1 }, { unique: true })` means the
database enforces the invariant independently of the application. If a future
code path allocates a number some other way, it fails loudly instead of
corrupting the project's numbering.

**Existing data.** Counters did not exist before this change, so a project's
first allocation seeds the counter from the highest number already in use
(`ensureCounterSeeded`) rather than restarting at 1. `$setOnInsert` makes it a
no-op once seeded, and a concurrent seed attempt loses harmlessly on the unique
`projectId` index.

### Regression prevention

- `apps/api/test/tasks.e2e.spec.ts` fires ten creates in parallel with
  `Promise.all` and asserts all ten return `201`, that the ten numbers are
  distinct, and that they are exactly `1..10`.
- **Proven to fail against the old code.** Reverting the allocation to
  `countDocuments() + 1` made **7 of the 10 requests return `500`** — the
  duplicates now being rejected by the unique index — so the test catches the
  bug through both of its defences.
- A second test creates rows directly in the database with no counter present
  and asserts the next API-created task is `ENG-3`, covering the upgrade path
  for projects that predate the counter.
