// End-to-end API + WebSocket tests against a real MySQL database.
// Run with: npm run test:integration   (needs the DB_* values in .env)
// The test creates its own users with a random suffix and deletes them afterwards.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');

const enabled = process.env.RUN_INTEGRATION_TESTS === 'true';
const skip = enabled ? false : 'set RUN_INTEGRATION_TESTS=true (npm run test:integration) to run';

test('project manager API end to end', { skip }, async (t) => {
  const app = require('../app');
  const realtime = require('../server/realtime');
  const { pool } = require('../server/db/connection');
  const { ensureDatabaseSchema } = require('../server/db/migrate');
  await ensureDatabaseSchema();

  const server = http.createServer(app);
  realtime.attach(server);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const suffix = Math.random().toString(36).slice(2, 8);
  const names = { a: `pma_${suffix}`, b: `pmb_${suffix}`, c: `pmc_${suffix}` };
  const sockets = [];

  async function call(method, path, { token, body } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  async function register(key) {
    const res = await call('POST', '/api/auth/register', {
      body: { name: `Tester ${key.toUpperCase()}`, username: names[key], email: `${names[key]}@example.com`, password: 'Password123!' }
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return { token: res.body.token, id: res.body.user.id };
  }

  // A WebSocket client that records every event it receives.
  function connect(token) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const events = [];
      const waiters = [];
      ws.on('message', (raw) => {
        const event = JSON.parse(raw.toString());
        events.push(event);
        for (const waiter of [...waiters]) if (waiter.match(event)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event); }
      });
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
      ws.on('error', reject);
      const client = {
        ws, events,
        send: (message) => ws.send(JSON.stringify(message)),
        waitFor: (type, timeout = 3000) => new Promise((res, rej) => {
          const found = events.find((e) => e.type === type && !e.__used);
          if (found) { found.__used = true; return res(found); }
          const waiter = { match: (e) => e.type === type, resolve: (e) => { e.__used = true; res(e); } };
          waiters.push(waiter);
          setTimeout(() => { const i = waiters.indexOf(waiter); if (i >= 0) { waiters.splice(i, 1); rej(new Error(`timed out waiting for ${type}`)); } }, timeout);
        })
      };
      sockets.push(ws);
      client.waitFor('ready').then(() => resolve(client), reject);
    });
  }
  const quiet = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

  let A, B, C, projectId, taskId;
  try {
    A = await register('a');
    B = await register('b');
    C = await register('c');

    await t.test('projects: create, list, and non-members cannot see them', async () => {
      assert.equal((await call('POST', '/api/projects', { body: { name: 'No auth' } })).status, 401);
      assert.equal((await call('POST', '/api/projects', { token: A.token, body: { name: 'x' } })).status, 400);
      const created = await call('POST', '/api/projects', { token: A.token, body: { name: 'Website redesign', description: 'Q4 launch' } });
      assert.equal(created.status, 201);
      assert.equal(created.body.project.role, 'owner');
      projectId = created.body.project.id;

      const mine = await call('GET', '/api/projects', { token: A.token });
      assert.ok(mine.body.projects.some((p) => p.id === projectId && p.members_count === 1 && p.tasks_count === 0));
      assert.equal((await call('GET', '/api/projects', { token: C.token })).body.projects.some((p) => p.id === projectId), false);
      assert.equal((await call('GET', `/api/projects/${projectId}`, { token: C.token })).status, 404);
      assert.equal((await call('GET', `/api/projects/${projectId}`)).status, 401);
      assert.equal((await call('GET', '/api/projects/abc', { token: A.token })).status, 404);
    });

    await t.test('members: only the owner adds people; duplicates and unknown users are rejected', async () => {
      assert.equal((await call('POST', `/api/projects/${projectId}/members`, { token: B.token, body: { username: names.c } })).status, 404, 'non-member cannot add');
      assert.equal((await call('POST', `/api/projects/${projectId}/members`, { token: A.token, body: { username: 'nobody_zz_here' } })).status, 404);
      const added = await call('POST', `/api/projects/${projectId}/members`, { token: A.token, body: { username: `@${names.b.toUpperCase()}` } });
      assert.equal(added.status, 201);
      assert.deepEqual(added.body.members.map((m) => m.username), [names.a, names.b]);
      assert.equal((await call('POST', `/api/projects/${projectId}/members`, { token: A.token, body: { username: names.b } })).status, 409);
      assert.equal((await call('POST', `/api/projects/${projectId}/members`, { token: B.token, body: { username: names.c } })).status, 403, 'plain member cannot add');
    });

    await t.test('realtime: sockets must authenticate and only join projects they belong to', async () => {
      const bad = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'garbage' })));
        ws.on('close', (code) => resolve(code));
      });
      assert.equal(bad, 4401);

      const wsC = await connect(C.token);
      wsC.send({ type: 'subscribe', projectId });
      await wsC.waitFor('subscribe.denied');
    });

    const wsA = await connect(A.token);
    const wsB = await connect(B.token);
    wsA.send({ type: 'subscribe', projectId });
    wsB.send({ type: 'subscribe', projectId });
    await wsA.waitFor('subscribed');
    await wsB.waitFor('subscribed');

    await t.test('tasks: create with validation, assignment, and live updates', async () => {
      const url = `/api/projects/${projectId}/tasks`;
      assert.equal((await call('POST', url, { token: C.token, body: { title: 'Sneaky' } })).status, 404);
      assert.equal((await call('POST', url, { token: A.token, body: { title: '' } })).status, 400);
      assert.equal((await call('POST', url, { token: A.token, body: { title: 'x', status: 'archived' } })).status, 400);
      assert.equal((await call('POST', url, { token: A.token, body: { title: 'x', priority: 'urgent' } })).status, 400);
      assert.equal((await call('POST', url, { token: A.token, body: { title: 'x', due_date: '2026-02-30' } })).status, 400);
      assert.equal((await call('POST', url, { token: A.token, body: { title: 'x', assignee_id: C.id } })).status, 400, 'cannot assign to a non-member');
      assert.equal((await call('POST', url, { token: A.token, body: { title: 'x', assignee_id: true } })).status, 400);

      const created = await call('POST', url, { token: A.token, body: { title: 'Design homepage', description: 'Hero + nav', priority: 'high', due_date: '2026-11-15', assignee_id: B.id } });
      assert.equal(created.status, 201);
      taskId = created.body.task.id;
      assert.equal(created.body.task.status, 'todo');
      assert.equal(created.body.task.due_date, '2026-11-15');
      assert.equal(created.body.task.assignee.username, names.b);

      const live = await wsB.waitFor('tasks.changed');
      assert.equal(live.tasks[0].id, taskId);
      assert.equal(live.projectId, projectId);
    });

    await t.test('notifications: assignee is notified live and over REST, and can mark them read', async () => {
      const pushed = await wsB.waitFor('notification');
      assert.match(pushed.notification.message, /assigned you/);
      assert.equal(pushed.unread_count, 2, 'added to the project, then assigned');

      const list = await call('GET', '/api/notifications', { token: B.token });
      assert.equal(list.body.unread_count, 2, 'added to project + assigned');
      assert.equal((await call('GET', '/api/notifications', { token: A.token })).body.unread_count, 0, 'actors are not notified about their own actions');

      const first = list.body.notifications[0];
      assert.equal((await call('POST', `/api/notifications/${first.id}/read`, { token: A.token })).status, 404, 'cannot touch someone else\'s notification');
      assert.equal((await call('POST', `/api/notifications/${first.id}/read`, { token: B.token })).body.unread_count, 1);
      assert.equal((await call('POST', '/api/notifications/read-all', { token: B.token })).body.unread_count, 0);
    });

    await t.test('board: tasks and ordering within columns', async () => {
      const url = `/api/projects/${projectId}/tasks`;
      const second = (await call('POST', url, { token: A.token, body: { title: 'Write copy' } })).body.task;
      const third = (await call('POST', url, { token: B.token, body: { title: 'Pick fonts' } })).body.task;
      const board = await call('GET', `/api/projects/${projectId}`, { token: B.token });
      assert.deepEqual(board.body.tasks.filter((x) => x.status === 'todo').map((x) => x.title), ['Design homepage', 'Write copy', 'Pick fonts']);
      assert.equal(board.body.members.length, 2);

      // drag "Pick fonts" to the top of the same column
      const moved = await call('POST', `/api/tasks/${third.id}/move`, { token: A.token, body: { status: 'todo', index: 0 } });
      assert.equal(moved.status, 200);
      const after = await call('GET', `/api/projects/${projectId}`, { token: A.token });
      assert.deepEqual(after.body.tasks.filter((x) => x.status === 'todo').map((x) => x.title), ['Pick fonts', 'Design homepage', 'Write copy']);

      // drag to another column
      await call('POST', `/api/tasks/${second.id}/move`, { token: A.token, body: { status: 'in_progress', index: 0 } });
      const cols = (await call('GET', `/api/projects/${projectId}`, { token: A.token })).body.tasks;
      assert.deepEqual(cols.filter((x) => x.status === 'in_progress').map((x) => x.title), ['Write copy']);
      assert.deepEqual(cols.filter((x) => x.status === 'todo').map((x) => x.title), ['Pick fonts', 'Design homepage']);

      assert.equal((await call('POST', `/api/tasks/${second.id}/move`, { token: A.token, body: { status: 'nope' } })).status, 400);
      assert.equal((await call('POST', `/api/tasks/${second.id}/move`, { token: A.token, body: { status: 'done', index: -2 } })).status, 400);
      assert.equal((await call('POST', `/api/tasks/${second.id}/move`, { token: C.token, body: { status: 'done' } })).status, 404);
    });

    await t.test('updating a task: fields, status via PATCH, reassignment, and done notifications', async () => {
      const url = `/api/tasks/${taskId}`;
      assert.equal((await call('PATCH', url, { token: A.token, body: {} })).status, 400);
      assert.equal((await call('PATCH', url, { token: A.token, body: { title: ' ' } })).status, 400);
      assert.equal((await call('PATCH', url, { token: C.token, body: { title: 'Hax' } })).status, 404);
      assert.equal((await call('PATCH', url, { token: A.token, body: { assignee_id: C.id } })).status, 400);

      const edited = await call('PATCH', url, { token: A.token, body: { title: 'Design the homepage', priority: 'low', due_date: null, assignee_id: null } });
      assert.equal(edited.body.task.title, 'Design the homepage');
      assert.equal(edited.body.task.due_date, null);
      assert.equal(edited.body.task.assignee, null);
      await call('PATCH', url, { token: A.token, body: { assignee_id: B.id } });
      await wsB.waitFor('notification');

      const before = (await call('GET', '/api/notifications', { token: A.token })).body.unread_count;
      const done = await call('PATCH', url, { token: B.token, body: { status: 'done' } });
      assert.equal(done.body.task.status, 'done');
      const notes = await call('GET', '/api/notifications', { token: A.token });
      assert.equal(notes.body.unread_count, before + 1, 'creator hears that B finished the task');
      assert.match(notes.body.notifications[0].message, /marked .* as done/);
    });

    await t.test('comments: add, list, notify, and delete with the right permissions', async () => {
      const url = `/api/tasks/${taskId}/comments`;
      assert.equal((await call('POST', url, { token: C.token, body: { content: 'let me in' } })).status, 404);
      assert.equal((await call('POST', url, { token: B.token, body: { content: '  ' } })).status, 400);
      assert.equal((await call('POST', url, { token: B.token, body: { content: 'x'.repeat(1001) } })).status, 400);
      const added = await call('POST', url, { token: B.token, body: { content: 'Mockups are ready <script>' } });
      assert.equal(added.status, 201);
      assert.equal(added.body.comment_count, 1);
      assert.equal(added.body.comment.can_delete, true);

      const live = await wsA.waitFor('comment.created');
      assert.equal(live.taskId, taskId);
      assert.equal(live.comment.content, 'Mockups are ready <script>');
      assert.equal(live.comment.can_delete, undefined, 'broadcast payload does not claim viewer permissions');

      const detail = await call('GET', `/api/tasks/${taskId}`, { token: A.token });
      assert.equal(detail.body.comments.length, 1);
      assert.equal(detail.body.comments[0].can_delete, true, 'owner can moderate');
      assert.equal(detail.body.task.comment_count, 1);

      const commentId = added.body.comment.id;
      assert.equal((await call('DELETE', `${url}/${commentId}`, { token: C.token })).status, 404);
      const removed = await call('DELETE', `${url}/${commentId}`, { token: A.token });
      assert.equal(removed.status, 200);
      assert.equal(removed.body.comment_count, 0);
      await wsB.waitFor('comment.deleted');
    });

    await t.test('deleting tasks: creator or owner only', async () => {
      const own = (await call('POST', `/api/projects/${projectId}/tasks`, { token: B.token, body: { title: 'B task' } })).body.task;
      const byA = (await call('POST', `/api/projects/${projectId}/tasks`, { token: A.token, body: { title: 'A task' } })).body.task;
      assert.equal((await call('DELETE', `/api/tasks/${byA.id}`, { token: B.token })).status, 403);
      assert.equal((await call('DELETE', `/api/tasks/${own.id}`, { token: B.token })).status, 200);
      assert.equal((await call('DELETE', `/api/tasks/${own.id}`, { token: B.token })).status, 404);
      assert.equal((await call('DELETE', `/api/tasks/${byA.id}`, { token: A.token })).status, 200);
      const gone = await wsB.waitFor('task.deleted');
      assert.ok(gone.taskId);
    });

    await t.test('my tasks lists assignments across projects', async () => {
      const second = (await call('POST', '/api/projects', { token: A.token, body: { name: 'Second project' } })).body.project;
      await call('POST', `/api/projects/${second.id}/tasks`, { token: A.token, body: { title: 'Solo task', assignee_id: A.id, due_date: '2026-12-01' } });
      const mine = await call('GET', '/api/tasks/assigned', { token: A.token });
      assert.ok(mine.body.tasks.some((x) => x.title === 'Solo task' && x.project_name === 'Second project'));
      assert.equal(mine.body.tasks.some((x) => x.title === 'Design the homepage'), false, 'tasks assigned to others are excluded');
      assert.equal((await call('GET', '/api/tasks/assigned')).status, 401);
    });

    await t.test('project settings: only the owner renames or deletes', async () => {
      assert.equal((await call('PATCH', `/api/projects/${projectId}`, { token: B.token, body: { name: 'Hijacked' } })).status, 403);
      assert.equal((await call('PATCH', `/api/projects/${projectId}`, { token: A.token, body: {} })).status, 400);
      const renamed = await call('PATCH', `/api/projects/${projectId}`, { token: A.token, body: { name: 'Website relaunch' } });
      assert.equal(renamed.body.project.name, 'Website relaunch');
      const live = await wsB.waitFor('project.updated');
      assert.equal(live.project.name, 'Website relaunch');
      assert.equal((await call('DELETE', `/api/projects/${projectId}`, { token: B.token })).status, 403);
    });

    await t.test('removing a member unassigns their tasks and cuts off their live feed', async () => {
      assert.equal((await call('DELETE', `/api/projects/${projectId}/members/${A.id}`, { token: A.token })).status, 400, 'owner cannot leave');
      assert.equal((await call('DELETE', `/api/projects/${projectId}/members/${B.id}`, { token: C.token })).status, 404);
      const t1 = (await call('POST', `/api/projects/${projectId}/tasks`, { token: A.token, body: { title: 'For B', assignee_id: B.id } })).body.task;

      const removed = await call('DELETE', `/api/projects/${projectId}/members/${B.id}`, { token: A.token });
      assert.equal(removed.status, 200);
      assert.deepEqual(removed.body.members.map((m) => m.username), [names.a]);
      await wsB.waitFor('member.removed');

      const board = await call('GET', `/api/projects/${projectId}`, { token: A.token });
      assert.equal(board.body.tasks.find((x) => x.id === t1.id).assignee, null);
      assert.equal((await call('GET', `/api/projects/${projectId}`, { token: B.token })).status, 404, 'B lost access');

      const seen = wsB.events.length;
      await call('POST', `/api/projects/${projectId}/tasks`, { token: A.token, body: { title: 'B must not see this' } });
      await quiet();
      assert.equal(wsB.events.slice(seen).some((e) => e.type === 'tasks.changed'), false, 'removed member gets no more events');
    });

    await t.test('members can leave a project on their own', async () => {
      await call('POST', `/api/projects/${projectId}/members`, { token: A.token, body: { username: names.c } });
      assert.equal((await call('DELETE', `/api/projects/${projectId}/members/${C.id}`, { token: C.token })).status, 200);
      assert.equal((await call('GET', `/api/projects/${projectId}`, { token: C.token })).status, 404);
    });

    await t.test('deleting a project removes its tasks and tells watchers', async () => {
      assert.equal((await call('DELETE', `/api/projects/${projectId}`, { token: A.token })).status, 200);
      await wsA.waitFor('project.deleted');
      assert.equal((await call('GET', `/api/projects/${projectId}`, { token: A.token })).status, 404);
      assert.equal((await call('GET', `/api/tasks/${taskId}`, { token: A.token })).status, 404);
    });

    await t.test('malformed JSON and unknown routes return clean errors', async () => {
      const res = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${A.token}` }, body: '{bad json' });
      assert.equal(res.status, 400);
      assert.equal((await call('GET', '/api/nope')).status, 404);
    });
  } finally {
    for (const ws of sockets) ws.terminate();
    await pool.query('DELETE FROM users WHERE username IN (?, ?, ?)', [names.a, names.b, names.c]);
    await realtime.close();
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
