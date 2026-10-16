// Returns a new list of ids with `movedId` placed at `index` (clamped to the
// list). Used to renumber a board column after a card is dragged.
function reorder(ids, movedId, index) {
  const rest = ids.filter((id) => id !== movedId);
  const position = Math.min(Math.max(Number.isFinite(index) ? Math.trunc(index) : rest.length, 0), rest.length);
  rest.splice(position, 0, movedId);
  return rest;
}

module.exports = { reorder };
