const express = require("express");
const requireDatabase = require("../middleware/require-database");
const requireAuth = require("../middleware/require-auth");
const { pool, query } = require("../db/connection");
const realtime = require("../realtime");
const { notify } = require("../lib/notify");
const { loadTask, isProjectMember } = require("../lib/access");
const { fetchTask, fetchTasksByIds, moveTask } = require("../lib/tasks");
const { STATUSES, PRIORITIES, cleanString, parseId, parseDueDate } = require("../lib/validate");

const router = express.Router();
router.use(requireDatabase, requireAuth);

const COMMENT_SELECT = `SELECT c.id, c.content, c.created_at, u.id AS author_id, u.username, u.name AS author_name
                          FROM comments c JOIN users u ON u.id = c.user_id`;

function publicUser(row) {
  return { id: row.author_id, username: row.username, name: row.author_name };
}

function mapComment(row, viewerId, isOwner) {
  return {
    id: row.id,
    content: row.content,
    created_at: row.created_at,
    author: publicUser(row),
    can_delete: viewerId === row.author_id || isOwner
  };
}

// Tasks assigned to me across all my projects.
router.get("/assigned", async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT t.id, t.project_id, t.title, t.status, t.priority, t.due_date, p.name AS project_name
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         JOIN project_members m ON m.project_id = t.project_id AND m.user_id = ?
        WHERE t.assignee_id = ?
        ORDER BY t.status = 'done', t.due_date IS NULL, t.due_date, t.id DESC
        LIMIT 200`,
      [req.user.id, req.user.id]
    );
    res.json({
      tasks: rows.map((row) => ({
        id: row.id, project_id: row.project_id, project_name: row.project_name, title: row.title,
        status: row.status, priority: row.priority, due_date: row.due_date || null
      }))
    });
  } catch (error) {
    next(error);
  }
});

router.use("/:id", loadTask);

router.get("/:id", async (req, res, next) => {
  try {
    const task = await fetchTask(req.task.id);
    const rows = await query(`${COMMENT_SELECT} WHERE c.task_id = ? ORDER BY c.id ASC LIMIT 200`, [req.task.id]);
    res.json({ task, comments: rows.map((row) => mapComment(row, req.user.id, req.task.role === "owner")) });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id", async (req, res, next) => {
  const body = req.body || {};
  const updates = {};

  if (body.title !== undefined) {
    const title = cleanString(body.title);
    if (title.length < 1 || title.length > 120) return res.status(400).json({ error: "Give the task a title of up to 120 characters." });
    updates.title = title;
  }
  if (body.description !== undefined) {
    const description = cleanString(body.description);
    if (description.length > 2000) return res.status(400).json({ error: "The description can be at most 2000 characters." });
    updates.description = description;
  }
  if (body.priority !== undefined) {
    if (!PRIORITIES.includes(body.priority)) return res.status(400).json({ error: "Choose a valid priority." });
    updates.priority = body.priority;
  }
  if (body.due_date !== undefined) {
    const dueDate = parseDueDate(body.due_date);
    if (dueDate === undefined) return res.status(400).json({ error: "Enter the due date as YYYY-MM-DD." });
    updates.due_date = dueDate;
  }
  let assigneeId;
  if (body.assignee_id !== undefined) {
    assigneeId = body.assignee_id === null ? null : parseId(body.assignee_id);
    if (assigneeId === null && body.assignee_id !== null) return res.status(400).json({ error: "Choose a valid assignee." });
    updates.assignee_id = assigneeId;
  }
  let newStatus;
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return res.status(400).json({ error: "Choose a valid status." });
    newStatus = body.status;
  }
  if (!Object.keys(updates).length && newStatus === undefined) return res.status(400).json({ error: "There is nothing to update." });

  let connection;
  try {
    if (assigneeId && !(await isProjectMember(req.task.project_id, assigneeId))) {
      return res.status(400).json({ error: "You can only assign tasks to people on this project." });
    }
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const columns = Object.keys(updates);
    if (columns.length) {
      await connection.execute(`UPDATE tasks SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`, [...columns.map((column) => updates[column]), req.task.id]);
    }
    let changedIds = [req.task.id];
    if (newStatus !== undefined && newStatus !== req.task.status) {
      changedIds = await moveTask(connection, req.task, newStatus, Infinity);
    }
    await connection.commit();

    const tasks = await fetchTasksByIds(changedIds);
    realtime.broadcast(req.task.project_id, { type: "tasks.changed", tasks, actorId: req.user.id });

    const actor = req.user.name || "Someone";
    if (assigneeId && assigneeId !== req.task.assignee_id) {
      await notify([assigneeId], {
        actorId: req.user.id, type: "task_assigned", projectId: req.task.project_id, taskId: req.task.id,
        message: `${actor} assigned you "${updates.title || req.task.title}" in ${req.task.project_name}.`
      });
    }
    if (newStatus === "done" && req.task.status !== "done") {
      await notify([req.task.created_by, assigneeId === undefined ? req.task.assignee_id : assigneeId], {
        actorId: req.user.id, type: "task_done", projectId: req.task.project_id, taskId: req.task.id,
        message: `${actor} marked "${updates.title || req.task.title}" as done in ${req.task.project_name}.`
      });
    }
    res.json({ task: tasks.find((task) => task.id === req.task.id) });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    next(error);
  } finally {
    if (connection) connection.release();
  }
});

// Drag-and-drop: put the task in a column at a given position.
router.post("/:id/move", async (req, res, next) => {
  const status = req.body?.status;
  const index = Number(req.body?.index);
  if (!STATUSES.includes(status)) return res.status(400).json({ error: "Choose a valid status." });
  if (req.body?.index !== undefined && (!Number.isInteger(index) || index < 0)) return res.status(400).json({ error: "Choose a valid position." });

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const changedIds = await moveTask(connection, req.task, status, req.body?.index === undefined ? Infinity : index);
    await connection.commit();

    const tasks = await fetchTasksByIds(changedIds);
    realtime.broadcast(req.task.project_id, { type: "tasks.changed", tasks, actorId: req.user.id });
    if (status === "done" && req.task.status !== "done") {
      await notify([req.task.created_by, req.task.assignee_id], {
        actorId: req.user.id, type: "task_done", projectId: req.task.project_id, taskId: req.task.id,
        message: `${req.user.name || "Someone"} marked "${req.task.title}" as done in ${req.task.project_name}.`
      });
    }
    res.json({ task: tasks.find((task) => task.id === req.task.id) });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    next(error);
  } finally {
    if (connection) connection.release();
  }
});

// The person who created a task, or the project owner, can delete it.
router.delete("/:id", async (req, res, next) => {
  if (req.task.role !== "owner" && req.task.created_by !== req.user.id) {
    return res.status(403).json({ error: "Only the person who created this task or the project owner can delete it." });
  }
  try {
    await query("DELETE FROM tasks WHERE id = ?", [req.task.id]);
    realtime.broadcast(req.task.project_id, { type: "task.deleted", taskId: req.task.id, actorId: req.user.id });
    res.json({ deleted: true });
  } catch (error) {
    next(error);
  }
});

/* ---------- comments ---------- */

router.get("/:id/comments", async (req, res, next) => {
  try {
    const rows = await query(`${COMMENT_SELECT} WHERE c.task_id = ? ORDER BY c.id ASC LIMIT 200`, [req.task.id]);
    res.json({ comments: rows.map((row) => mapComment(row, req.user.id, req.task.role === "owner")) });
  } catch (error) {
    next(error);
  }
});

async function commentCount(taskId) {
  const rows = await query("SELECT COUNT(*) AS total FROM comments WHERE task_id = ?", [taskId]);
  return Number(rows[0].total);
}

router.post("/:id/comments", async (req, res, next) => {
  const content = cleanString(req.body?.content);
  if (!content) return res.status(400).json({ error: "Write a comment first." });
  if (content.length > 1000) return res.status(400).json({ error: "Comments can be at most 1000 characters." });
  try {
    const result = await query("INSERT INTO comments (task_id, user_id, content) VALUES (?, ?, ?)", [req.task.id, req.user.id, content]);
    const rows = await query(`${COMMENT_SELECT} WHERE c.id = ?`, [result.insertId]);
    const total = await commentCount(req.task.id);
    const owner = req.task.role === "owner";
    // Broadcast without per-viewer permissions; each client works out what it may delete.
    const { can_delete: ignored, ...publicComment } = mapComment(rows[0], null, false);
    realtime.broadcast(req.task.project_id, {
      type: "comment.created", taskId: req.task.id, comment: publicComment, comment_count: total, actorId: req.user.id
    });
    await notify([req.task.assignee_id, req.task.created_by], {
      actorId: req.user.id, type: "comment", projectId: req.task.project_id, taskId: req.task.id,
      message: `${req.user.name || "Someone"} commented on "${req.task.title}" in ${req.task.project_name}.`
    });
    res.status(201).json({ comment: mapComment(rows[0], req.user.id, owner), comment_count: total });
  } catch (error) {
    next(error);
  }
});

// A comment can be removed by its author or by the project owner.
router.delete("/:id/comments/:commentId", async (req, res, next) => {
  const commentId = parseId(req.params.commentId);
  try {
    const rows = commentId ? await query("SELECT user_id FROM comments WHERE id = ? AND task_id = ?", [commentId, req.task.id]) : [];
    if (!rows[0]) return res.status(404).json({ error: "That comment does not exist." });
    if (rows[0].user_id !== req.user.id && req.task.role !== "owner") return res.status(403).json({ error: "You can only delete your own comments." });
    await query("DELETE FROM comments WHERE id = ?", [commentId]);
    const total = await commentCount(req.task.id);
    realtime.broadcast(req.task.project_id, { type: "comment.deleted", taskId: req.task.id, commentId, comment_count: total, actorId: req.user.id });
    res.json({ deleted: true, comment_count: total });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
