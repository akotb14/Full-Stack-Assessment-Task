'use client';

import { ClockCounterClockwiseIcon } from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';
import type { TaskActivityEntry } from '@projectflow/shared';
import { Avatar } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { useTaskActivity } from '../hooks';

function Name({ children }: { children: string }) {
  return <span className="font-medium text-foreground">{children}</span>;
}

/**
 * Turns one entry into a sentence a non-technical reader can follow, rather than
 * exposing the raw `from`/`to` pair. All three assignee transitions get their
 * own wording, and acting on yourself reads as "themselves" instead of
 * repeating your own name twice in the same sentence.
 */
function describe(entry: TaskActivityEntry): ReactNode {
  const { actor, metadata } = entry;
  const { from, to } = metadata;

  if (from === null && to !== null) {
    return to.id === actor.id ? (
      <>
        <Name>{actor.name}</Name> assigned this task to themselves
      </>
    ) : (
      <>
        <Name>{actor.name}</Name> assigned this task to <Name>{to.name}</Name>
      </>
    );
  }

  if (from !== null && to === null) {
    return from.id === actor.id ? (
      <>
        <Name>{actor.name}</Name> removed themselves from this task
      </>
    ) : (
      <>
        <Name>{actor.name}</Name> removed <Name>{from.name}</Name> from this task
      </>
    );
  }

  if (from !== null && to !== null) {
    return to.id === actor.id ? (
      <>
        <Name>{actor.name}</Name> took this task over from <Name>{from.name}</Name>
      </>
    ) : (
      <>
        <Name>{actor.name}</Name> reassigned this task from <Name>{from.name}</Name> to{' '}
        <Name>{to.name}</Name>
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
            <li key={entry.id} className="flex gap-3">
              <Avatar user={entry.actor} size="sm" className="mt-0.5" />
              <p className="min-w-0 flex-1 text-[13px] leading-5 text-muted-foreground">
                {describe(entry)}{' '}
                {/* The exact timestamp stays available on hover for anyone who needs it. */}
                <time
                  dateTime={entry.createdAt}
                  title={formatDateTime(entry.createdAt)}
                  className="whitespace-nowrap text-subtle-foreground"
                >
                  {formatRelativeTime(entry.createdAt)}
                </time>
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
