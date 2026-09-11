# AI Log

An honest account of where AI assistance was used in this assessment, what it
produced, and where I overrode it.

---

## 01 — Tools used

- **Claude Code (Opus 5)** in the VS Code extension — the only AI tool used, for
  the entire task. Used as an agent with repository access: reading files,
  writing code, running the test suite and the build, and running git.
- No autocomplete tool (Copilot or similar), no separate chat window, no other
  model.

Everything else was ordinary tooling: `pnpm`, Turborepo, Jest, Supertest,
`mongodb-memory-server`, ESLint, `tsc` and `next build`.

---

## 02 — How I used them

**As a reader before a writer.** The first substantial use was orientation:
mapping the module layout, tracing how `ProjectAccessService` is called from
each task endpoint, and finding where `TaskStatusSelect` establishes the
pattern a new selector should follow. In a codebase with an established
architecture, most of the work is finding the existing shape and matching it,
and that is a search problem before it is a writing problem.

**For first drafts of code whose shape was already decided.** The DTOs, the
schemas, the controller wiring, the TanStack Query hooks and the test scaffolding
were largely generated once I had decided what they should do. The value was
speed on mechanical work, not on design — the atomic-counter approach to
numbering, the nullable `from`/`to` pair as a single event shape, and the
decision to share `canManageProject` rather than duplicate it were decisions I
made and then asked for an implementation of.

**As an adversary against my own tests.** The most useful thing I did with it,
and the thing I would repeat. Both regression tests were verified by
_deliberately reintroducing the bug_ and confirming the test caught it:

- Reverting the allocation to `countDocuments() + 1` made **7 of 10 parallel
  creates return `500`**.
- Removing `assertCanView` from `updateStatus` produced
  `expected 403 "Forbidden", got 200 "OK"` — the reported production bug,
  reproduced exactly.

The code was then restored byte-identically and the suite re-run. A regression
test that has never failed is a guess, and running that loop by hand is tedious
enough that it often does not happen.

**For verification after every significant change.** `turbo run typecheck`,
`turbo run lint`, the full Jest suite (48 tests, ~3 minutes) and `next build`
were run after each part of the work rather than once at the end, which is how
two mistakes in section 04 were caught within minutes of being made.

**Not used for:** deciding what to build, resolving the brief's ambiguities,
choosing between the counter and a transaction, the permission model, or the
judgement calls documented in `ASSESSMENT_NOTES.md`. Those are the parts of the
task that are actually the task.

---

## 03 — Suggestions I rejected

### Timeline wording (rejected and rewritten)

The generated timeline produced sentences like _"Ammar assigned this task to
Magd"_, _"Magd reassigned this task from themselves to Ahmed"_ and _"Ahmed
removed Magd from this task"_. Defensible English, and wrong for this brief —
the specification gives a worked example of exactly how the section should read,
and it is terser than that:

```
Ammar assigned Magd
Magd changed the assignee from themselves to Ahmed
Ahmed removed the assignee
```

I rewrote `describe()` to produce that phrasing precisely, and moved the
relative timestamp into its own right-aligned `<time>` element to match the
layout in the example. When a brief shows you the output, matching it is not a
stylistic preference.

The one thing I kept from the draft is the `Party` component, which decides
between a name and _"themselves"_ based on whether the party is the actor. The
brief's second line depends on that distinction, and encoding it once beats
repeating the conditional in three places.

### Transactions for the numbering race (rejected on infrastructure grounds)

The first suggested fix for concurrent task creation wrapped the count and the
insert in a MongoDB transaction. It is a correct fix and I rejected it: multi-
document transactions require a replica set, and both the documented local setup
and `mongodb-memory-server` in the test suite run standalone. Adopting it would
have meant a fix that could not be tested in CI and an infrastructure
requirement imposed on every developer, to solve a problem a single-document
`$inc` solves with no new dependencies. Reasoning recorded in `BUG_REPORT.md`.

### A duplicated permission rule on the frontend (significantly changed)

The generated `useProjectPermissions` hook re-implemented the manage check
inline — `role === 'OWNER' || role === 'ADMIN' || projectRole === 'PROJECT_MANAGER'`
— as a second copy of a rule the API already owns. Two copies of an
authorization rule drift, and the copy that drifts silently is the one on the
client, where nothing tests it.

I extracted `canManageProject` into `packages/shared/src/roles.ts` and pointed
both `ProjectAccessService.canManage` and the frontend hook at it. The frontend
copy has no security value — it only decides whether a dropdown option is
disabled — but it should at least be the _same_ answer.

### The permission check on the wrong side of the change (corrected)

The first version of `updateAssignee` checked whether the _current_ assignee was
the caller, which reads naturally and enforces the wrong rule. The brief grants a
member the right to assign a task _to themselves_; that is a statement about the
target, not about who is being displaced. As written, a member could not claim an
unassigned task — the exact case the rule exists to permit.

The check now evaluates `next ?? previous`, so the target of the change is what
is authorized. The asymmetry that produces is intentional and documented: a
member may take a task from a colleague, but may not unassign one.

### A searchable combobox for the assignee selector (rejected)

Suggested on the basis that the brief mentions searchability. The brief says
_"searchable when appropriate"_, and for projects with single-digit membership
it is not — Radix `Select` already has typeahead, and a filter field over eight
names adds a control and an empty-state to design for no gain. Rejected with the
threshold written down (`ASSESSMENT_NOTES.md`) rather than silently.

### Showing the assignee on the board rows (rejected on scope)

Task rows show the creator's avatar; swapping it for the assignee was suggested
more than once and is genuinely a better product. It is also a change to what an
existing screen communicates, in a brief that says explicitly not to redesign the
application. Left alone, raised in `ASSESSMENT_NOTES.md`, and listed fourth in
_If I Had Two More Days_.

---

## 04 — Generated code I modified

### `ActivityService.toEntries` — resolving users per row

The first draft resolved each entry's actor and both assignee references with
their own `findById`, inside the map. For a 20-row page that is up to 61
queries — precisely the N+1 pattern the brief calls out as unacceptable for this
endpoint.

Rewritten to collect every referenced id across the whole page, fetch them in
one `$in` query, and resolve through a `Map`. Page size no longer affects query
count. The same pattern was already in `TasksService.toSummaries`, which is
where I should have pointed it in the first place.

### The optimistic update — reverse-patching instead of snapshotting

The generated `useUpdateTaskAssignee` undid a failed mutation by writing the
_previous assignee_ back into the cache. That is subtly wrong: it cannot restore
the state "nothing was cached for this query," so a failure on a cold cache
leaves behind a fabricated entry that never came from the server.

Changed to snapshot both affected caches in `onMutate` and restore them verbatim
in `onError`. I also added the `cancelQueries` calls, which the draft omitted —
without them an in-flight refetch can land after the optimistic write and put
the old value back, producing a flicker that looks exactly like a failed
mutation.

### `allocateTaskNumber` — restarting existing projects at 1

The counter implementation was correct for new projects and wrong for every
existing one: with no counter document, the first `$inc` returns 1, and a project
with forty tasks starts issuing `ENG-1` again — straight into the new unique
index and a `500`.

I added `ensureCounterSeeded`, which seeds the counter from the highest number
already in use before the first allocation, using `$setOnInsert` so it is a
no-op afterwards and a concurrent seed loses harmlessly on the unique
`projectId` index. The accompanying test inserts rows directly with no counter
present and asserts the next API-created task is `ENG-3`.

This is the clearest example of the failure mode worth watching for: generated
code that is correct for the case in front of it and silently wrong for the data
that already exists.

### Regression tests asserting only the status code

Both generated regression tests asserted the response status and stopped. A fix
that rejects the request _and writes anyway_ passes that test. I added the
follow-up assertions — the task is still `TODO` after the rejected status
change; the assignee is still `null` after the rejected assignment; no activity
row exists after either — so the tests assert the absence of the effect, not
just the presence of the error.

### `updateAssignee` — no-op detection

Not present in the draft. Re-selecting the current assignee, which the UI makes
easy, would have written a history entry recording that nothing changed. Added
an equality check that returns early before the write. The test
`records no activity when the assignee does not actually change` exists because
of it.

### Comments

Generated comments were consistently of the _"loop over the items"_ variety. I
removed those and wrote comments only where the code cannot explain itself —
why `_id` is the sort tiebreaker, why the snapshot is stored whole rather than
reconstructed, why `assertCanView` rather than a stricter check on status
changes, why `UNASSIGNED` needs a sentinel value. The codebase's existing
comments explain reasoning rather than mechanics, and the drafts did the
opposite.

### Git history

Left to itself the work would have landed as one large commit. I split it into
seven, ordered so each one builds and passes on its own — shared contracts,
then the API, then the fixes, then tests, then the frontend. That required
unwinding one commit (`git reset --soft`) after I noticed it staged the
`task-view.tsx` wiring for a component file that was still untracked, which
would have left a commit that did not compile.
