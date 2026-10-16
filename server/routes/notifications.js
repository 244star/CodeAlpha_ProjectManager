const express = require("express");
const requireDatabase = require("../middleware/require-database");
const requireAuth = require("../middleware/require-auth");
const { query } = require("../db/connection");
const { mapNotification, unreadCount, NOTIFICATION_SELECT } = require("../lib/notify");
const { parseId } = require("../lib/validate");

const router = express.Router();
router.use(requireDatabase, requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const rows = await query(`${NOTIFICATION_SELECT} WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 30`, [req.user.id]);
    res.json({ notifications: rows.map(mapNotification), unread_count: await unreadCount(req.user.id) });
  } catch (error) {
    next(error);
  }
});

router.post("/read-all", async (req, res, next) => {
  try {
    await query("UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0", [req.user.id]);
    res.json({ unread_count: 0 });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/read", async (req, res, next) => {
  const id = parseId(req.params.id);
  try {
    const result = id ? await query("UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?", [id, req.user.id]) : { affectedRows: 0 };
    if (!result.affectedRows) {
      const exists = id ? await query("SELECT id FROM notifications WHERE id = ? AND user_id = ?", [id, req.user.id]) : [];
      if (!exists[0]) return res.status(404).json({ error: "That notification does not exist." });
    }
    res.json({ unread_count: await unreadCount(req.user.id) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
