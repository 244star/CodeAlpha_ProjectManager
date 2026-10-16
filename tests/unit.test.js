const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUsername, isValidUsername, isValidEmail, parseId, parseDueDate, STATUSES, PRIORITIES } = require('../server/lib/validate');
const { reorder } = require('../server/lib/order');

test('usernames and emails are validated', () => {
  assert.equal(normalizeUsername('  @Ama_D '), 'ama_d');
  assert.ok(isValidUsername('kofi_99'));
  for (const bad of ['ab', 'with space', 'dash-name', 'a'.repeat(31), '']) assert.equal(isValidUsername(bad), false, bad);
  assert.ok(isValidEmail('a@b.co'));
  assert.equal(isValidEmail('nope'), false);
});

test('ids must be positive whole numbers, never booleans or junk', () => {
  assert.equal(parseId('7'), 7);
  assert.equal(parseId(7), 7);
  for (const bad of ['0', '-1', '1.5', 'abc', '1e3', true, false, null, undefined, {}, [], '']) assert.equal(parseId(bad), null, JSON.stringify(bad));
});

test('due dates must be real calendar dates; empty clears the value', () => {
  assert.equal(parseDueDate('2026-10-31'), '2026-10-31');
  assert.equal(parseDueDate(null), null);
  assert.equal(parseDueDate(''), null);
  for (const bad of ['2026-02-30', '2026-13-01', '31-10-2026', '2026/10/31', 'tomorrow', 20261031, '2026-10-31T00:00:00Z']) {
    assert.equal(parseDueDate(bad), undefined, String(bad));
  }
});

test('status and priority lists match the database enums', () => {
  assert.deepEqual(STATUSES, ['todo', 'in_progress', 'done']);
  assert.deepEqual(PRIORITIES, ['low', 'medium', 'high']);
});

test('reorder places a card at the requested index', () => {
  assert.deepEqual(reorder([1, 2, 3], 9, 0), [9, 1, 2, 3]);
  assert.deepEqual(reorder([1, 2, 3], 9, 2), [1, 2, 9, 3]);
  assert.deepEqual(reorder([1, 2, 3], 9, 3), [1, 2, 3, 9]);
});

test('reorder moves an existing card within its own column', () => {
  assert.deepEqual(reorder([1, 2, 3, 4], 1, 2), [2, 3, 1, 4]);
  assert.deepEqual(reorder([1, 2, 3, 4], 4, 0), [4, 1, 2, 3]);
});

test('reorder clamps out-of-range and non-numeric indexes to the end or start', () => {
  assert.deepEqual(reorder([1, 2], 9, 99), [1, 2, 9]);
  assert.deepEqual(reorder([1, 2], 9, -5), [9, 1, 2]);
  assert.deepEqual(reorder([1, 2], 9, Infinity), [1, 2, 9]);
  assert.deepEqual(reorder([], 9, 0), [9]);
});
