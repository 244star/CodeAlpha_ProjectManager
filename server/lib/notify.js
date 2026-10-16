const { query } = require("../db/connection");
const realtime = require("../realtime");

async function unreadCount(userId) {
  const rows = await query("SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND is_read = 0", [userId]);
  return Number(rows[0].total);
}

function mapNotification(row) {
  return {
    id: row.id,
    type: row.type,
    message: row.message,
    project_id: row.project_id,
    task_id: row.task_id,
    is_read: Boolean(Number(row.is_read)),
    created_at: row.created_at,
    actor: row.actor_id ? { id: row.actor_id, username: row.actor_username, name: row.actor_name } : null
  };
}

const NOTIFICATION_SELECT = `SELECT n.id, n.type, n.message, n.project_id, n.task_id, n.is_read, n.created_at,
         n.actor_id, a.username AS actor_username, a.name AS actor_name
    FROM notifications n LEFT JOIN users a ON a.id = n.actor_id`;

// Creates a notification for each user (never for the actor themselves) and
// pushes it to their open browser tabs. A failure here never breaks the request.
async function notify(userIds, { actorId, type, message, projectId = null, taskId = null }) {
  const recipients = [...new Set(userIds.filter(Boolean).map(Number))].filter((id) => id !== Number(actorId));
  const text = String(message).slice(0, 255);
  for (const userId of recipients) {
    try {
      const result = await query(
        "INSERT INTO notifications (user_id, actor_id, type, message, project_id, task_id) VALUES (?, ?, ?, ?, ?, ?)",
        [userId, actorId || null, type, text, projectId, taskId]
      );
      const rows = await query(`${NOTIFICATION_SELECT} WHERE n.id = ?`, [result.insertId]);
      realtime.sendToUser(userId, { type: "notification", notification: mapNotification(rows[0]), unread_count: await unreadCount(userId) });
    } catch (error) {
      console.error("Notification failed:", error.message);
    }
  }
}

module.exports = { notify, unreadCount, mapNotification, NOTIFICATION_SELECT };
