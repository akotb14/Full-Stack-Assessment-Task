'use client';

import { toast } from 'sonner';
import type { UserSummary } from '@projectflow/shared';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useProjectMembers } from '@/features/projects/hooks';
import { useProjectPermissions } from '@/features/projects/permissions';
import { useUpdateTaskAssignee } from '../hooks';

interface TaskAssigneeSelectProps {
  taskId: string;
  projectId: string;
  assignee: UserSummary | null;
}

/**
 * Radix requires a non-empty value for every item, so "unassigned" needs a
 * sentinel that cannot collide with a Mongo object id.
 */
const UNASSIGNED = '__unassigned__';

export function TaskAssigneeSelect({ taskId, projectId, assignee }: TaskAssigneeSelectProps) {
  const { data: members, isPending, isError, error } = useProjectMembers(projectId);
  const { currentUserId, canManage } = useProjectPermissions(projectId);
  const updateAssignee = useUpdateTaskAssignee(taskId, projectId);

  if (isPending) {
    return <Skeleton className="h-8 w-full" />;
  }

  if (isError) {
    return (
      <p role="alert" className="text-[13px] text-danger">
        {error.message}
      </p>
    );
  }

  if (members.length === 0) {
    return (
      <p className="text-[13px] italic text-subtle-foreground">
        This project has no members to assign.
      </p>
    );
  }

  // A member who cannot manage the project may only put the task on themselves
  // or take it off themselves, so every other name is shown but not selectable.
  const canSelect = (userId: string) => canManage || userId === currentUserId;
  const canUnassign = canManage || assignee === null || assignee.id === currentUserId;

  // Without the ability to change anything, a dropdown would be a dead control.
  if (!canManage && !members.some((member) => canSelect(member.user.id))) {
    return (
      <p className="text-[13px] text-foreground">{assignee ? assignee.name : 'Unassigned'}</p>
    );
  }

  return (
    <Select
      value={assignee ? assignee.id : UNASSIGNED}
      disabled={updateAssignee.isPending}
      onValueChange={(value) => {
        const nextId = value === UNASSIGNED ? null : value;
        const next = nextId
          ? (members.find((member) => member.user.id === nextId)?.user ?? null)
          : null;

        updateAssignee.mutate(
          { assigneeId: nextId, assignee: next },
          { onError: (mutationError) => toast.error(mutationError.message) },
        );
      }}
    >
      <SelectTrigger aria-label="Task assignee" aria-busy={updateAssignee.isPending}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNASSIGNED} disabled={!canUnassign}>
          Unassigned
        </SelectItem>
        {members.map((member) => (
          <SelectItem
            key={member.user.id}
            value={member.user.id}
            disabled={!canSelect(member.user.id)}
          >
            {member.user.id === currentUserId ? `${member.user.name} (you)` : member.user.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
