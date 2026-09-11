import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type FilterQuery, Model, Types } from 'mongoose';
import type { Paginated, TaskDetail, TaskSummary } from '@projectflow/shared';
import { TaskActivityType } from '@projectflow/shared';
import { TaskActivity, type TaskActivityDocument } from '../activity/schemas/task-activity.schema';
import { toUserSummary } from '../common/utils/serialize';
import { Comment, type CommentDocument } from '../comments/schemas/comment.schema';
import { ProjectMembersService } from '../project-members/project-members.service';
import { canManage, ProjectAccessService } from '../projects/project-access.service';
import { Project, type ProjectDocument } from '../projects/schemas/project.schema';
import { UsersService } from '../users/users.service';
import type { CreateTaskDto } from './dto/create-task.dto';
import type { ListTasksQueryDto } from './dto/list-tasks.dto';
import type { UpdateTaskDto } from './dto/update-task.dto';
import type { UpdateTaskAssigneeDto } from './dto/update-task-assignee.dto';
import type { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { TaskCounter, type TaskCounterDocument } from './schemas/task-counter.schema';
import { Task, type TaskDocument } from './schemas/task.schema';

@Injectable()
export class TasksService {
  constructor(
    @InjectModel(Task.name) private readonly taskModel: Model<TaskDocument>,
    @InjectModel(TaskCounter.name)
    private readonly taskCounterModel: Model<TaskCounterDocument>,
    @InjectModel(Project.name) private readonly projectModel: Model<ProjectDocument>,
    @InjectModel(Comment.name) private readonly commentModel: Model<CommentDocument>,
    @InjectModel(TaskActivity.name)
    private readonly activityModel: Model<TaskActivityDocument>,
    private readonly projectAccessService: ProjectAccessService,
    private readonly projectMembersService: ProjectMembersService,
    private readonly usersService: UsersService,
  ) {}

  async findByProject(
    projectId: Types.ObjectId,
    userId: Types.ObjectId,
    query: ListTasksQueryDto,
  ): Promise<Paginated<TaskSummary>> {
    await this.projectAccessService.assertCanView(projectId, userId);

    const filter: FilterQuery<TaskDocument> = { projectId };
    if (query.status) {
      filter.status = query.status;
    }
    if (query.priority) {
      filter.priority = query.priority;
    }

    const [tasks, total] = await Promise.all([
      this.taskModel.find(filter).sort({ number: 1 }).skip(query.skip).limit(query.pageSize).exec(),
      this.taskModel.countDocuments(filter),
    ]);

    return {
      items: await this.toSummaries(tasks),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async create(
    projectId: Types.ObjectId,
    userId: Types.ObjectId,
    dto: CreateTaskDto,
  ): Promise<TaskDetail> {
    const { project } = await this.projectAccessService.assertCanView(projectId, userId);

    const number = await this.allocateTaskNumber(projectId);

    const task = await this.taskModel.create({
      projectId,
      number,
      key: `${project.key}-${number}`,
      title: dto.title,
      description: dto.description ?? null,
      status: dto.status,
      priority: dto.priority,
      createdBy: userId,
      assignee: null,
    });

    return this.toDetail(task, project);
  }

  /**
   * Reserves the next task number for a project.
   *
   * A single `findOneAndUpdate` + `$inc` is atomic at the document level, so
   * two concurrent creates always receive different numbers. The previous
   * `countDocuments() + 1` read and wrote in separate steps, which let
   * simultaneous requests observe the same count and produce duplicate keys.
   */
  private async allocateTaskNumber(projectId: Types.ObjectId): Promise<number> {
    await this.ensureCounterSeeded(projectId);

    const counter = await this.taskCounterModel
      .findOneAndUpdate({ projectId }, { $inc: { seq: 1 } }, { new: true, upsert: true })
      .exec();

    return counter.seq;
  }

  /**
   * Counters were introduced after tasks already existed, so a project's first
   * allocation has to continue above the numbers already in use rather than
   * restarting at 1. `$setOnInsert` makes this a no-op once a counter exists.
   */
  private async ensureCounterSeeded(projectId: Types.ObjectId): Promise<void> {
    if (await this.taskCounterModel.exists({ projectId })) {
      return;
    }

    const highest = await this.taskModel
      .findOne({ projectId })
      .sort({ number: -1 })
      .select('number')
      .lean()
      .exec();

    try {
      await this.taskCounterModel.updateOne(
        { projectId },
        { $setOnInsert: { seq: highest?.number ?? 0 } },
        { upsert: true },
      );
    } catch (error) {
      // A concurrent request seeded the same counter first. Its value is
      // derived from the same data, so there is nothing left to do.
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }
  }

  async findOne(taskId: Types.ObjectId, userId: Types.ObjectId): Promise<TaskDetail> {
    const task = await this.findTaskOrFail(taskId);
    const { project } = await this.projectAccessService.assertCanView(task.projectId, userId);

    return this.toDetail(task, project);
  }

  async update(
    taskId: Types.ObjectId,
    userId: Types.ObjectId,
    dto: UpdateTaskDto,
  ): Promise<TaskDetail> {
    const task = await this.findTaskOrFail(taskId);
    const access = await this.projectAccessService.assertCanView(task.projectId, userId);

    const isCreator = task.createdBy.equals(userId);
    if (!canManage(access) && !isCreator) {
      throw new ForbiddenException('You do not have permission to edit this task');
    }

    if (dto.title !== undefined) {
      task.title = dto.title;
    }
    if (dto.description !== undefined) {
      task.description = dto.description;
    }
    if (dto.status !== undefined) {
      task.status = dto.status;
    }
    if (dto.priority !== undefined) {
      task.priority = dto.priority;
    }

    await task.save();

    return this.toDetail(task, access.project);
  }

  /**
   * Status changes are open to any project member — moving a card across the
   * board is not an edit of the task's content. The membership check is the
   * point: without it this endpoint accepted any authenticated caller.
   */
  async updateStatus(
    taskId: Types.ObjectId,
    userId: Types.ObjectId,
    dto: UpdateTaskStatusDto,
  ): Promise<TaskDetail> {
    const task = await this.findTaskOrFail(taskId);
    const access = await this.projectAccessService.assertCanView(task.projectId, userId);

    task.status = dto.status;
    await task.save();

    return this.toDetail(task, access.project);
  }

  /**
   * Assigns, reassigns or unassigns a task.
   *
   * Three rules are enforced here rather than in the client:
   *  1. the target user must hold a membership row on the task's project;
   *  2. members who cannot manage the project may only assign or unassign
   *     themselves, while OWNER/ADMIN/PROJECT_MANAGER may act on anyone;
   *  3. clearing the assignee is a valid change and is recorded like any other.
   */
  async updateAssignee(
    taskId: Types.ObjectId,
    userId: Types.ObjectId,
    dto: UpdateTaskAssigneeDto,
  ): Promise<TaskDetail> {
    const task = await this.findTaskOrFail(taskId);
    const access = await this.projectAccessService.assertCanView(task.projectId, userId);

    const previous = task.assignee ?? null;
    const next = dto.assigneeId === null ? null : new Types.ObjectId(dto.assigneeId);

    if (!canManage(access)) {
      const target = next ?? previous;
      if (target !== null && !target.equals(userId)) {
        throw new ForbiddenException('You can only change your own assignment on this task');
      }
    }

    if (next !== null) {
      const role = await this.projectMembersService.findRole(task.projectId, next);
      if (role === null) {
        throw new BadRequestException('The assignee must be a member of this project');
      }
    }

    const unchanged = previous === null ? next === null : next !== null && previous.equals(next);
    if (unchanged) {
      return this.toDetail(task, access.project);
    }

    task.assignee = next;
    await task.save();

    await this.activityModel.create({
      taskId: task._id,
      type: TaskActivityType.TASK_ASSIGNEE_CHANGED,
      actorId: userId,
      fromUserId: previous,
      toUserId: next,
    });

    return this.toDetail(task, access.project);
  }

  async remove(taskId: Types.ObjectId, userId: Types.ObjectId): Promise<void> {
    const task = await this.findTaskOrFail(taskId);
    await this.projectAccessService.assertCanManage(task.projectId, userId);

    await Promise.all([this.commentModel.deleteMany({ taskId: task._id }), task.deleteOne()]);
  }

  async findTaskOrFail(taskId: Types.ObjectId): Promise<TaskDocument> {
    const task = await this.taskModel.findById(taskId).exec();
    if (!task) {
      throw new NotFoundException('Task not found');
    }
    return task;
  }

  private async toSummaries(tasks: TaskDocument[]): Promise<TaskSummary[]> {
    if (tasks.length === 0) {
      return [];
    }

    const [users, commentRows] = await Promise.all([
      // Creators and assignees resolve in one query; `$in` de-duplicates the
      // overlap, so page size never changes the number of round trips.
      this.usersService.findManyByIds(
        tasks.flatMap((task) => (task.assignee ? [task.createdBy, task.assignee] : [task.createdBy])),
      ),
      this.commentModel
        .aggregate<{
          _id: Types.ObjectId;
          count: number;
        }>([
          { $match: { taskId: { $in: tasks.map((task) => task._id) } } },
          { $group: { _id: '$taskId', count: { $sum: 1 } } },
        ])
        .exec(),
    ]);

    const usersById = new Map(users.map((user) => [user._id.toString(), user]));
    const commentCounts = new Map(commentRows.map((row) => [row._id.toString(), row.count]));

    return tasks.map((task) => ({
      id: task._id.toString(),
      projectId: task.projectId.toString(),
      number: task.number,
      key: task.key,
      title: task.title,
      status: task.status,
      priority: task.priority,
      commentCount: commentCounts.get(task._id.toString()) ?? 0,
      createdBy: toCreatorSummary(usersById.get(task.createdBy.toString())),
      assignee: task.assignee ? toCreatorSummary(usersById.get(task.assignee.toString())) : null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    }));
  }

  private async toDetail(task: TaskDocument, project?: ProjectDocument): Promise<TaskDetail> {
    const [summary] = await this.toSummaries([task]);
    const resolvedProject = project ?? (await this.projectModel.findById(task.projectId).exec());

    if (!resolvedProject) {
      throw new NotFoundException('Project not found');
    }

    return {
      ...summary!,
      description: task.description ?? null,
      project: {
        id: resolvedProject._id.toString(),
        name: resolvedProject.name,
        key: resolvedProject.key,
      },
    };
  }
}

const DELETED_USER = {
  id: '',
  name: 'Unknown user',
  email: '',
  avatarUrl: null,
};

function toCreatorSummary(user: Parameters<typeof toUserSummary>[0] | undefined) {
  return user ? toUserSummary(user) : DELETED_USER;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}
