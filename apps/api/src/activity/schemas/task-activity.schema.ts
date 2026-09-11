import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';
import { TASK_ACTIVITY_TYPES, TaskActivityType } from '@projectflow/shared';

export type TaskActivityDocument = HydratedDocument<TaskActivity>;

/**
 * Append-only record of a change to a task. Entries are never updated, so only
 * `createdAt` is tracked.
 *
 * `fromUserId`/`toUserId` are nullable, which is what lets a single row express
 * all three assignee transitions: assigned (null -> user), reassigned
 * (user -> user) and unassigned (user -> null).
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'task_activities' })
export class TaskActivity {
  @Prop({ type: Types.ObjectId, ref: 'Task', required: true })
  taskId: Types.ObjectId;

  @Prop({ type: String, enum: TASK_ACTIVITY_TYPES, required: true })
  type: TaskActivityType;

  /** The user who performed the change. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  actorId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  fromUserId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  toUserId: Types.ObjectId | null;

  createdAt: Date;
}

export const TaskActivitySchema = SchemaFactory.createForClass(TaskActivity);

/**
 * Covers the only read pattern: one task's history, newest first. `_id` is the
 * tiebreaker so entries written in the same millisecond keep a stable order
 * across pages instead of shuffling between requests.
 */
TaskActivitySchema.index({ taskId: 1, createdAt: -1, _id: -1 });
