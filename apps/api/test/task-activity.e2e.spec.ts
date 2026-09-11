import type { INestApplication } from '@nestjs/common';
import type { Connection } from 'mongoose';
import request from 'supertest';
import type { TaskActivityEntry } from '@projectflow/shared';
import { OrganizationRole, ProjectRole, TaskActivityType } from '@projectflow/shared';
import { createTestApp, resetDatabase } from './utils/test-app';
import {
  addOrganizationMember,
  addProjectMember,
  authHeader,
  createOrganization,
  createProject,
  registerUser,
  type TestUser,
} from './utils/fixtures';

describe('Task activity', () => {
  let app: INestApplication;
  let connection: Connection;

  let manager: TestUser;
  let member: TestUser;
  let teammate: TestUser;
  let nonMember: TestUser;

  let projectId: string;
  let taskId: string;

  beforeAll(async () => {
    ({ app, connection } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(connection);

    manager = await registerUser(app, 'Nadia Rashid', 'nadia@example.com');
    member = await registerUser(app, 'Magd Ali', 'magd@example.com');
    teammate = await registerUser(app, 'Salma Farouk', 'salma@example.com');
    nonMember = await registerUser(app, 'Outside User', 'outside@example.com');

    const organizationId = await createOrganization(
      connection,
      'Acme Software',
      'acme-software',
      manager.id,
    );
    for (const user of [manager, member, teammate, nonMember]) {
      await addOrganizationMember(connection, organizationId, user.id, OrganizationRole.MEMBER);
    }

    projectId = await createProject(
      connection,
      organizationId,
      'Internal Platform',
      'ENG',
      manager.id,
    );
    await addProjectMember(connection, projectId, manager.id, ProjectRole.PROJECT_MANAGER);
    await addProjectMember(connection, projectId, member.id, ProjectRole.MEMBER);
    await addProjectMember(connection, projectId, teammate.id, ProjectRole.MEMBER);

    const created = await request(app.getHttpServer())
      .post(`/projects/${projectId}/tasks`)
      .set('Authorization', authHeader(manager))
      .send({ title: 'Improve API error handling' })
      .expect(201);

    taskId = created.body.id;
  });

  function assign(actor: TestUser, assigneeId: string | null) {
    return request(app.getHttpServer())
      .patch(`/tasks/${taskId}/assignee`)
      .set('Authorization', authHeader(actor))
      .send({ assigneeId });
  }

  function readActivity(actor: TestUser, query: Record<string, number> = {}) {
    return request(app.getHttpServer())
      .get(`/tasks/${taskId}/activity`)
      .query(query)
      .set('Authorization', authHeader(actor));
  }

  it('returns an empty page for a task with no history', async () => {
    const response = await readActivity(member).expect(200);

    expect(response.body).toMatchObject({ items: [], total: 0, page: 1 });
  });

  it('describes an assignment with the actor and both sides of the change', async () => {
    await assign(manager, teammate.id).expect(200);

    const response = await readActivity(member).expect(200);
    const [entry] = response.body.items as TaskActivityEntry[];

    expect(entry).toMatchObject({
      type: TaskActivityType.TASK_ASSIGNEE_CHANGED,
      actor: { id: manager.id, name: 'Nadia Rashid' },
      task: { id: taskId, key: 'ENG-1' },
      metadata: { from: null, to: { id: teammate.id, name: 'Salma Farouk' } },
    });
    expect(typeof entry!.createdAt).toBe('string');
  });

  it('represents all three assignee transitions', async () => {
    await assign(manager, member.id).expect(200);
    await assign(manager, teammate.id).expect(200);
    await assign(manager, null).expect(200);

    const response = await readActivity(member).expect(200);
    const items = response.body.items as TaskActivityEntry[];

    // Newest first, so the transitions read in reverse of how they happened.
    expect(
      items.map((entry) => [entry.metadata.from?.id ?? null, entry.metadata.to?.id ?? null]),
    ).toEqual([
      [teammate.id, null],
      [member.id, teammate.id],
      [null, member.id],
    ]);
  });

  it('returns history newest first', async () => {
    await assign(manager, member.id).expect(200);
    await assign(manager, teammate.id).expect(200);

    const response = await readActivity(member).expect(200);
    const items = response.body.items as TaskActivityEntry[];

    const timestamps = items.map((entry) => new Date(entry.createdAt).getTime());
    expect(timestamps[0]).toBeGreaterThanOrEqual(timestamps[1]!);
    expect(items[0]!.metadata.to?.id).toBe(teammate.id);
  });

  it('paginates without repeating or dropping entries', async () => {
    // Six alternating assignments produce six activity entries.
    for (const target of [member, teammate, member, teammate, member, teammate]) {
      await assign(manager, target.id).expect(200);
    }

    const first = await readActivity(member, { page: 1, pageSize: 4 }).expect(200);
    const second = await readActivity(member, { page: 2, pageSize: 4 }).expect(200);

    expect(first.body).toMatchObject({ total: 6, page: 1, pageSize: 4 });
    expect(first.body.items).toHaveLength(4);
    expect(second.body.items).toHaveLength(2);

    const ids = [...first.body.items, ...second.body.items].map(
      (entry: TaskActivityEntry) => entry.id,
    );
    expect(new Set(ids).size).toBe(6);
  });

  it('refuses to show history to a user outside the project', async () => {
    await assign(manager, member.id).expect(200);

    const response = await readActivity(nonMember).expect(403);

    expect(response.body).toMatchObject({ statusCode: 403, error: 'Forbidden' });
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get(`/tasks/${taskId}/activity`).expect(401);
  });

  it('returns 404 for a task that does not exist', async () => {
    await request(app.getHttpServer())
      .get('/tasks/64b7f9c2e4b0a1d2c3f40000/activity')
      .set('Authorization', authHeader(member))
      .expect(404);
  });

  it('rejects a malformed task id', async () => {
    await request(app.getHttpServer())
      .get('/tasks/not-an-object-id/activity')
      .set('Authorization', authHeader(member))
      .expect(400);
  });
});
