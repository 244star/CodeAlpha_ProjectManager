const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const requireDatabase = require("../middleware/require-database");
const requireAuth = require("../middleware/require-auth");
const rateLimit = require("../middleware/rate-limit");
const { query } = require("../db/connection");
const { getJwtSecret } = require("../config/jwt");
const { cleanString, normalizeUsername, isValidUsername, isValidEmail } = require("../lib/validate");

const router = express.Router();
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: "Too many attempts. Please wait a few minutes and try again." });

function sessionUser(row) {
  return { id: row.id, username: row.username, name: row.name, email: row.email };
}

function createToken(user) {
  const secret = getJwtSecret();
  if (!secret) {
    const error = new Error("JWT_SECRET must be set to a random string of at least 32 characters.");
    error.status = 503;
    throw error;
  }
  return jwt.sign({ id: user.id, username: user.username, name: user.name }, secret, { expiresIn: "7d" });
}

router.post("/register", requireDatabase, authLimiter, async (req, res, next) => {
  const name = cleanString(req.body?.name);
  const username = normalizeUsername(req.body?.username);
  const email = cleanString(req.body?.email).toLowerCase();
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: "Enter a name between 2 and 80 characters." });
  if (!isValidUsername(username)) return res.status(400).json({ error: "Usernames are 3-30 characters: letters, numbers, and underscores." });
  if (!isValidEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: "Your password must be at least 8 characters." });

  try {
    const result = await query(
      "INSERT INTO users (username, name, email, password_hash) VALUES (?, ?, ?, ?)",
      [username, name, email, await bcrypt.hash(password, 12)]
    );
    const user = sessionUser({ id: result.insertId, username, name, email });
    res.status(201).json({ user, token: createToken(user) });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      const field = String(error.sqlMessage || error.message).includes("username") ? "username" : "email";
      return res.status(409).json({ error: field === "username" ? "That username is already taken." : "An account with that email already exists." });
    }
    next(error);
  }
});

router.post("/login", requireDatabase, authLimiter, async (req, res, next) => {
  const identifier = cleanString(req.body?.identifier ?? req.body?.email).toLowerCase().replace(/^@/, "");
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!identifier || !password) return res.status(400).json({ error: "Enter your email or username and your password." });

  try {
    const rows = await query("SELECT id, username, name, email, password_hash FROM users WHERE email = ? OR username = ? LIMIT 1", [identifier, identifier]);
    const record = rows[0];
    if (!record || !(await bcrypt.compare(password, record.password_hash))) {
      return res.status(401).json({ error: "Those details do not match an account." });
    }
    const user = sessionUser(record);
    res.json({ user, token: createToken(user) });
  } catch (error) {
    next(error);
  }
});

router.get("/me", requireDatabase, requireAuth, async (req, res, next) => {
  try {
    const rows = await query("SELECT id, username, name, email FROM users WHERE id = ?", [req.user.id]);
    if (!rows[0]) return res.status(401).json({ error: "Your account no longer exists." });
    res.json({ user: sessionUser(rows[0]) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
