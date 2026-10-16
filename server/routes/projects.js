const express = require("express");
const requireDatabase = require("../middleware/require-database");
const requireAuth = require("../middleware/require-auth");
const { pool, query } = require("../db/connection");
const realtime = require("../realtime");
const { notify } = require("../lib/notify");
const { loadProject, requireOwner, isProjectMember, listMembers } = require("../lib/access");
const { fetchProjectTasks, fetchTask, fetchTasksByIds, nextPosition } = require("../lib/tasks");
const { STATUSES, PRIORITIES, cleanString, normalizeUsername, parseId, parseDueDate } = require("../lib/validate");

const router = express.Router();
router.use(requireDatabase, requireAuth);

const MAX_PROJECTS_PER_USER = 50;
const MAX_MEMBERS = 50;
const MAX_TASKS = 500;

function mapProject(row) {
  return { id: row.id, name: row.name, description: row.description, owner_id: row.owner_id, created_at: row.created_at, role: row.role };
}

function parseProjectFields(body, { requireName }) {
  const fields = {};
  if (body?.name !== undefined || requireName) {
    const name = cleanString(body?.name);
    if (name.length < 2 || name.length > 80) return { error: "Give the project a name between 2 and 80 characters." };
    fields.name = name;
  }
  if (body?.description !== undefined) {
    const description = cleanString(body.description);
    if (description.length > 500) return { error: "The description can be at most 500 characters." };
    fields.description = description;
  }
  return { fields };
}

// Projects the signed-in user belongs to, with progress counts.
router.get("/", async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT p.id, p.name, p.description, p.owner_id, p.created_at, m.role,
              (SELECT COUNT(*) FROM project_members x WHERE x.project_id = p.id) AS members_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS tasks_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count
         FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
        ORDER BY p.id DESC`,
      [req.user.id]
    );
    res.json({
      projects: rows.map((row) => ({ ...mapProject(row), members_count: Number(row.members_count), tasks_count: Number(row.tasks_count), done_count: Number(row.done_count) }))
    });
  } catch (error) {
    next(error);
  }
});

router.post("/", async (req, res, next) => {
  const { fields, error } = parseProjectFields(req.body, { requireName: true });
  if (error) return res.status(400).json({ error });

  let connection;
  try {
    const owned = await query("SELECT COUNT(*) AS total FROM projects WHERE owner_id = ?", [req.user.id]);
    if (Number(owned[0].total) >= MAX_PROJECTS_PER_USER) return res.status(400).json({ error: `You can own up to ${MAX_PROJECTS_PER_USER} projects.` });

    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [result] = await connection.execute("INSERT INTO projects (name, description, owner_id) VALUES (?, ?, ?)", [fields.name, fields.description || "", req.user.id]);
    await connection.execute("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')", [result.insertId, req.user.id]);
    await connection.commit();
    const rows = await query(
      "SELECT p.id, p.name, p.description, p.owner_id, p.created_at, m.role FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = ? WHERE p.id = ?",
      [req.user.id, result.insertId]
    );
    res.status(201).json({ project: mapProject(rows[0]) });
  } catch (err) {
    if (connection) await connection.rollback().catch(() => {});
    next(err);
  } finally {
    if (connection) connection.release();
  }
});

// Everything the board needs in one request.
router.get("/:id", loadProject, async (req, res, next) => {
  try {
    const [members, tasks] = await Promise.all([listMembers(req.project.id), fetchProjectTasks(req.project.id)]);
    res.json({ project: mapProject(req.project), members, tasks });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id", loadProject, requireOwner, async (req, res, next) => {
  const { fields, error } = parseProjectFields(req.body, { requireName: false });
  if (error) return res.status(400).json({ error });
  const columns = Object.keys(fields);
  if (!columns.length) return res.status(400).json({ error: "There is nothing to update." });
  try {
    await query(`UPDATE projects SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`, [...columns.map((column) => fields[column]), req.project.id]);
    const project = mapProject({ ...req.project, ...fields });
    realtime.broadcast(project.id, { type: "project.updated", project: { id: project.id, name: project.name, description: project.description } });
    res.json({ project });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", loadProject, requireOwner, async (req, res, next) => {
  try {
    const members = await listMembers(req.project.id);
    await query("DELETE FROM projects WHERE id = ?", [req.project.id]);
    realtime.broadcast(req.project.id, { type: "project.deleted" });
    realtime.closeRoom(req.project.id);
    for (const member of members) realtime.sendToUser(member.id, { type: "projects.changed" });
    res.json({ deleted: true });
  } catch (error) {
    next(error);
  }
});

/* ---------- members ---------- */

router.post("/:id/members", loadProject, requireOwner, async (req, res, next) => {
  const username = normalizeUsername(req.body?.username);
  if (!username) return res.status(400).json({ error: "Enter the username of the person to add." });
  try {
    const users = await query("SELECT id, username, name FROM users WHERE username = ?", [username]);
    if (!users[0]) return res.status(404).json({ error: `No one has the username @${username}.` });
    if (await isProjectMember(req.project.id, users[0].id)) return res.status(409).json({ error: `${users[0].name} is already on this project.` });
    const count = await query("SELECT COUNT(*) AS total FROM project_members WHERE project_id = ?", [req.project.id]);
    if (Number(count[0].total) >= MAX_MEMBERS) return res.status(400).json({ error: `A project can have up to ${MAX_MEMBERS} members.` });

    await query("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'member')", [req.project.id, users[0].id]);
    const members = await listMembers(req.project.id);
    realtime.broadcast(req.project.id, { type: "members.changed", members });
    realtime.sendToUser(users[0].id, { type: "projects.changed" });
    await notify([users[0].id], {
      actorId: req.user.id,
      type: "member_added",
      message: `You were added to the project "${req.project.name}".`,
      projectId: req.project.id
    });
    res.status(201).json({ members });
  } catch (error) {
    next(error);
  }
});

// The owner can remove anyone; any member can remove themselves (leave).
router.delete("/:id/members/:userId", loadProject, async (req, res, next) => {
  const userId = parseId(req.params.userId);
  if (!userId) return res.status(404).json({ error: "That person is not on this project." });
  const leaving = userId === req.user.id;
  if (!leaving && req.project.role !== "owner") return res.status(403).json({ error: "Only the project owner can remove people." });
  if (userId === req.project.owner_id) return res.status(400).json({ error: "The owner cannot leave. Delete the project instead." });

  try {
    if (!(await isProjectMember(req.project.id, userId))) return res.status(404).json({ error: "That person is not on this project." });
    await query("DELETE FROM project_members WHERE project_id = ? AND user_id = ?", [req.project.id, userId]);
    const assigned = await query("SELECT id FROM tasks WHERE project_id = ? AND assignee_id = ?", [req.project.id, userId]);
    await query("UPDATE tasks SET assignee_id = NULL WHERE project_id = ? AND assignee_id = ?", [req.project.id, userId]);

    realtime.sendToUser(userId, { type: "member.removed", projectId: req.project.id });
    realtime.unsubscribeUser(req.project.id, userId);
    realtime.sendToUser(userId, { type: "projects.changed" });
    const members = await listMembers(req.project.id);
    realtime.broadcast(req.project.id, { type: "members.changed", members });
    if (assigned.length) realtime.broadcast(req.project.id, { type: "tasks.changed", tasks: await fetchTasksByIds(assigned.map((row) => row.id)) });
    if (!leaving) {
      await notify([userId], { actorId: req.user.id, type: "member_removed", message: `You were removed from the project "${req.project.name}".` });
    }
    res.json({ members });
  } catch (error) {
    next(error);
  }
});

/* ---------- tasks ---------- */

router.post("/:id/tasks", loadProject, async (req, res, next) => {
  const title = cleanString(req.body?.title);
  const description = cleanString(req.body?.description);
  const status = req.body?.status === undefined ? "todo" : req.body.status;
  const priority = req.body?.priority === undefined ? "medium" : req.body.priority;
  const dueDate = req.body?.due_date === undefined ? null : parseDueDate(req.body.due_date);
  const assigneeId = req.body?.assignee_id === undefined || req.body.assignee_id === null ? null : parseId(req.body.assignee_id);

  if (title.length < 1 || title.length > 120) return res.status(400).json({ error: "Give the task a title of up to 120 characters." });
  if (description.length > 2000) return res.status(400).json({ error: "The description can be at most 2000 characters." });
  if (!STATUSES.includes(status)) return res.status(400).json({ error: "Choose a valid status." });
  if (!PRIORITIES.includes(priority)) return res.status(400).json({ error: "Choose a valid priority." });
  if (dueDate === undefined) return res.status(400).json({ error: "Enter the due date as YYYY-MM-DD." });
  if (req.body?.assignee_id !== undefined && req.body.assignee_id !== null && !assigneeId) return res.status(400).json({ error: "Choose a valid assignee." });

  try {
    if (assigneeId && !(await isProjectMember(req.project.id, assigneeId))) return res.status(400).json({ error: "You can only assign tasks to people on this project." });
    const total = await query("SELECT COUNT(*) AS total FROM tasks WHERE project_id = ?", [req.project.id]);
    if (Number(total[0].total) >= MAX_TASKS) return res.status(400).json({ error: `A project can have up to ${MAX_TASKS} tasks.` });

    const position = await nextPosition({ execute: (sql, values) => pool.execute(sql, values) }, req.project.id, status);
    const result = await query(
      "INSERT INTO tasks (project_id, title, description, status, priority, due_date, assignee_id, created_by, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [req.project.id, title, description, status, priority, dueDate, assigneeId, req.user.id, position]
    );
    const task = await fetchTask(result.insertId);
    realtime.broadcast(req.project.id, { type: "tasks.changed", tasks: [task], actorId: req.user.id });
    if (assigneeId) {
      await notify([assigneeId], {
        actorId: req.user.id,
        type: "task_assigned",
        message: `${req.user.name || "Someone"} assigned you "${title}" in ${req.project.name}.`,
        projectId: req.project.id,
        taskId: task.id
      });
    }
    res.status(201).json({ task });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
