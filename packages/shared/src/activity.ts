/**
 * Activity is deliberately scoped to assignee changes for now. The enum exists
 * so new activity types can be added without changing the response contract.
 */
export enum TaskActivityType {
  TASK_ASSIGNEE_CHANGED = 'TASK_ASSIGNEE_CHANGED',
}

export const TASK_ACTIVITY_TYPES = Object.values(TaskActivityType);
