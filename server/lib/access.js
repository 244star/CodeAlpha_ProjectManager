const { query } = require("../db/connection");
const { parseId } = require("./validate");

// Loads :id as a project the signed-in user belongs to. Non-members get a 404 so
// the existence of other people's projects is not revealed.
async function loadProject(req, res, next) {
  try {
    const id = parseId(req.params.id);
    const rows = id
      ? await query(
          `SELECT p.id, p.name, p.description, p.owner_id, p.created_at, m.role
             FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
            WHERE p.id = ?`,
          [req.user.id, id]
        )
      : [];
    if (!rows[0]) return res.status(404).json({ error: "We could not find that project." });
    req.project = rows[0];
    next();
  } catch (error) {
    next(error);
  }
}

function requireOwner(req, res, next) {
  if (req.project.role !== "owner") return res.status(403).json({ error: "Only the project owner can do that." });
  next();
}

// Loads :id as a task inside a project the signed-in user belongs to.
async function loadTask(req, res, next) {
  try {
    const id = parseId(req.params.id);
    const rows = id
      ? await query(
          `SELECT t.id, t.project_id, t.title, t.status, t.assignee_id, t.created_by, m.role, p.name AS project_name
             FROM tasks t
             JOIN projects p ON p.id = t.project_id
             JOIN project_members m ON m.project_id = t.project_id AND m.user_id = ?
            WHERE t.id = ?`,
          [req.user.id, id]
        )
      : [];
    if (!rows[0]) return res.status(404).json({ error: "We could not find that task." });
    req.task = rows[0];
    next();
  } catch (error) {
    next(error);
  }
}

async function isProjectMember(projectId, userId) {
  const rows = await query("SELECT 1 AS ok FROM project_members WHERE project_id = ? AND user_id = ?", [projectId, userId]);
  return rows.length > 0;
}

async function listMembers(projectId) {
  const rows = await query(
    `SELECT u.id, u.username, u.name, m.role, m.joined_at
       FROM project_members m JOIN users u ON u.id = m.user_id
      WHERE m.project_id = ?
      ORDER BY m.role = 'owner' DESC, u.name, u.id`,
    [projectId]
  );
  return rows.map((row) => ({ id: row.id, username: row.username, name: row.name, role: row.role, joined_at: row.joined_at }));
}

module.exports = { loadProject, requireOwner, loadTask, isProjectMember, listMembers };
