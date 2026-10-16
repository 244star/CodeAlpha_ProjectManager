require("dotenv").config();

const http = require("node:http");
const app = require("./app");
const realtime = require("./server/realtime");
const { pool } = require("./server/db/connection");
const { ensureDatabaseSchema } = require("./server/db/migrate");

const port = Number(process.env.PORT) || 5000;
const server = http.createServer(app);
let started = false;

async function start() {
  try {
    await ensureDatabaseSchema();
    realtime.attach(server);
    server.listen(port, () => {
      started = true;
      console.log(`Huddle is running at http://localhost:${port}`);
      if (!pool) console.log("Database is not configured: set DB_HOST, DB_USER, DB_PASSWORD and DB_NAME in .env.");
    });
  } catch (error) {
    console.error("Database setup failed:", error.message);
    process.exitCode = 1;
    if (pool) await pool.end();
  }
}

start();

async function shutdown() {
  await realtime.close();
  if (started) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
