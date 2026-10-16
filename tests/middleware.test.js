const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const requireAuth = require('../server/middleware/require-auth');
const { optionalAuth } = requireAuth;
const rateLimit = require('../server/middleware/rate-limit');

const SECRET = 'y'.repeat(40);

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    set(name, value) { this.headers[name] = value; return this; }
  };
}

function withSecret(fn) {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;
  try { return fn(); } finally {
    if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous;
  }
}

test('requireAuth rejects requests without a token', () => withSecret(() => {
  const res = fakeRes();
  let called = false;
  requireAuth({ headers: {} }, res, () => { called = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
}));

test('requireAuth rejects forged tokens and accepts valid ones', () => withSecret(() => {
  const forged = jwt.sign({ id: 1 }, 'z'.repeat(40));
  const res = fakeRes();
  requireAuth({ headers: { authorization: `Bearer ${forged}` } }, res, () => assert.fail('should not continue'));
  assert.equal(res.statusCode, 401);

  const req = { headers: { authorization: `Bearer ${jwt.sign({ id: 5, username: 'ada' }, SECRET)}` } };
  let called = false;
  requireAuth(req, fakeRes(), () => { called = true; });
  assert.ok(called);
  assert.equal(req.user.id, 5);
}));

test('requireAuth returns a 503 when JWT_SECRET is missing or too short', () => {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'short';
  try {
    const res = fakeRes();
    requireAuth({ headers: { authorization: 'Bearer abc' } }, res, () => assert.fail('should not continue'));
    assert.equal(res.statusCode, 503);
  } finally {
    if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous;
  }
});

test('optionalAuth never blocks, and only sets req.user for valid tokens', () => withSecret(() => {
  const anonymous = { headers: {} };
  let calls = 0;
  optionalAuth(anonymous, fakeRes(), () => { calls += 1; });
  assert.equal(anonymous.user, undefined);

  const bad = { headers: { authorization: 'Bearer nonsense' } };
  optionalAuth(bad, fakeRes(), () => { calls += 1; });
  assert.equal(bad.user, undefined);

  const good = { headers: { authorization: `Bearer ${jwt.sign({ id: 9 }, SECRET)}` } };
  optionalAuth(good, fakeRes(), () => { calls += 1; });
  assert.equal(good.user.id, 9);
  assert.equal(calls, 3);
}));

test('rateLimit blocks after the maximum number of requests', () => {
  const limiter = rateLimit({ windowMs: 60000, max: 2 });
  const req = { ip: '203.0.113.9' };
  let allowed = 0;
  for (let i = 0; i < 4; i += 1) limiter(req, fakeRes(), () => { allowed += 1; });
  assert.equal(allowed, 2);
  const res = fakeRes();
  limiter(req, res, () => assert.fail('should be blocked'));
  assert.equal(res.statusCode, 429);
  assert.ok(res.headers['Retry-After']);
});
