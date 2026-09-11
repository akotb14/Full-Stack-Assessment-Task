import { Controller, Get, Param, Query } from '@nestjs/common';
import type { Paginated, TaskActivityEntry } from '@projectflow/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { toObjectId } from '../common/utils/object-id';
import { ActivityService } from './activity.service';

@Controller('tasks/:taskId/activity')
export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}

  @Get()
  findByTask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Query() query: PaginationQueryDto,
  ): Promise<Paginated<TaskActivityEntry>> {
    return this.activityService.findByTask(
      toObjectId(taskId, 'task id'),
      toObjectId(userId, 'user id'),
      query,
    );
  }
}
