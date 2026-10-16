const jwt = require("jsonwebtoken");
const { getJwtSecret } = require("../config/jwt");

function readToken(req) {
  return req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
}

// Rejects the request unless it carries a valid token.
function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: "Sign in to continue." });

  const secret = getJwtSecret();
  if (!secret) {
    return res.status(503).json({ error: "JWT_SECRET must be set to a random string of at least 32 characters." });
  }

  try {
    req.user = jwt.verify(token, secret);
    next();
  } catch {
    res.status(401).json({ error: "Your session has expired. Please sign in again." });
  }
}

// Attaches req.user when a valid token is present, but never rejects.
function optionalAuth(req, res, next) {
  const token = readToken(req);
  const secret = getJwtSecret();
  if (token && secret) {
    try {
      req.user = jwt.verify(token, secret);
    } catch {
      // An invalid token is treated as signed out.
    }
  }
  next();
}

module.exports = requireAuth;
module.exports.optionalAuth = optionalAuth;
