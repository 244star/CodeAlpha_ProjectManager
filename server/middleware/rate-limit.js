// Small in-memory limiter, good enough to slow down password guessing.
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();

  return function limiter(req, res, next) {
    const now = Date.now();
    const key = req.ip;
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
    } else {
      entry.count += 1;
      if (entry.count > max) {
        res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
        return res.status(429).json({ error: message || "Too many attempts. Please try again later." });
      }
    }
    if (hits.size > 5000) {
      for (const [ip, value] of hits) if (value.resetAt <= now) hits.delete(ip);
    }
    next();
  };
}

module.exports = rateLimit;
