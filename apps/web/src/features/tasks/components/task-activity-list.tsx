'use client';

import { ClockCounterClockwiseIcon } from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';
import type { TaskActivityEntry, UserSummary } from '@projectflow/shared';
import { Avatar } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { useTaskActivity } from '../hooks';

function Name({ children }: { children: string }) {
  return <span className="font-medium text-foreground">{children}</span>;
}

/**
 * Names the user as seen from the actor's point of view, so someone acting on
 * their own assignment reads as "themselves" rather than having their name
 * repeated twice in one sentence.
 */
function Party({ user, actor }: { user: UserSummary; actor: UserSummary }) {
  return user.id === actor.id ? <>themselves</> : <Name>{user.name}</Name>;
}

/**
 * Turns one entry into a sentence a non-technical reader can follow, rather
 * than exposing the raw `from`/`to` pair. All three assignee transitions get
 * their own wording.
 */
function describe(entry: TaskActivityEntry): ReactNode {
  const { actor, metadata } = entry;
  const { from, to } = metadata;

  if (from === null && to !== null) {
    return (
      <>
        <Name>{actor.name}</Name> assigned <Party user={to} actor={actor} />
      </>
    );
  }

  if (from !== null && to === null) {
    return (
      <>
        <Name>{actor.name}</Name> removed the assignee
      </>
    );
  }

  if (from !== null && to !== null) {
    return (
      <>
        <Name>{actor.name}</Name> changed the assignee from <Party user={from} actor={actor} /> to{' '}
        <Party user={to} actor={actor} />
      </>
    );
  }

  // Not reachable through the API, which never records a change to nothing.
  return (
    <>
      <Name>{actor.name}</Name> changed this task
    </>
  );
}

export function TaskActivityList({ taskId }: { taskId: string }) {
  const { data, isPending, isError, error } = useTaskActivity(taskId);

  return (
    <section className="space-y-4" aria-label="Activity">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-foreground">Activity</h2>
        {data ? (
          <span className="rounded-sm bg-surface-strong px-1.5 text-[11px] text-muted-foreground">
            {data.total}
          </span>
        ) : null}
      </div>

      {isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-2/3" />
        </div>
      ) : isError ? (
        <p
          role="alert"
          className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-[13px] text-danger"
        >
          {error.message}
        </p>
      ) : data.items.length === 0 ? (
        <EmptyState
          icon={ClockCounterClockwiseIcon}
          title="No activity yet"
          description="Assignment changes to this task will show up here."
        />
      ) : (
        <ol className="space-y-3">
          {data.items.map((entry) => (
            <li key={entry.id} className="flex items-start gap-3">
              <Avatar user={entry.actor} size="sm" className="shrink-0" />
              <p className="min-w-0 flex-1 text-[13px] leading-6 text-muted-foreground">
                {describe(entry)}
              </p>
              {/* The exact timestamp stays available on hover for anyone who needs it. */}
              <time
                dateTime={entry.createdAt}
                title={formatDateTime(entry.createdAt)}
                className="shrink-0 text-[12px] leading-6 text-subtle-foreground"
              >
                {formatRelativeTime(entry.createdAt)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
