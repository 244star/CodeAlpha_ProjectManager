const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STATUSES = ["todo", "in_progress", "done"];
const PRIORITIES = ["low", "medium", "high"];

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeUsername(value) {
  return cleanString(value).replace(/^@/, "").toLowerCase();
}

function isValidUsername(value) {
  return USERNAME_PATTERN.test(value);
}

function isValidEmail(value) {
  return value.length <= 254 && EMAIL_PATTERN.test(value);
}

// Positive integer id from a route param or body value; null if invalid.
function parseId(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Strict YYYY-MM-DD that is also a real calendar date. "" / null clear the value.
// Returns the string, null (clear), or undefined (invalid).
function parseDueDate(value) {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return undefined;
  return value;
}

module.exports = { STATUSES, PRIORITIES, cleanString, normalizeUsername, isValidUsername, isValidEmail, parseId, parseDueDate };
