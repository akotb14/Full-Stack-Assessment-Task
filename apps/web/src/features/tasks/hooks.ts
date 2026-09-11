'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Paginated,
  TaskActivityEntry,
  TaskDetail,
  TaskStatus,
  TaskSummary,
  UserSummary,
} from '@projectflow/shared';
import { queryKeys } from '@/lib/query-keys';
import {
  createTask,
  type CreateTaskPayload,
  fetchProjectTasks,
  fetchTask,
  fetchTaskActivity,
  updateTaskAssignee,
  updateTaskStatus,
} from './api';

export function useProjectTasks(projectId: string) {
  return useQuery<Paginated<TaskSummary>>({
    queryKey: queryKeys.projectTasks(projectId),
    queryFn: () => fetchProjectTasks(projectId),
    enabled: projectId.length > 0,
  });
}

export function useTask(taskId: string) {
  return useQuery<TaskDetail>({
    queryKey: queryKeys.task(taskId),
    queryFn: () => fetchTask(taskId),
    enabled: taskId.length > 0,
  });
}

export function useCreateTask(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation<TaskDetail, Error, CreateTaskPayload>({
    mutationFn: (payload) => createTask(projectId, payload),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(projectId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
      ]);
    },
  });
}

export function useUpdateTaskStatus(taskId: string, projectId: string) {
  const queryClient = useQueryClient();

  return useMutation<TaskDetail, Error, TaskStatus>({
    mutationFn: (status) => updateTaskStatus(taskId, status),
    onSuccess: async (task) => {
      queryClient.setQueryData(queryKeys.task(taskId), task);
      await queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(projectId) });
    },
  });
}

/**
 * One page of history at a time, newest first. The previous page is kept on
 * screen while the next one loads, so paging reads as a swap rather than
 * collapsing the section back to a skeleton on every click.
 */
export function useTaskActivity(taskId: string, page: number) {
  return useQuery<Paginated<TaskActivityEntry>>({
    queryKey: queryKeys.taskActivityPage(taskId, page),
    queryFn: () => fetchTaskActivity(taskId, page),
    enabled: taskId.length > 0,
    placeholderData: keepPreviousData,
  });
}

export interface AssigneeChange {
  assigneeId: string | null;
  /**
   * The same user, resolved from the member list the selector already has, so
   * the optimistic update can paint a name and avatar instead of an id.
   */
  assignee: UserSummary | null;
}

/** Everything the optimistic write touched, kept so a failure can undo it. */
interface AssigneeSnapshot {
  task: TaskDetail | undefined;
  projectTasks: Paginated<TaskSummary> | undefined;
}

/**
 * Assignment is a small, self-contained change that almost always succeeds, so
 * the selector updates immediately and reverts if the request fails. The cache
 * is snapshotted rather than patched in reverse: restoring the previous value
 * verbatim also restores "nothing was cached", which re-deriving could not.
 */
export function useUpdateTaskAssignee(taskId: string, projectId: string) {
  const queryClient = useQueryClient();

  return useMutation<TaskDetail, Error, AssigneeChange, AssigneeSnapshot>({
    mutationFn: ({ assigneeId }) => updateTaskAssignee(taskId, assigneeId),

    onMutate: async ({ assignee }) => {
      // Without this, a refetch already in flight could land after the
      // optimistic write and put the old assignee back.
      await Promise.all([
        queryClient.cancelQueries({ queryKey: queryKeys.task(taskId) }),
        queryClient.cancelQueries({ queryKey: queryKeys.projectTasks(projectId) }),
      ]);

      const snapshot: AssigneeSnapshot = {
        task: queryClient.getQueryData<TaskDetail>(queryKeys.task(taskId)),
        projectTasks: queryClient.getQueryData<Paginated<TaskSummary>>(
          queryKeys.projectTasks(projectId),
        ),
      };

      queryClient.setQueryData<TaskDetail>(queryKeys.task(taskId), (current) =>
        current ? { ...current, assignee } : current,
      );
      queryClient.setQueryData<Paginated<TaskSummary>>(
        queryKeys.projectTasks(projectId),
        (current) =>
          current
            ? {
                ...current,
                items: current.items.map((item) =>
                  item.id === taskId ? { ...item, assignee } : item,
                ),
              }
            : current,
      );

      return snapshot;
    },

    onError: (_error, _change, snapshot) => {
      if (!snapshot) {
        return;
      }
      queryClient.setQueryData(queryKeys.task(taskId), snapshot.task);
      queryClient.setQueryData(queryKeys.projectTasks(projectId), snapshot.projectTasks);
    },

    // Runs after success and after a rollback, so the server stays the final
    // word either way. Activity is included because a successful change adds
    // an entry to the timeline — and the key is the page-less prefix, so every
    // page the reader has already visited is refreshed, not just page 1.
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(projectId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.taskActivity(taskId) }),
      ]);
    },
  });
}
