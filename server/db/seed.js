// Adds demo people and a sample project so the board looks alive in a demo.
// Safe to run more than once. Run with: npm run seed
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { pool } = require("./connection");
const { ensureDatabaseSchema } = require("./migrate");

const DEMO_PASSWORD = "Password123!";

const people = [
  { username: "ama_designs", name: "Ama Mensah" },
  { username: "kofi_codes", name: "Kofi Boateng" },
  { username: "esi_reads", name: "Esi Owusu" },
  { username: "yaw_runs", name: "Yaw Asante" }
];

function inDays(days) {
  const date = new Date(Date.now() + days * 86400000);
  return date.toISOString().slice(0, 10);
}

// [title, description, status, priority, assignee, dueInDays]
const tasks = [
  ["Write the project brief", "Goals, audience, and what success looks like.", "done", "medium", "ama_designs", -6],
  ["Collect brand assets", "Logo files, colours, and fonts from the client.", "done", "low", "esi_reads", -4],
  ["Design the homepage", "Hero section, navigation, and the three feature blocks.", "in_progress", "high", "ama_designs", 2],
  ["Build the contact form", "Validation, spam protection, and a confirmation email.", "in_progress", "medium", "kofi_codes", 4],
  ["Set up the hosting", "Domain, SSL, and a staging site.", "todo", "high", "kofi_codes", 1],
  ["Write the About page copy", "Short team bios and the company story.", "todo", "low", "esi_reads", 7],
  ["Test on phones", "Check the layout on small screens and slow connections.", "todo", "medium", null, 9],
  ["Plan the launch announcement", "Email, social posts, and a short press note.", "todo", "low", "yaw_runs", 12]
];

async function seed() {
  if (!pool) {
    console.error("Set DB_HOST, DB_USER, DB_PASSWORD and DB_NAME in .env first.");
    process.exitCode = 1;
    return;
  }
  await ensureDatabaseSchema();
  const hash = await bcrypt.hash(DEMO_PASSWORD, 12);

  for (const person of people) {
    await pool.execute(
      "INSERT IGNORE INTO users (username, name, email, password_hash) VALUES (?, ?, ?, ?)",
      [person.username, person.name, `${person.username}@example.com`, hash]
    );
  }
  const [users] = await pool.query("SELECT id, username FROM users WHERE username IN (?)", [people.map((p) => p.username)]);
  const idOf = Object.fromEntries(users.map((u) => [u.username, u.id]));

  const [existing] = await pool.execute("SELECT id FROM projects WHERE owner_id = ? AND name = ?", [idOf.ama_designs, "Website relaunch"]);
  if (!existing.length) {
    const [project] = await pool.execute("INSERT INTO projects (name, description, owner_id) VALUES (?, ?, ?)", [
      "Website relaunch",
      "Redesign and relaunch the company website before the end of the quarter.",
      idOf.ama_designs
    ]);
    const projectId = project.insertId;
    await pool.execute("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')", [projectId, idOf.ama_designs]);
    for (const username of ["kofi_codes", "esi_reads", "yaw_runs"]) {
      await pool.execute("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'member')", [projectId, idOf[username]]);
    }

    const positions = { todo: 0, in_progress: 0, done: 0 };
    const taskIds = [];
    for (const [title, description, status, priority, assignee, due] of tasks) {
      const [result] = await pool.execute(
        "INSERT INTO tasks (project_id, title, description, status, priority, due_date, assignee_id, created_by, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [projectId, title, description, status, priority, inDays(due), assignee ? idOf[assignee] : null, idOf.ama_designs, positions[status]++]
      );
      taskIds.push(result.insertId);
    }
    const comments = [
      [2, "kofi_codes", "Can we keep the hero image under 200 KB? It will help the page load fast on mobile."],
      [2, "ama_designs", "Yes, I will export it as WebP."],
      [4, "kofi_codes", "Domain is registered. Waiting on the SSL certificate."]
    ];
    for (const [index, username, content] of comments) {
      await pool.execute("INSERT INTO comments (task_id, user_id, content) VALUES (?, ?, ?)", [taskIds[index], idOf[username], content]);
    }
    await pool.execute(
      "INSERT INTO notifications (user_id, actor_id, type, message, project_id, task_id) VALUES (?, ?, 'task_assigned', ?, ?, ?)",
      [idOf.kofi_codes, idOf.ama_designs, 'Ama Mensah assigned you "Set up the hosting" in Website relaunch.', projectId, taskIds[4]]
    );
  }

  console.log(`Demo data ready. Sign in as any of: ${people.map((p) => p.username).join(", ")}`);
  console.log(`Password for all demo accounts: ${DEMO_PASSWORD}`);
}

seed()
  .catch((error) => {
    console.error("Seeding failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => pool && pool.end());
