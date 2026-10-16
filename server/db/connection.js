const mysql = require("mysql2/promise");

const { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_PORT, MYSQL_SSL } = process.env;

const pool =
  DB_HOST && DB_USER && DB_PASSWORD && DB_NAME
    ? mysql.createPool({
        host: DB_HOST,
        port: Number(DB_PORT) || 3306,
        user: DB_USER,
        password: DB_PASSWORD,
        database: DB_NAME,
        ssl: MYSQL_SSL === "true" ? {} : undefined,
        // Timestamps are stored and read as UTC so they do not depend on the
        // time zones of Node and MySQL. The browser shows them in local time.
        timezone: "Z",
        // Return DATE columns (task due dates) as plain "YYYY-MM-DD" strings.
        typeCast(field, next) {
          return field.type === "DATE" ? field.string() : next();
        },
        waitForConnections: true,
        connectionLimit: 10
      })
    : null;

if (pool) {
  pool.pool.on("connection", (connection) => connection.query("SET time_zone = '+00:00'"));
}

async function query(sql, values = []) {
  const [rows] = await pool.execute(sql, values);
  return rows;
}

module.exports = { pool, query };
