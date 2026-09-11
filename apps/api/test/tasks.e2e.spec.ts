import type { INestApplication } from '@nestjs/common';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { OrganizationRole, ProjectRole, TaskPriority, TaskStatus } from '@projectflow/shared';
import { createTestApp, resetDatabase } from './utils/test-app';
import {
  addOrganizationMember,
  addProjectMember,
  authHeader,
  createOrganization,
  createProject,
  createTask,
  registerUser,
  type TestUser,
} from './utils/fixtures';

describe('Tasks', () => {
  let app: INestApplication;
  let connection: Connection;

  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let projectId: string;

  beforeAll(async () => {
    ({ app, connection } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(connection);

    owner = await registerUser(app, 'Ammar Yaser', 'ammar@example.com');
    member = await registerUser(app, 'Magd Ali', 'magd@example.com');
    outsider = await registerUser(app, 'Outside User', 'outside@example.com');

    const organizationId = await createOrganization(
      connection,
      'Acme Software',
      'acme-software',
      owner.id,
    );
    await addOrganizationMember(connection, organizationId, owner.id, OrganizationRole.OWNER);
    await addOrganizationMember(connection, organizationId, member.id, OrganizationRole.MEMBER);

    projectId = await createProject(
      connection,
      organizationId,
      'Internal Platform',
      'ENG',
      owner.id,
    );
    await addProjectMember(connection, projectId, member.id, ProjectRole.MEMBER);
  });

  it('lets a project member create a task', async () => {
    const response = await request(app.getHttpServer())
      .post(`/projects/${projectId}/tasks`)
      .set('Authorization', authHeader(member))
      .send({
        title: 'Improve API error handling',
        description: 'Normalise validation and permission errors.',
        priority: TaskPriority.HIGH,
      })
      .expect(201);

    expect(response.body).toMatchObject({
      key: 'ENG-1',
      number: 1,
      title: 'Improve API error handling',
      status: TaskStatus.TODO,
      priority: TaskPriority.HIGH,
    });
    expect(response.body.createdBy).toMatchObject({ email: 'magd@example.com' });
  });

  it('numbers tasks sequentially within a project', async () => {
    for (const title of ['First task', 'Second task', 'Third task']) {
      await request(app.getHttpServer())
        .post(`/projects/${projectId}/tasks`)
        .set('Authorization', authHeader(member))
        .send({ title })
        .expect(201);
    }

    const response = await request(app.getHttpServer())
      .get(`/projects/${projectId}/tasks`)
      .set('Authorization', authHeader(member))
      .expect(200);

    expect(response.body.total).toBe(3);
    expect(response.body.items.map((task: { key: string }) => task.key)).toEqual([
      'ENG-1',
      'ENG-2',
      'ENG-3',
    ]);
  });

  it('refuses to create a task for someone outside the project', async () => {
    await request(app.getHttpServer())
      .post(`/projects/${projectId}/tasks`)
      .set('Authorization', authHeader(outsider))
      .send({ title: 'Should not be created' })
      .expect(403);
  });

  it('refuses to list tasks for someone outside the project', async () => {
    await request(app.getHttpServer())
      .get(`/projects/${projectId}/tasks`)
      .set('Authorization', authHeader(outsider))
      .expect(403);
  });

  it('rejects a task without a usable title', async () => {
    const response = await request(app.getHttpServer())
      .post(`/projects/${projectId}/tasks`)
      .set('Authorization', authHeader(member))
      .send({ title: 'ab' })
      .expect(400);

    expect(response.body.statusCode).toBe(400);
  });

  it('filters the task list by status', async () => {
    await request(app.getHttpServer())
      .post(`/projects/${projectId}/tasks`)
      .set('Authorization', authHeader(member))
      .send({ title: 'Work in flight', status: TaskStatus.IN_PROGRESS })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/projects/${projectId}/tasks`)
      .set('Authorization', authHeader(member))
      .send({ title: 'Not started yet' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get(`/projects/${projectId}/tasks`)
      .query({ status: TaskStatus.IN_PROGRESS })
      .set('Authorization', authHeader(member))
      .expect(200);

    expect(response.body.total).toBe(1);
    expect(response.body.items[0]).toMatchObject({ title: 'Work in flight' });
  });

  describe('status updates', () => {
    let taskId: string;

    beforeEach(async () => {
      const created = await request(app.getHttpServer())
        .post(`/projects/${projectId}/tasks`)
        .set('Authorization', authHeader(member))
        .send({ title: 'Improve API error handling' })
        .expect(201);

      taskId = created.body.id;
    });

    it('lets a project member move a task across the board', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/tasks/${taskId}/status`)
        .set('Authorization', authHeader(member))
        .send({ status: TaskStatus.IN_REVIEW })
        .expect(200);

      expect(response.body.status).toBe(TaskStatus.IN_REVIEW);
    });

    /**
     * Regression test for the reported production bug: this endpoint used to
     * accept any authenticated caller, so a user with no membership on the
     * project could change the status of its tasks.
     */
    it('refuses a status change from a user outside the project', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/tasks/${taskId}/status`)
        .set('Authorization', authHeader(outsider))
        .send({ status: TaskStatus.DONE })
        .expect(403);

      expect(response.body).toMatchObject({ statusCode: 403, error: 'Forbidden' });

      const task = await request(app.getHttpServer())
        .get(`/tasks/${taskId}`)
        .set('Authorization', authHeader(member))
        .expect(200);
      expect(task.body.status).toBe(TaskStatus.TODO);
    });

    it('requires authentication for a status change', async () => {
      await request(app.getHttpServer())
        .patch(`/tasks/${taskId}/status`)
        .send({ status: TaskStatus.DONE })
        .expect(401);
    });
  });

  /**
   * Regression test for the task numbering race. Numbers used to come from
   * `countDocuments() + 1`, so concurrent creates read the same count and
   * produced duplicates.
   */
  it('gives concurrent creates distinct numbers and keys', async () => {
    const attempts = 10;

    const responses = await Promise.all(
      Array.from({ length: attempts }, (_, index) =>
        request(app.getHttpServer())
          .post(`/projects/${projectId}/tasks`)
          .set('Authorization', authHeader(member))
          .send({ title: `Concurrent task ${index + 1}` }),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual(
      Array.from({ length: attempts }, () => 201),
    );

    const numbers = responses.map((response) => response.body.number as number);
    const keys = responses.map((response) => response.body.key as string);

    expect(new Set(numbers).size).toBe(attempts);
    expect(new Set(keys).size).toBe(attempts);
    expect([...numbers].sort((a, b) => a - b)).toEqual(
      Array.from({ length: attempts }, (_, index) => index + 1),
    );
  });

  it('continues numbering above tasks that predate the counter', async () => {
    // Simulates existing data: rows inserted directly, with no counter document.
    await createTask(connection, projectId, 'ENG', 1, 'Legacy first', member.id);
    await createTask(connection, projectId, 'ENG', 2, 'Legacy second', member.id);

    const response = await request(app.getHttpServer())
      .post(`/projects/${projectId}/tasks`)
      .set('Authorization', authHeader(member))
      .send({ title: 'Created after the counter landed' })
      .expect(201);

    expect(response.body).toMatchObject({ number: 3, key: 'ENG-3' });
  });
});
