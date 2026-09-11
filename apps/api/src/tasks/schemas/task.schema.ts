import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TITLE_MAX_LENGTH,
  TaskPriority,
  TaskStatus,
} from '@projectflow/shared';

export type TaskDocument = HydratedDocument<Task>;

@Schema({ timestamps: true, collection: 'tasks' })
export class Task {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true, index: true })
  projectId: Types.ObjectId;

  @Prop({ required: true, min: 1 })
  number: number;

  @Prop({ required: true, uppercase: true, trim: true })
  key: string;

  @Prop({ required: true, trim: true, maxlength: TASK_TITLE_MAX_LENGTH })
  title: string;

  @Prop({ type: String, default: null })
  description?: string | null;

  @Prop({ type: String, enum: TASK_STATUSES, required: true, default: TaskStatus.TODO })
  status: TaskStatus;

  @Prop({ type: String, enum: TASK_PRIORITIES, required: true, default: TaskPriority.MEDIUM })
  priority: TaskPriority;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;

  /**
   * Who the task is currently assigned to, or null when unassigned. Distinct
   * from `createdBy`: the creator never changes, the assignee can.
   */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  assignee: Types.ObjectId | null;

  createdAt: Date;
  updatedAt: Date;
}

export const TaskSchema = SchemaFactory.createForClass(Task);

TaskSchema.index({ projectId: 1, status: 1 });
/**
 * Unique so a numbering race can never leave two tasks sharing a number. The
 * application allocates numbers atomically (see `TaskCounter`); this index is
 * the database-level guarantee behind that.
 */
TaskSchema.index({ projectId: 1, number: 1 }, { unique: true });
TaskSchema.index({ projectId: 1, assignee: 1 });
TaskSchema.index({ createdAt: -1 });
