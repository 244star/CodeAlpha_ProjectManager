const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const { getJwtSecret } = require("./config/jwt");
const { query, pool } = require("./db/connection");

// userId -> Set of sockets, projectId -> Set of sockets
const userSockets = new Map();
const rooms = new Map();
let wss = null;
let heartbeat = null;

function addTo(map, key, socket) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(socket);
}

function removeFrom(map, key, socket) {
  const set = map.get(key);
  if (!set) return;
  set.delete(socket);
  if (!set.size) map.delete(key);
}

function send(socket, event) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
}

// Sends an event to everyone currently watching a project board.
function broadcast(projectId, event) {
  const watchers = rooms.get(Number(projectId));
  if (!watchers) return;
  const payload = JSON.stringify({ ...event, projectId: Number(projectId) });
  for (const socket of watchers) if (socket.readyState === socket.OPEN) socket.send(payload);
}

// Sends an event to every open connection of one user.
function sendToUser(userId, event) {
  const sockets = userSockets.get(Number(userId));
  if (!sockets) return;
  for (const socket of sockets) send(socket, event);
}

// Stops a user's sockets from receiving a project's events (removed or left).
function unsubscribeUser(projectId, userId) {
  const watchers = rooms.get(Number(projectId));
  if (!watchers) return;
  for (const socket of [...watchers]) {
    if (socket.userId === Number(userId)) {
      watchers.delete(socket);
      socket.projects.delete(Number(projectId));
    }
  }
  if (!watchers.size) rooms.delete(Number(projectId));
}

function closeRoom(projectId) {
  const watchers = rooms.get(Number(projectId));
  if (!watchers) return;
  for (const socket of watchers) socket.projects.delete(Number(projectId));
  rooms.delete(Number(projectId));
}

async function isMember(projectId, userId) {
  const rows = await query("SELECT 1 AS ok FROM project_members WHERE project_id = ? AND user_id = ?", [projectId, userId]);
  return rows.length > 0;
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true; // non-browser clients
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

async function handleMessage(socket, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (!message || typeof message.type !== "string") return;

  if (message.type === "auth") {
    const secret = getJwtSecret();
    try {
      if (!secret) throw new Error("no secret");
      const payload = jwt.verify(String(message.token || ""), secret);
      socket.userId = Number(payload.id);
      clearTimeout(socket.authTimer);
      addTo(userSockets, socket.userId, socket);
      send(socket, { type: "ready" });
    } catch {
      socket.close(4401, "unauthorized");
    }
    return;
  }

  if (!socket.userId) return socket.close(4401, "unauthorized");

  if (message.type === "subscribe") {
    const projectId = Number(message.projectId);
    try {
      if (!Number.isSafeInteger(projectId) || projectId < 1 || !(await isMember(projectId, socket.userId))) {
        return send(socket, { type: "subscribe.denied", projectId: message.projectId });
      }
      socket.projects.add(projectId);
      addTo(rooms, projectId, socket);
      send(socket, { type: "subscribed", projectId });
    } catch {
      send(socket, { type: "subscribe.denied", projectId: message.projectId });
    }
  } else if (message.type === "unsubscribe") {
    const projectId = Number(message.projectId);
    if (socket.projects.delete(projectId)) removeFrom(rooms, projectId, socket);
  }
}

function attach(server) {
  if (!pool) return null;
  wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url, "http://localhost");
    if (pathname !== "/ws" || !sameOrigin(request)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (socket) => {
    socket.isAlive = true;
    socket.userId = null;
    socket.projects = new Set();
    // The token is sent in the first message (not the URL, which gets logged).
    socket.authTimer = setTimeout(() => socket.close(4401, "unauthorized"), 5000);
    socket.on("pong", () => { socket.isAlive = true; });
    socket.on("message", (raw) => { handleMessage(socket, raw).catch(() => {}); });
    socket.on("close", () => {
      clearTimeout(socket.authTimer);
      if (socket.userId) removeFrom(userSockets, socket.userId, socket);
      for (const projectId of socket.projects) removeFrom(rooms, projectId, socket);
    });
    socket.on("error", () => {});
  });

  // Drop connections that stop answering pings.
  heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) { socket.terminate(); continue; }
      socket.isAlive = false;
      socket.ping();
    }
  }, 30000);
  heartbeat.unref();
  return wss;
}

async function close() {
  clearInterval(heartbeat);
  if (!wss) return;
  for (const socket of wss.clients) socket.terminate();
  await new Promise((resolve) => wss.close(resolve));
  wss = null;
  userSockets.clear();
  rooms.clear();
}

module.exports = { attach, close, broadcast, sendToUser, unsubscribeUser, closeRoom };
