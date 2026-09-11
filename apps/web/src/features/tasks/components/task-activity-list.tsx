'use client';

import {
  CaretLeftIcon,
  CaretRightIcon,
  ClockCounterClockwiseIcon,
} from '@phosphor-icons/react/dist/ssr';
import { type ReactNode, useState } from 'react';
import type { TaskActivityEntry, UserSummary } from '@projectflow/shared';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
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
  const [page, setPage] = useState(1);
  const { data, isPending, isError, error, isPlaceholderData } = useTaskActivity(taskId, page);

  // Derived from the `pageSize` the server echoes back rather than from the
  // client's constant, so the count reflects what was actually applied.
  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  // A page change is in flight while the previous page is still on screen.
  const isChangingPage = isPlaceholderData;

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
        <div className="space-y-3">
          <p
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-[13px] text-danger"
          >
            {error.message}
          </p>
          {/* A page that fails to load renders nothing, so the reader needs a
              way off it rather than being stranded. */}
          {page > 1 ? (
            <Button variant="secondary" size="sm" onClick={() => setPage(1)}>
              Back to the newest activity
            </Button>
          ) : null}
        </div>
      ) : data.total === 0 ? (
        <EmptyState
          icon={ClockCounterClockwiseIcon}
          title="No activity yet"
          description="Assignment changes to this task will show up here."
        />
      ) : (
        <>
          <ol
            aria-busy={isChangingPage}
            className={cn('space-y-3 transition-opacity', isChangingPage && 'opacity-50')}
          >
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

          {/*
           * Hidden entirely when the history fits on one page. `data.page` is
           * the page actually on screen, not the one being navigated to, so the
           * label and the disabled states never describe a page the reader
           * cannot see yet.
           */}
          {pageCount > 1 ? (
            <nav
              aria-label="Activity pages"
              className="flex items-center justify-between gap-3 border-t border-border pt-3"
            >
              <p aria-live="polite" className="text-[12px] text-subtle-foreground">
                Page {data.page} of {pageCount}
              </p>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={data.page <= 1 || isChangingPage}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  <CaretLeftIcon size={13} weight="bold" />
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={data.page >= pageCount || isChangingPage}
                  onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                >
                  Next
                  <CaretRightIcon size={13} weight="bold" />
                </Button>
              </div>
            </nav>
          ) : null}
        </>
      )}
    </section>
  );
}
