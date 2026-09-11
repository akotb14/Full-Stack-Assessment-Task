import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ProjectsModule } from '../projects/projects.module';
import { TasksModule } from '../tasks/tasks.module';
import { UsersModule } from '../users/users.module';
import { ActivityController } from './activity.controller';
import { ActivityService } from './activity.service';
import { TaskActivity, TaskActivitySchema } from './schemas/task-activity.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: TaskActivity.name, schema: TaskActivitySchema }]),
    TasksModule,
    ProjectsModule,
    UsersModule,
  ],
  controllers: [ActivityController],
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivityModule {}
