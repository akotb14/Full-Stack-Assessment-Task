import type { INestApplication } from '@nestjs/common';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { OrganizationRole, ProjectRole, TaskActivityType } from '@projectflow/shared';
import { createTestApp, resetDatabase } from './utils/test-app';
import {
  addOrganizationMember,
  addProjectMember,
  authHeader,
  createOrganization,
  createProject,
  findTaskActivity,
  registerUser,
  type TestUser,
} from './utils/fixtures';

describe('Task assignee', () => {
  let app: INestApplication;
  let connection: Connection;

  /** Organization OWNER, not a project member row — access via elevated role. */
  let owner: TestUser;
  /** Project PROJECT_MANAGER: may assign anyone. */
  let manager: TestUser;
  /** Plain project MEMBER: may only assign themselves. */
  let member: TestUser;
  /** A second plain project MEMBER, used as an assignment target. */
  let teammate: TestUser;
  /** In the organization but not on the project. */
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

    owner = await registerUser(app, 'Ammar Yaser', 'ammar@example.com');
    manager = await registerUser(app, 'Nadia Rashid', 'nadia@example.com');
    member = await registerUser(app, 'Magd Ali', 'magd@example.com');
    teammate = await registerUser(app, 'Salma Farouk', 'salma@example.com');
    nonMember = await registerUser(app, 'Outside User', 'outside@example.com');

    const organizationId = await createOrganization(
      connection,
      'Acme Software',
      'acme-software',
      owner.id,
    );
    await addOrganizationMember(connection, organizationId, owner.id, OrganizationRole.OWNER);
    for (const user of [manager, member, teammate, nonMember]) {
      await addOrganizationMember(connection, organizationId, user.id, OrganizationRole.MEMBER);
    }

    projectId = await createProject(
      connection,
      organizationId,
      'Internal Platform',
      'ENG',
      owner.id,
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

  it('creates tasks unassigned', async () => {
    const response = await request(app.getHttpServer())
      .get(`/tasks/${taskId}`)
      .set('Authorization', authHeader(member))
      .expect(200);

    expect(response.body.assignee).toBeNull();
  });

  it('lets a regular member assign a task to themselves', async () => {
    const response = await assign(member, member.id).expect(200);

    expect(response.body.assignee).toMatchObject({ id: member.id, email: 'magd@example.com' });
  });

  it('refuses to let a regular member assign a task to someone else', async () => {
    const response = await assign(member, teammate.id).expect(403);

    expect(response.body).toMatchObject({ statusCode: 403, error: 'Forbidden' });

    const task = await request(app.getHttpServer())
      .get(`/tasks/${taskId}`)
      .set('Authorization', authHeader(member))
      .expect(200);
    expect(task.body.assignee).toBeNull();
  });

  it('lets a project manager assign a task to another member', async () => {
    const response = await assign(manager, teammate.id).expect(200);

    expect(response.body.assignee).toMatchObject({ id: teammate.id });
  });

  it('lets an organization owner assign a task without a project membership row', async () => {
    const response = await assign(owner, teammate.id).expect(200);

    expect(response.body.assignee).toMatchObject({ id: teammate.id });
  });

  it('refuses to assign a task to a user who is not a project member', async () => {
    const response = await assign(manager, nonMember.id).expect(400);

    expect(response.body).toMatchObject({ statusCode: 400 });
    expect(response.body.message).toMatch(/member of this project/i);
  });

  it('lets a manager unassign a task', async () => {
    await assign(manager, teammate.id).expect(200);

    const response = await assign(manager, null).expect(200);

    expect(response.body.assignee).toBeNull();
  });

  it('lets a regular member unassign themselves but not a teammate', async () => {
    await assign(member, member.id).expect(200);
    const cleared = await assign(member, null).expect(200);
    expect(cleared.body.assignee).toBeNull();

    await assign(manager, teammate.id).expect(200);
    await assign(member, null).expect(403);
  });

  it('refuses assignment from a user outside the project', async () => {
    await assign(nonMember, nonMember.id).expect(403);
  });

  it('rejects an assignee id that is not a valid object id', async () => {
    await assign(manager, 'not-an-object-id').expect(400);
  });

  it('records one activity entry per assignee transition', async () => {
    await assign(manager, member.id).expect(200);
    await assign(manager, teammate.id).expect(200);
    await assign(manager, null).expect(200);

    const activity = await findTaskActivity(connection, taskId);

    expect(activity).toHaveLength(3);
    expect(activity.every((entry) => entry.type === TaskActivityType.TASK_ASSIGNEE_CHANGED)).toBe(
      true,
    );

    const transitions = activity.map((entry) => [
      entry.fromUserId ? String(entry.fromUserId) : null,
      entry.toUserId ? String(entry.toUserId) : null,
    ]);

    expect(transitions).toEqual([
      [null, member.id],
      [member.id, teammate.id],
      [teammate.id, null],
    ]);
  });

  it('records no activity when the assignee does not actually change', async () => {
    await assign(manager, member.id).expect(200);
    await assign(manager, member.id).expect(200);

    expect(await findTaskActivity(connection, taskId)).toHaveLength(1);
  });

  it('records no activity for a rejected assignment', async () => {
    await assign(member, teammate.id).expect(403);
    await assign(manager, nonMember.id).expect(400);

    expect(await findTaskActivity(connection, taskId)).toHaveLength(0);
  });

  it('returns the assignee in the project task list', async () => {
    await assign(manager, teammate.id).expect(200);

    const response = await request(app.getHttpServer())
      .get(`/projects/${projectId}/tasks`)
      .set('Authorization', authHeader(member))
      .expect(200);

    expect(response.body.items[0].assignee).toMatchObject({ id: teammate.id });
  });
});
