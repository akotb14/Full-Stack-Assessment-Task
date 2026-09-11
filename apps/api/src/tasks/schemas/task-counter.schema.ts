import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';

export type TaskCounterDocument = HydratedDocument<TaskCounter>;

/**
 * Per-project sequence used to hand out task numbers.
 *
 * One document per project, holding the highest number issued so far. Numbers
 * are allocated with a single atomic `findOneAndUpdate` + `$inc`, so two
 * concurrent creates always receive different values without needing a
 * multi-document transaction.
 */
@Schema({ timestamps: true, collection: 'task_counters' })
export class TaskCounter {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true, unique: true })
  projectId: Types.ObjectId;

  @Prop({ required: true, default: 0 })
  seq: number;
}

export const TaskCounterSchema = SchemaFactory.createForClass(TaskCounter);
