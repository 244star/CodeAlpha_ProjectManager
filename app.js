const path = require("node:path");
const express = require("express");
const healthRoutes = require("./server/routes/health");
const authRoutes = require("./server/routes/auth");
const userRoutes = require("./server/routes/users");
const projectRoutes = require("./server/routes/projects");
const taskRoutes = require("./server/routes/tasks");
const notificationRoutes = require("./server/routes/notifications");

const app = express();
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin"
  });
  next();
});
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "client")));

app.use("/api", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/notifications", notificationRoutes);

app.use("/api", (req, res) => res.status(404).json({ error: "That endpoint does not exist." }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "client", "index.html")));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number(error.status) || (error.type === "entity.parse.failed" ? 400 : 500);
  if (status >= 500) console.error(error.message);
  res.status(status).json({ error: status >= 500 ? "Something went wrong. Please try again shortly." : error.type ? "That request could not be read." : error.message });
});

module.exports = app;
