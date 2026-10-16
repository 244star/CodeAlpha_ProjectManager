const { query } = require("../db/connection");
const { reorder } = require("./order");

const TASK_SELECT = `SELECT t.id, t.project_id, t.title, t.description, t.status, t.priority, t.due_date, t.position,
         t.created_by, t.created_at, t.updated_at, t.assignee_id, a.username AS assignee_username, a.name AS assignee_name,
         (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count
    FROM tasks t LEFT JOIN users a ON a.id = t.assignee_id`;

function mapTask(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    due_date: row.due_date || null,
    position: row.position,
    created_by: row.created_by || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    comment_count: Number(row.comment_count),
    assignee: row.assignee_id ? { id: row.assignee_id, username: row.assignee_username, name: row.assignee_name } : null
  };
}

async function fetchTask(id) {
  const rows = await query(`${TASK_SELECT} WHERE t.id = ?`, [id]);
  return rows[0] ? mapTask(rows[0]) : null;
}

async function fetchTasksByIds(ids) {
  if (!ids.length) return [];
  const rows = await query(`${TASK_SELECT} WHERE t.id IN (${ids.map(() => "?").join(", ")}) ORDER BY t.position, t.id`, ids);
  return rows.map(mapTask);
}

async function fetchProjectTasks(projectId) {
  const rows = await query(`${TASK_SELECT} WHERE t.project_id = ? ORDER BY t.position, t.id`, [projectId]);
  return rows.map(mapTask);
}

async function nextPosition(executor, projectId, status) {
  const [rows] = await executor.execute("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM tasks WHERE project_id = ? AND status = ?", [projectId, status]);
  return Number(rows[0].next);
}

// Moves a task to `status` at `index` inside an open transaction and returns the
// ids of every task whose status or position changed.
async function moveTask(connection, task, status, index) {
  const [rows] = await connection.execute(
    "SELECT id, position FROM tasks WHERE project_id = ? AND status = ? AND id <> ? ORDER BY position, id FOR UPDATE",
    [task.project_id, status, task.id]
  );
  const currentOrder = rows.map((row) => row.id);
  const positions = new Map(rows.map((row) => [row.id, row.position]));
  const newOrder = reorder(currentOrder, task.id, index);

  const changed = [task.id];
  await connection.execute("UPDATE tasks SET status = ?, position = ? WHERE id = ?", [status, newOrder.indexOf(task.id), task.id]);
  for (let position = 0; position < newOrder.length; position += 1) {
    const id = newOrder[position];
    if (id === task.id || positions.get(id) === position) continue;
    await connection.execute("UPDATE tasks SET position = ? WHERE id = ?", [position, id]);
    changed.push(id);
  }
  return changed;
}

module.exports = { fetchTask, fetchTasksByIds, fetchProjectTasks, nextPosition, moveTask };
