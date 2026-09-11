import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Paginated, TaskActivityEntry, UserSummary } from '@projectflow/shared';
import type { PaginationQueryDto } from '../common/dto/pagination.dto';
import { toUserSummary } from '../common/utils/serialize';
import { ProjectAccessService } from '../projects/project-access.service';
import { TasksService } from '../tasks/tasks.service';
import { UsersService } from '../users/users.service';
import { TaskActivity, type TaskActivityDocument } from './schemas/task-activity.schema';

@Injectable()
export class ActivityService {
  constructor(
    @InjectModel(TaskActivity.name)
    private readonly activityModel: Model<TaskActivityDocument>,
    private readonly tasksService: TasksService,
    private readonly projectAccessService: ProjectAccessService,
    private readonly usersService: UsersService,
  ) {}

  async findByTask(
    taskId: Types.ObjectId,
    userId: Types.ObjectId,
    query: PaginationQueryDto,
  ): Promise<Paginated<TaskActivityEntry>> {
    const task = await this.tasksService.findTaskOrFail(taskId);
    await this.projectAccessService.assertCanView(task.projectId, userId);

    const [entries, total] = await Promise.all([
      this.activityModel
        .find({ taskId })
        .sort({ createdAt: -1, _id: -1 })
        .skip(query.skip)
        .limit(query.pageSize)
        .exec(),
      this.activityModel.countDocuments({ taskId }),
    ]);

    return {
      items: await this.toEntries(entries, { id: task._id.toString(), key: task.key }),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * Resolves every referenced user (actor, previous assignee, next assignee)
   * for the whole page in one query, so page size never drives query count.
   */
  private async toEntries(
    activities: TaskActivityDocument[],
    task: TaskActivityEntry['task'],
  ): Promise<TaskActivityEntry[]> {
    if (activities.length === 0) {
      return [];
    }

    const referencedIds = activities.flatMap((activity) =>
      [activity.actorId, activity.fromUserId, activity.toUserId].filter(
        (id): id is Types.ObjectId => id !== null && id !== undefined,
      ),
    );

    const users = await this.usersService.findManyByIds(referencedIds);
    const usersById = new Map(users.map((user) => [user._id.toString(), user]));

    const resolve = (id: Types.ObjectId | null): UserSummary | null => {
      if (!id) {
        return null;
      }
      const user = usersById.get(id.toString());
      return user ? toUserSummary(user) : DELETED_USER;
    };

    return activities.map((activity) => ({
      id: activity._id.toString(),
      type: activity.type,
      actor: resolve(activity.actorId) ?? DELETED_USER,
      task,
      metadata: {
        from: resolve(activity.fromUserId),
        to: resolve(activity.toUserId),
      },
      createdAt: activity.createdAt.toISOString(),
    }));
  }
}

/** Matches how tasks render a creator whose account no longer exists. */
const DELETED_USER: UserSummary = {
  id: '',
  name: 'Unknown user',
  email: '',
  avatarUrl: null,
};
