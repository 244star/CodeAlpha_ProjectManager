(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const STATUSES = ["todo", "in_progress", "done"];
  const STATUS_LABEL = { todo: "To do", in_progress: "In progress", done: "Done" };
  const PRIORITY_LABEL = { low: "Low", medium: "Medium", high: "High" };

  const ICON = {
    bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9zM10 20a2 2 0 0 0 4 0"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    comment: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.8 7L3 21l2-5.5A8 8 0 1 1 21 12z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
  };

  const store = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
    remove(key) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } }
  };

  const state = {
    token: store.get("huddle-token", null),
    user: store.get("huddle-user", null),
    project: null,
    members: [],
    tasks: [],
    notifications: [],
    unread: 0,
    panelOpen: false,
    dragId: null,
    socket: null,
    live: false,
    retry: 0,
    retryTimer: null,
    subscribed: null,
    renderId: 0
  };

  const main = $("#main");
  const dialog = $("#dialog");

  /* ---------- helpers ---------- */

  async function api(path, { method = "GET", body } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    let response;
    try {
      response = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw new Error("Could not reach the server. Check your connection.");
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && state.token) signOut(false);
      const error = new Error(payload.error || "Something went wrong. Please try again.");
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function timeAgo(value) {
    const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
    if (seconds < 45) return "just now";
    for (const [label, size] of [["d", 86400], ["h", 3600], ["m", 60]]) if (seconds >= size) return `${Math.floor(seconds / size)}${label} ago`;
    return "just now";
  }

  function hueFor(text) {
    let hash = 0;
    for (const char of String(text)) hash = (hash * 31 + char.charCodeAt(0)) % 360;
    return hash;
  }

  function avatar(user, size = "") {
    const initial = esc((user.name || user.username || "?").trim().charAt(0).toUpperCase());
    return `<span class="avatar${size ? ` avatar-${size}` : ""}" style="--h:${hueFor(user.username)}" title="${esc(user.name)} (@${esc(user.username)})">${initial}</span>`;
  }

  function todayString() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  function dueChip(task) {
    if (!task.due_date) return "";
    const label = new Date(`${task.due_date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    let cls = "";
    let prefix = "";
    if (task.status !== "done") {
      const today = todayString();
      if (task.due_date < today) { cls = " chip-overdue"; prefix = "Overdue · "; }
      else if (task.due_date === today) { cls = " chip-today"; prefix = "Today · "; }
    }
    return `<span class="chip${cls}">${ICON.clock}${prefix}${esc(label)}</span>`;
  }

  let toastTimer;
  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3400);
  }

  function openDialog(html, { wide = false } = {}) {
    dialog.className = wide ? "wide" : "";
    dialog.innerHTML = html;
    delete dialog.dataset.taskId;
    delete dialog.dataset.dirty;
    if (!dialog.open) dialog.showModal();
  }
  function closeDialog() { if (dialog.open) dialog.close(); }
  dialog.addEventListener("click", (event) => { if (event.target === dialog) closeDialog(); });
  dialog.addEventListener("close", () => {
    if (dialog.dataset.taskId && state.project) history.replaceState(null, "", `#/p/${state.project.id}`);
    delete dialog.dataset.taskId;
  });

  const isOwner = () => state.project && state.project.role === "owner";
  const sortedTasks = (status) => state.tasks.filter((task) => task.status === status).sort((a, b) => a.position - b.position || a.id - b.id);

  /* ---------- session ---------- */

  function setSession(user, token) {
    state.user = user;
    if (token) state.token = token;
    store.set("huddle-user", user);
    if (token) store.set("huddle-token", token);
  }

  function signOut(announce = true) {
    state.user = null;
    state.token = null;
    state.notifications = [];
    state.unread = 0;
    state.panelOpen = false;
    state.project = null;
    store.remove("huddle-user");
    store.remove("huddle-token");
    disconnectSocket();
    closeDialog();
    renderTopbar();
    if (announce) toast("You have signed out.");
    if (location.hash && location.hash !== "#/") location.hash = "#/";
    else route();
  }

  function authDialog(mode = "login", message = "") {
    const registering = mode === "register";
    openDialog(`<div class="dialog-body">
      <h2>${registering ? "Create your account" : "Welcome back"}</h2>
      <p class="sub">${registering ? "Start a project and invite your team." : "Sign in with your email or username."}</p>
      <form id="auth-form" data-mode="${registering ? "register" : "login"}" novalidate>
        ${registering ? `
          <div class="form-row"><label for="f-name">Name</label><input class="field" id="f-name" name="name" autocomplete="name" maxlength="80" required></div>
          <div class="form-row"><label for="f-username">Username</label><input class="field" id="f-username" name="username" autocomplete="username" maxlength="30" required></div>
          <div class="form-row"><label for="f-email">Email</label><input class="field" id="f-email" name="email" type="email" autocomplete="email" maxlength="254" required></div>
        ` : `<div class="form-row"><label for="f-id">Email or username</label><input class="field" id="f-id" name="identifier" autocomplete="username" maxlength="254" required></div>`}
        <div class="form-row"><label for="f-password">Password</label><input class="field" id="f-password" name="password" type="password" autocomplete="${registering ? "new-password" : "current-password"}" maxlength="128" required></div>
        <p class="error-note" id="auth-error" role="alert">${esc(message)}</p>
        <button class="btn btn-accent btn-block" type="submit">${registering ? "Create account" : "Sign in"}</button>
      </form>
      <p class="switch">${registering ? "Already have an account?" : "New to Huddle?"} <button class="link-button" data-action="auth-switch" data-mode="${registering ? "login" : "register"}">${registering ? "Sign in" : "Create an account"}</button></p>
    </div>`);
    const first = dialog.querySelector("input");
    if (first) first.focus();
  }

  /* ---------- top bar ---------- */

  function renderTopbar() {
    const end = $("#topbar-end");
    $("#topnav").hidden = !state.user;
    if (!state.user) {
      end.innerHTML = `<button class="btn btn-ghost btn-small" data-action="signin">Sign in</button><button class="btn btn-accent btn-small" data-action="signup">Get started</button>`;
      return;
    }
    end.innerHTML = `
      <button class="icon-btn" data-action="toggle-notifications" aria-label="Notifications" aria-expanded="${state.panelOpen}">${ICON.bell}${state.unread ? `<span class="bell-badge">${state.unread > 99 ? "99+" : state.unread}</span>` : ""}</button>
      <div class="user-chip">${avatar(state.user)}<span class="name">${esc(state.user.name)}</span></div>
      <button class="btn btn-ghost btn-small" data-action="signout">Sign out</button>
      <div class="panel" id="notif-panel" ${state.panelOpen ? "" : "hidden"}>${notificationsHtml()}</div>`;
  }

  function notificationsHtml() {
    const items = state.notifications.map((n) => `
      <button class="note${n.is_read ? "" : " unread"}" data-action="open-notification" data-id="${Number(n.id)}" data-project="${Number(n.project_id) || ""}" data-task="${Number(n.task_id) || ""}">
        <div class="msg">${esc(n.message)}</div><div class="when">${timeAgo(n.created_at)}</div>
      </button>`).join("");
    return `<div class="panel-head"><span>Notifications</span>${state.unread ? `<button class="link-button" data-action="read-all">Mark all read</button>` : ""}</div>
      ${items || `<p class="muted" style="padding:20px 16px;margin:0">You are all caught up.</p>`}`;
  }

  function refreshNotifications() {
    const panel = $("#notif-panel");
    if (panel && state.panelOpen) panel.innerHTML = notificationsHtml();
    const bell = document.querySelector('[data-action="toggle-notifications"]');
    if (bell) {
      bell.querySelector(".bell-badge")?.remove();
      if (state.unread) bell.insertAdjacentHTML("beforeend", `<span class="bell-badge">${state.unread > 99 ? "99+" : state.unread}</span>`);
    }
  }

  async function loadNotifications() {
    if (!state.user) return;
    try {
      const data = await api("/api/notifications");
      state.notifications = data.notifications;
      state.unread = data.unread_count;
      refreshNotifications();
    } catch { /* the bell simply stays empty */ }
  }

  function setActiveNav(name) {
    document.querySelectorAll("[data-nav]").forEach((link) => link.classList.toggle("active", link.dataset.nav === name));
  }

  /* ---------- views ---------- */

  function landingView() {
    setActiveNav("");
    main.innerHTML = `
      <section class="hero">
        <div class="hero-copy">
          <span class="hero-kicker"><span class="hero-kicker-dot"></span> A calmer way to get work done</span>
          <h1>Good work happens <em>together.</em></h1>
          <p>Bring your projects, people, and next steps into one clear view. Huddle keeps the whole team moving — and every update in sync.</p>
          <div class="row"><button class="btn btn-accent" data-action="signup">Create your free account <span aria-hidden="true">&rarr;</span></button><button class="btn btn-ghost" data-action="signin">Sign in</button></div>
          <div class="hero-note"><span class="hero-note-check" aria-hidden="true">✓</span> Free to get started <span class="hero-note-divider" aria-hidden="true"></span> No credit card needed</div>
        </div>
        <div class="hero-visual" aria-hidden="true">
          <div class="hero-board">
            <div class="hero-board-top">
              <div class="hero-project-mark">W</div>
              <div class="hero-project-info"><strong>Website relaunch</strong><span>Project board · Updated just now</span></div>
              <div class="hero-team"><span class="hero-team-avatar avatar-one">A</span><span class="hero-team-avatar avatar-two">K</span><span class="hero-team-avatar avatar-three">E</span><span class="hero-team-more">+2</span></div>
            </div>
            <div class="hero-progress"><span><i></i></span><b>68%</b><small>project complete</small></div>
            <div class="hero-columns">
              <div class="hero-col">
                <h3><span class="status-dot todo-dot"></span> To do <b>2</b></h3>
                <div class="hero-card high"><span class="hero-card-title">Set up hosting</span><span class="hero-card-meta"><span class="hero-tag urgent">High priority</span><span class="hero-card-avatar">K</span></span></div>
                <div class="hero-card"><span class="hero-card-title">Write About page</span><span class="hero-card-meta"><span class="hero-tag">Content</span><span class="hero-card-avatar avatar-warm">E</span></span></div>
              </div>
              <div class="hero-col">
                <h3><span class="status-dot progress-dot"></span> In progress <b>1</b></h3>
                <div class="hero-card medium"><span class="hero-card-title">Design homepage</span><span class="hero-card-meta"><span class="hero-tag design">Design</span><span class="hero-card-avatar avatar-purple">A</span></span></div>
              </div>
              <div class="hero-col">
                <h3><span class="status-dot done-dot"></span> Done <b>2</b></h3>
                <div class="hero-card complete"><span class="hero-card-title">Project brief</span><span class="hero-card-meta"><span class="hero-tag complete-tag">Complete</span><span class="hero-card-avatar avatar-green">A</span></span></div>
                <div class="hero-card complete"><span class="hero-card-title">Collect brand assets</span><span class="hero-card-meta"><span class="hero-tag complete-tag">Complete</span><span class="hero-card-avatar avatar-purple">K</span></span></div>
              </div>
            </div>
            <div class="hero-live"><span></span> Your team is up to date</div>
          </div>
        </div>
      </section>`;
  }

  async function projectsView() {
    setActiveNav("projects");
    const renderId = state.renderId;
    main.innerHTML = `<div class="page"><div class="page-title"><h1>Projects</h1><button class="btn btn-accent" data-action="new-project">${ICON.plus} New project</button></div><div id="project-list"><p class="muted">Loading&hellip;</p></div></div>`;
    try {
      const { projects } = await api("/api/projects");
      if (renderId !== state.renderId) return;
      renderProjectList(projects);
    } catch (error) {
      if (renderId !== state.renderId) return;
      $("#project-list").innerHTML = `<div class="empty"><h3>Could not load projects</h3><p>${esc(error.message)}</p></div>`;
    }
  }

  function renderProjectList(projects) {
    const list = $("#project-list");
    if (!list) return;
    if (!projects.length) {
      list.innerHTML = `<div class="empty"><h3>No projects yet</h3><p>Create your first project, then invite people to it.</p><p><button class="btn btn-accent" data-action="new-project">Create a project</button></p></div>`;
      return;
    }
    list.innerHTML = `<div class="project-grid">${projects.map((p) => {
      const percent = p.tasks_count ? Math.round((p.done_count / p.tasks_count) * 100) : 0;
      return `<a class="project-card" href="#/p/${Number(p.id)}">
        <h2>${esc(p.name)}</h2>
        <p>${esc(p.description) || "No description yet."}</p>
        <div class="progress" role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100" aria-label="Progress"><i style="width:${percent}%"></i></div>
        <div class="project-meta"><span>${p.done_count} of ${p.tasks_count} tasks done</span><span>${p.members_count} ${p.members_count === 1 ? "member" : "members"}</span></div>
        ${p.role === "owner" ? '<div><span class="chip chip-owner">Owner</span></div>' : ""}
      </a>`;
    }).join("")}</div>`;
  }

  async function myTasksView() {
    setActiveNav("tasks");
    const renderId = state.renderId;
    main.innerHTML = `<div class="page"><div class="page-title"><h1>My tasks</h1></div><div id="my-tasks"><p class="muted">Loading&hellip;</p></div></div>`;
    try {
      const { tasks } = await api("/api/tasks/assigned");
      if (renderId !== state.renderId) return;
      const box = $("#my-tasks");
      if (!tasks.length) { box.innerHTML = `<div class="empty"><h3>Nothing assigned to you</h3><p>When someone assigns you a task, it will show up here.</p></div>`; return; }
      const groups = new Map();
      for (const task of tasks) {
        if (!groups.has(task.project_id)) groups.set(task.project_id, { name: task.project_name, tasks: [] });
        groups.get(task.project_id).tasks.push(task);
      }
      box.innerHTML = [...groups].map(([id, group]) => `<section class="group"><h2>${esc(group.name)}</h2>${group.tasks.map((task) => `
        <a class="row-card" href="#/p/${Number(id)}/t/${Number(task.id)}">
          <span class="grow ${task.status === "done" ? "muted" : ""}">${esc(task.title)}</span>
          ${dueChip(task)}
          <span class="chip chip-${esc(task.priority)}">${esc(PRIORITY_LABEL[task.priority])}</span>
          <span class="chip ${task.status === "done" ? "chip-done" : ""}">${esc(STATUS_LABEL[task.status])}</span>
        </a>`).join("")}</section>`).join("");
    } catch (error) {
      if (renderId !== state.renderId) return;
      $("#my-tasks").innerHTML = `<div class="empty"><h3>Could not load your tasks</h3><p>${esc(error.message)}</p></div>`;
    }
  }

  /* ---------- board ---------- */

  async function boardView(projectId, taskId) {
    setActiveNav("projects");
    const renderId = state.renderId;
    if (!(state.project && state.project.id === projectId && $(".board"))) {
      main.innerHTML = `<div class="page"><p class="muted">Loading&hellip;</p></div>`;
      try {
        const data = await api(`/api/projects/${projectId}`);
        if (renderId !== state.renderId) return;
        state.project = data.project;
        state.members = data.members;
        state.tasks = data.tasks;
      } catch (error) {
        if (renderId !== state.renderId) return;
        state.project = null;
        main.innerHTML = `<div class="page"><div class="empty"><h3>${error.status === 404 ? "Project not found" : "Something went wrong"}</h3><p>${esc(error.message)}</p><p><a class="btn btn-ghost" href="#/">Back to projects</a></p></div></div>`;
        return;
      }
      renderBoard();
    }
    subscribeToProject(projectId);
    if (taskId) openTask(taskId);
  }

  function boardHeaderHtml() {
    const project = state.project;
    return `
      <a class="crumb" href="#/">&larr; All projects</a>
      <div class="board-title">
        <div><h1 id="board-name">${esc(project.name)}</h1></div>
        <div class="board-tools">
          <span class="live ${state.live ? "on" : ""}" id="live-indicator">${state.live ? "Live" : "Connecting…"}</span>
          <button class="avatar-stack" data-action="members" aria-label="Show project members" style="background:none;border:0;padding:0">${state.members.slice(0, 5).map((m) => avatar(m)).join("")}${state.members.length > 5 ? `<span class="avatar" style="--h:240">+${state.members.length - 5}</span>` : ""}</button>
          <button class="btn btn-ghost btn-small" data-action="members">${state.members.length} ${state.members.length === 1 ? "member" : "members"}</button>
          ${isOwner() ? `<button class="btn btn-ghost btn-small" data-action="project-settings">Settings</button>` : ""}
        </div>
      </div>
      <p class="board-desc" id="board-desc" ${project.description ? "" : "hidden"}>${esc(project.description)}</p>`;
  }

  function renderBoard() {
    main.innerHTML = `
      <div class="board-head" id="board-head">${boardHeaderHtml()}</div>
      <div class="board" id="board">${STATUSES.map((status) => `
        <section class="column" data-status="${status}">
          <div class="column-head"><h2>${STATUS_LABEL[status]}</h2><span class="count" data-count>0</span>
            <button class="icon-btn" data-action="add-task" data-status="${status}" aria-label="Add a task to ${STATUS_LABEL[status]}">${ICON.plus}</button></div>
          <div class="cards" data-status="${status}"></div>
          <div class="add-task" data-status="${status}"><button class="add-task-toggle" data-action="add-task" data-status="${status}">${ICON.plus} Add a task</button></div>
        </section>`).join("")}
      </div>`;
    STATUSES.forEach(renderColumn);
    document.title = `${state.project.name} - Huddle`;
  }

  function renderHeader() {
    const head = $("#board-head");
    if (head && state.project) head.innerHTML = boardHeaderHtml();
  }

  function taskCardHtml(task) {
    const assignee = task.assignee ? avatar(task.assignee, "sm") : "";
    return `
      <article class="task-card p-${esc(task.priority)}${task.status === "done" ? " is-done" : ""}" draggable="true" tabindex="0" role="button" data-action="open-task" data-task-id="${Number(task.id)}" aria-label="Open task: ${esc(task.title)}">
        <div class="title">${esc(task.title)}</div>
        <div class="card-meta">
          <span class="chip chip-${esc(task.priority)}">${esc(PRIORITY_LABEL[task.priority])}</span>
          ${dueChip(task)}
          <span class="spacer"></span>
          ${task.comment_count ? `<span class="stat" title="Comments">${ICON.comment}${task.comment_count}</span>` : ""}
          ${assignee}
        </div>
      </article>`;
  }

  function renderColumn(status) {
    const column = $(`.column[data-status="${status}"]`);
    if (!column) return;
    const tasks = sortedTasks(status);
    $(".cards", column).innerHTML = tasks.map(taskCardHtml).join("");
    $("[data-count]", column).textContent = tasks.length;
  }

  function applyTasks(changed) {
    const touched = new Set();
    for (const task of changed) {
      const index = state.tasks.findIndex((existing) => existing.id === task.id);
      if (index >= 0) { touched.add(state.tasks[index].status); state.tasks[index] = task; } else state.tasks.push(task);
      touched.add(task.status);
    }
    touched.forEach(renderColumn);
    const openId = Number(dialog.dataset.taskId);
    if (dialog.open && openId && changed.some((task) => task.id === openId) && !dialog.dataset.dirty) fillTaskForm(changed.find((task) => task.id === openId));
  }

  function removeTask(taskId) {
    const task = state.tasks.find((existing) => existing.id === taskId);
    if (!task) return;
    state.tasks = state.tasks.filter((existing) => existing.id !== taskId);
    renderColumn(task.status);
    if (Number(dialog.dataset.taskId) === taskId) { closeDialog(); toast("That task was deleted."); }
  }

  function inlineAddForm(status) {
    const holder = $(`.add-task[data-status="${status}"]`);
    if (!holder || $("form", holder)) { $("input", holder)?.focus(); return; }
    holder.innerHTML = `<form data-status="${status}" novalidate>
      <label class="sr-only" for="new-${status}">Task title</label>
      <input class="field" id="new-${status}" name="title" placeholder="What needs doing?" maxlength="120" autocomplete="off">
      <div class="row"><button class="btn btn-accent btn-small" type="submit">Add task</button><button class="btn btn-ghost btn-small" type="button" data-action="cancel-add" data-status="${status}">Cancel</button></div>
    </form>`;
    $("input", holder).focus();
  }

  function resetAddForm(status) {
    const holder = $(`.add-task[data-status="${status}"]`);
    if (holder) holder.innerHTML = `<button class="add-task-toggle" data-action="add-task" data-status="${status}">${ICON.plus} Add a task</button>`;
  }

  /* ---------- drag and drop ---------- */

  const dropLine = document.createElement("div");
  dropLine.className = "drop-line";

  function dropIndex(cards, clientY) {
    const others = [...cards.querySelectorAll(".task-card:not(.dragging)")];
    let index = 0;
    for (const card of others) {
      const box = card.getBoundingClientRect();
      if (clientY > box.top + box.height / 2) index += 1;
    }
    return { index, others };
  }

  main.addEventListener("dragstart", (event) => {
    const card = event.target.closest?.(".task-card");
    if (!card) return;
    state.dragId = Number(card.dataset.taskId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(state.dragId));
    requestAnimationFrame(() => card.classList.add("dragging"));
  });

  main.addEventListener("dragover", (event) => {
    if (!state.dragId) return;
    const column = event.target.closest?.(".column");
    if (!column) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    document.querySelectorAll(".column.drag-over").forEach((el) => { if (el !== column) el.classList.remove("drag-over"); });
    column.classList.add("drag-over");
    const cards = $(".cards", column);
    const { index, others } = dropIndex(cards, event.clientY);
    if (others[index]) cards.insertBefore(dropLine, others[index]);
    else cards.appendChild(dropLine);
  });

  main.addEventListener("dragleave", (event) => {
    const column = event.target.closest?.(".column");
    if (column && !column.contains(event.relatedTarget)) { column.classList.remove("drag-over"); dropLine.remove(); }
  });

  main.addEventListener("drop", (event) => {
    if (!state.dragId) return;
    const column = event.target.closest?.(".column");
    if (!column) return;
    event.preventDefault();
    const { index } = dropIndex($(".cards", column), event.clientY);
    const id = state.dragId;
    endDrag();
    moveTask(id, column.dataset.status, index);
  });

  main.addEventListener("dragend", endDrag);

  function endDrag() {
    state.dragId = null;
    dropLine.remove();
    document.querySelectorAll(".column.drag-over").forEach((el) => el.classList.remove("drag-over"));
    document.querySelectorAll(".task-card.dragging").forEach((el) => el.classList.remove("dragging"));
  }

  // Moves a card right away, then confirms with the server (and rolls back on failure).
  async function moveTask(taskId, status, index) {
    const task = state.tasks.find((existing) => existing.id === taskId);
    if (!task) return;
    const previous = state.tasks.map((existing) => ({ ...existing }));
    const oldStatus = task.status;
    const ids = sortedTasks(status).filter((existing) => existing.id !== taskId).map((existing) => existing.id);
    ids.splice(Math.min(Math.max(index, 0), ids.length), 0, taskId);
    ids.forEach((id, position) => { const target = state.tasks.find((existing) => existing.id === id); target.position = position; target.status = status; });
    renderColumn(oldStatus);
    renderColumn(status);
    try {
      await api(`/api/tasks/${taskId}/move`, { method: "POST", body: { status, index } });
    } catch (error) {
      state.tasks = previous;
      STATUSES.forEach(renderColumn);
      toast(error.message);
    }
  }

  /* ---------- task dialog ---------- */

  function fillTaskForm(task) {
    const form = $("#task-form");
    if (!form) return;
    form.title.value = task.title;
    form.description.value = task.description;
    form.status.value = task.status;
    form.priority.value = task.priority;
    form.assignee_id.value = task.assignee ? String(task.assignee.id) : "";
    form.due_date.value = task.due_date || "";
  }

  function commentHtml(comment) {
    const canDelete = state.user && (comment.author.id === state.user.id || isOwner());
    return `
      <div class="comment" data-comment-id="${Number(comment.id)}">
        ${avatar(comment.author, "sm")}
        <div class="comment-body">
          <div class="meta"><strong>${esc(comment.author.name)}</strong> &middot; ${timeAgo(comment.created_at)}
            ${canDelete ? `<button class="link-button" data-action="delete-comment" aria-label="Delete comment">Delete</button>` : ""}</div>
          <p>${esc(comment.content)}</p>
        </div>
      </div>`;
  }

  async function openTask(taskId) {
    let data;
    try {
      data = await api(`/api/tasks/${taskId}`);
    } catch (error) {
      toast(error.message);
      if (state.project) history.replaceState(null, "", `#/p/${state.project.id}`);
      return;
    }
    const { task, comments } = data;
    const canDelete = isOwner() || task.created_by === state.user.id;
    openDialog(`
      <div class="task-dialog">
        <form class="task-main" id="task-form" novalidate>
          <label class="sr-only" for="t-title">Title</label>
          <input class="task-title-input" id="t-title" name="title" maxlength="120">
          <div class="form-row"><label for="t-desc">Description</label><textarea class="field" id="t-desc" name="description" maxlength="2000" placeholder="Add more detail..."></textarea></div>
          <div class="form-grid">
            <div class="form-row"><label for="t-status">Status</label><select class="field" id="t-status" name="status">${STATUSES.map((s) => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join("")}</select></div>
            <div class="form-row"><label for="t-priority">Priority</label><select class="field" id="t-priority" name="priority">${Object.keys(PRIORITY_LABEL).map((p) => `<option value="${p}">${PRIORITY_LABEL[p]}</option>`).join("")}</select></div>
            <div class="form-row"><label for="t-assignee">Assigned to</label><select class="field" id="t-assignee" name="assignee_id"><option value="">Unassigned</option>${state.members.map((m) => `<option value="${Number(m.id)}">${esc(m.name)} (@${esc(m.username)})</option>`).join("")}</select></div>
            <div class="form-row"><label for="t-due">Due date</label><input class="field" id="t-due" name="due_date" type="date"></div>
          </div>
          <p class="error-note" id="task-error" role="alert"></p>
          <div class="dialog-actions">
            ${canDelete ? `<button class="btn btn-danger btn-small push" type="button" data-action="delete-task">Delete task</button>` : ""}
            <button class="btn btn-ghost" type="button" data-action="close">Close</button>
            <button class="btn btn-accent" type="submit">Save changes</button>
          </div>
        </form>
        <aside class="task-side">
          <h3 class="comments-head">Comments (<span id="comment-total">${task.comment_count}</span>)</h3>
          <div class="comment-list" id="comment-list">${comments.map(commentHtml).join("") || '<p class="muted" id="no-comments">No comments yet. Start the conversation.</p>'}</div>
          <form class="comment-form" id="comment-form"><label class="sr-only" for="c-text">Add a comment</label>
            <textarea class="field" id="c-text" name="content" maxlength="1000" rows="2" placeholder="Write a comment..."></textarea>
            <div class="row"><button class="btn btn-accent btn-small" type="submit">Comment</button></div>
          </form>
        </aside>
      </div>`, { wide: true });
    dialog.dataset.taskId = String(task.id);
    fillTaskForm(task);
    $("#comment-list").scrollTop = 1e6;
    history.replaceState(null, "", `#/p/${state.project.id}/t/${task.id}`);
  }

  function setCommentCount(taskId, count) {
    const task = state.tasks.find((existing) => existing.id === taskId);
    if (task) { task.comment_count = count; renderColumn(task.status); }
    if (Number(dialog.dataset.taskId) === taskId) { const total = $("#comment-total"); if (total) total.textContent = count; }
  }

  function addCommentToDialog(taskId, comment) {
    if (!dialog.open || Number(dialog.dataset.taskId) !== taskId) return;
    const list = $("#comment-list");
    if (!list || list.querySelector(`[data-comment-id="${comment.id}"]`)) return;
    $("#no-comments")?.remove();
    list.insertAdjacentHTML("beforeend", commentHtml(comment));
    list.scrollTop = list.scrollHeight;
  }

  /* ---------- project dialogs ---------- */

  function newProjectDialog() {
    openDialog(`<div class="dialog-body"><h2>New project</h2><p class="sub">You can invite people after you create it.</p>
      <form id="project-form" data-mode="create" novalidate>
        <div class="form-row"><label for="p-name">Name</label><input class="field" id="p-name" name="name" maxlength="80" required></div>
        <div class="form-row"><label for="p-desc">Description (optional)</label><textarea class="field" id="p-desc" name="description" maxlength="500"></textarea></div>
        <p class="error-note" id="project-error" role="alert"></p>
        <div class="dialog-actions"><button class="btn btn-ghost" type="button" data-action="close">Cancel</button><button class="btn btn-accent" type="submit">Create project</button></div>
      </form></div>`);
    $("#p-name").focus();
  }

  function projectSettingsDialog() {
    const project = state.project;
    openDialog(`<div class="dialog-body"><h2>Project settings</h2><p class="sub">Only the owner sees this.</p>
      <form id="project-form" data-mode="edit" novalidate>
        <div class="form-row"><label for="p-name">Name</label><input class="field" id="p-name" name="name" maxlength="80" value="${esc(project.name)}" required></div>
        <div class="form-row"><label for="p-desc">Description</label><textarea class="field" id="p-desc" name="description" maxlength="500">${esc(project.description)}</textarea></div>
        <p class="error-note" id="project-error" role="alert"></p>
        <div class="dialog-actions"><button class="btn btn-danger btn-small push" type="button" data-action="delete-project">Delete project</button><button class="btn btn-ghost" type="button" data-action="close">Cancel</button><button class="btn btn-accent" type="submit">Save</button></div>
      </form></div>`);
  }

  function membersListHtml() {
    return state.members.map((member) => {
      const me = member.id === state.user.id;
      let action = "";
      if (member.role === "owner") action = '<span class="chip chip-owner">Owner</span>';
      else if (isOwner()) action = `<button class="btn btn-danger btn-small" data-action="remove-member" data-id="${Number(member.id)}" data-name="${esc(member.name)}">Remove</button>`;
      else if (me) action = `<button class="btn btn-danger btn-small" data-action="remove-member" data-id="${Number(member.id)}" data-self="1">Leave</button>`;
      return `<div class="person" data-member-id="${Number(member.id)}">${avatar(member, "lg")}<div class="who"><strong>${esc(member.name)}${me ? " (you)" : ""}</strong><span>@${esc(member.username)}</span></div>${action}</div>`;
    }).join("");
  }

  function membersDialog() {
    openDialog(`<div class="dialog-body"><h2>Members</h2><p class="sub">${esc(state.project.name)}</p>
      <div class="dialog-list" id="member-list">${membersListHtml()}</div>
      ${isOwner() ? `<form id="member-form" novalidate>
        <label class="label" for="m-username">Add someone by username</label>
        <div class="add-member"><input class="field" id="m-username" name="username" list="user-suggestions" placeholder="username" autocomplete="off" maxlength="31"><datalist id="user-suggestions"></datalist><button class="btn btn-accent" type="submit">Add</button></div>
        <p class="error-note" id="member-error" role="alert"></p>
      </form>` : ""}
      <div class="dialog-actions"><button class="btn btn-ghost" data-action="close">Close</button></div></div>`);
  }

  function refreshMembersUi() {
    renderHeader();
    const list = $("#member-list");
    if (list && dialog.open) list.innerHTML = membersListHtml();
    const select = $("#t-assignee");
    if (select && dialog.open) {
      const current = select.value;
      select.innerHTML = `<option value="">Unassigned</option>${state.members.map((m) => `<option value="${Number(m.id)}">${esc(m.name)} (@${esc(m.username)})</option>`).join("")}`;
      select.value = state.members.some((m) => String(m.id) === current) ? current : "";
    }
  }

  /* ---------- routing ---------- */

  async function route() {
    state.renderId += 1;
    document.title = "Huddle";
    const hash = location.hash.replace(/^#/, "") || "/";
    const boardMatch = hash.match(/^\/p\/(\d+)(?:\/t\/(\d+))?$/);
    if (!boardMatch) { state.project = null; unsubscribe(); }
    if (dialog.open && !boardMatch) closeDialog();

    if (!state.user) {
      landingView();
      if (boardMatch) authDialog("login", "Sign in to open that project.");
      return;
    }
    window.scrollTo(0, 0);
    if (boardMatch) await boardView(Number(boardMatch[1]), boardMatch[2] ? Number(boardMatch[2]) : null);
    else if (hash === "/tasks") await myTasksView();
    else await projectsView();
  }

  /* ---------- realtime ---------- */

  function setLive(value) {
    state.live = value;
    const el = $("#live-indicator");
    if (el) { el.classList.toggle("on", value); el.textContent = value ? "Live" : "Reconnecting…"; }
  }

  function connectSocket() {
    if (!state.token || state.socket) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    state.socket = socket;
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", token: state.token })));
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      handleEvent(message);
    });
    socket.addEventListener("close", (event) => {
      if (state.socket === socket) state.socket = null;
      state.subscribed = null;
      setLive(false);
      if (state.token && event.code !== 4401) {
        state.retry += 1;
        clearTimeout(state.retryTimer);
        state.retryTimer = setTimeout(connectSocket, Math.min(30000, 1000 * 2 ** Math.min(state.retry, 5)));
      }
    });
  }

  function disconnectSocket() {
    clearTimeout(state.retryTimer);
    const socket = state.socket;
    state.socket = null;
    state.subscribed = null;
    state.live = false;
    if (socket) socket.close();
  }

  function sendSocket(message) {
    if (state.socket && state.socket.readyState === WebSocket.OPEN && state.live) state.socket.send(JSON.stringify(message));
  }

  function subscribeToProject(projectId) {
    if (state.subscribed === projectId) return;
    if (state.subscribed) sendSocket({ type: "unsubscribe", projectId: state.subscribed });
    sendSocket({ type: "subscribe", projectId });
  }

  function unsubscribe() {
    if (state.subscribed) sendSocket({ type: "unsubscribe", projectId: state.subscribed });
    state.subscribed = null;
  }

  async function resyncBoard() {
    if (!state.project) return;
    try {
      const data = await api(`/api/projects/${state.project.id}`);
      state.project = data.project;
      state.members = data.members;
      state.tasks = data.tasks;
      renderHeader();
      STATUSES.forEach(renderColumn);
    } catch { /* the next event or reload will catch up */ }
  }

  function handleEvent(message) {
    const here = state.project && message.projectId === state.project.id;
    switch (message.type) {
      case "ready":
        state.retry = 0;
        setLive(true);
        if (state.project) { sendSocket({ type: "subscribe", projectId: state.project.id }); resyncBoard(); }
        break;
      case "subscribed":
        state.subscribed = message.projectId;
        break;
      case "subscribe.denied":
        if (state.project && message.projectId === state.project.id) toast("Live updates are not available for this project.");
        break;
      case "notification":
        state.notifications.unshift(message.notification);
        state.notifications = state.notifications.slice(0, 30);
        state.unread = message.unread_count;
        refreshNotifications();
        toast(message.notification.message);
        break;
      case "projects.changed":
        if (!state.project && (location.hash === "" || location.hash === "#/")) projectsView();
        break;
      case "member.removed":
        if (here) { toast("You no longer have access to that project."); location.hash = "#/"; }
        break;
      case "project.deleted":
        if (here) { toast("This project was deleted."); location.hash = "#/"; }
        break;
      case "project.updated":
        if (here) { state.project = { ...state.project, ...message.project }; renderHeader(); }
        break;
      case "members.changed":
        if (here) { state.members = message.members; refreshMembersUi(); }
        break;
      case "tasks.changed":
        if (here) applyTasks(message.tasks);
        break;
      case "task.deleted":
        if (here) removeTask(message.taskId);
        break;
      case "comment.created":
        if (here) { setCommentCount(message.taskId, message.comment_count); addCommentToDialog(message.taskId, message.comment); }
        break;
      case "comment.deleted":
        if (here) {
          setCommentCount(message.taskId, message.comment_count);
          if (Number(dialog.dataset.taskId) === message.taskId) $(`#comment-list [data-comment-id="${message.commentId}"]`)?.remove();
        }
        break;
      default:
    }
  }

  /* ---------- events ---------- */

  document.addEventListener("click", async (event) => {
    if (state.panelOpen && !event.target.closest("#notif-panel, [data-action=toggle-notifications]")) {
      state.panelOpen = false;
      renderTopbar();
    }
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;

    if (action === "signin") authDialog("login");
    else if (action === "signup") authDialog("register");
    else if (action === "auth-switch") authDialog(target.dataset.mode);
    else if (action === "signout") signOut();
    else if (action === "close") closeDialog();
    else if (action === "new-project") newProjectDialog();
    else if (action === "project-settings") projectSettingsDialog();
    else if (action === "members") membersDialog();
    else if (action === "add-task") inlineAddForm(target.dataset.status);
    else if (action === "cancel-add") resetAddForm(target.dataset.status);
    else if (action === "open-task") openTask(Number(target.dataset.taskId));
    else if (action === "toggle-notifications") {
      state.panelOpen = !state.panelOpen;
      renderTopbar();
    } else if (action === "read-all") {
      try {
        await api("/api/notifications/read-all", { method: "POST" });
        state.notifications.forEach((n) => { n.is_read = true; });
        state.unread = 0;
        renderTopbar();
      } catch (error) { toast(error.message); }
    } else if (action === "open-notification") {
      const id = Number(target.dataset.id);
      const note = state.notifications.find((n) => n.id === id);
      if (note && !note.is_read) {
        note.is_read = true;
        try { const result = await api(`/api/notifications/${id}/read`, { method: "POST" }); state.unread = result.unread_count; } catch { /* ignore */ }
      }
      state.panelOpen = false;
      renderTopbar();
      const project = target.dataset.project;
      const task = target.dataset.task;
      location.hash = project ? (task ? `#/p/${project}/t/${task}` : `#/p/${project}`) : "#/";
    } else if (action === "delete-task") {
      const id = Number(dialog.dataset.taskId);
      if (!confirm("Delete this task and its comments? This cannot be undone.")) return;
      try { await api(`/api/tasks/${id}`, { method: "DELETE" }); removeTask(id); closeDialog(); toast("Task deleted."); } catch (error) { toast(error.message); }
    } else if (action === "delete-comment") {
      const row = target.closest(".comment");
      try {
        await api(`/api/tasks/${dialog.dataset.taskId}/comments/${row.dataset.commentId}`, { method: "DELETE" });
        row.remove();
      } catch (error) { toast(error.message); }
    } else if (action === "delete-project") {
      if (!confirm(`Delete "${state.project.name}" and all of its tasks? This cannot be undone.`)) return;
      try { await api(`/api/projects/${state.project.id}`, { method: "DELETE" }); closeDialog(); toast("Project deleted."); location.hash = "#/"; } catch (error) { toast(error.message); }
    } else if (action === "remove-member") {
      const self = target.dataset.self === "1";
      if (!confirm(self ? "Leave this project?" : `Remove ${target.dataset.name} from this project?`)) return;
      try {
        const result = await api(`/api/projects/${state.project.id}/members/${target.dataset.id}`, { method: "DELETE" });
        if (self) { closeDialog(); toast("You left the project."); location.hash = "#/"; } else { state.members = result.members; refreshMembersUi(); }
      } catch (error) { toast(error.message); }
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.panelOpen) { state.panelOpen = false; renderTopbar(); }
    const card = event.target.closest?.(".task-card");
    if (card && (event.key === "Enter" || event.key === " ") && event.target === card) { event.preventDefault(); openTask(Number(card.dataset.taskId)); }
  });

  document.addEventListener("input", (event) => {
    if (event.target.closest("#task-form")) dialog.dataset.dirty = "1";
    if (event.target.id === "m-username") {
      const term = event.target.value.trim().replace(/^@/, "");
      clearTimeout(event.target._timer);
      if (!term) return;
      event.target._timer = setTimeout(async () => {
        try {
          const { users } = await api(`/api/users?q=${encodeURIComponent(term)}`);
          const taken = new Set(state.members.map((m) => m.id));
          const list = $("#user-suggestions");
          if (list) list.innerHTML = users.filter((u) => !taken.has(u.id)).map((u) => `<option value="${esc(u.username)}">${esc(u.name)}</option>`).join("");
        } catch { /* suggestions are optional */ }
      }, 200);
    }
  });

  document.addEventListener("submit", async (event) => {
    const form = event.target;
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const submit = form.querySelector("[type=submit]");

    if (form.id === "auth-form") {
      const mode = form.dataset.mode;
      submit.disabled = true;
      try {
        const result = await api(`/api/auth/${mode}`, { method: "POST", body: data });
        setSession(result.user, result.token);
        closeDialog();
        renderTopbar();
        connectSocket();
        loadNotifications();
        toast(mode === "register" ? `Welcome to Huddle, ${result.user.name.split(" ")[0]}!` : `Welcome back, ${result.user.name.split(" ")[0]}.`);
        route();
      } catch (error) {
        $("#auth-error").textContent = error.message;
        submit.disabled = false;
      }
    } else if (form.id === "project-form") {
      submit.disabled = true;
      const creating = form.dataset.mode === "create";
      try {
        if (creating) {
          const { project } = await api("/api/projects", { method: "POST", body: data });
          closeDialog();
          location.hash = `#/p/${project.id}`;
        } else {
          const { project } = await api(`/api/projects/${state.project.id}`, { method: "PATCH", body: data });
          state.project = { ...state.project, name: project.name, description: project.description };
          closeDialog();
          renderHeader();
          toast("Project updated.");
        }
      } catch (error) {
        $("#project-error").textContent = error.message;
        submit.disabled = false;
      }
    } else if (form.id === "member-form") {
      if (!data.username.trim()) return;
      submit.disabled = true;
      $("#member-error").textContent = "";
      try {
        const result = await api(`/api/projects/${state.project.id}/members`, { method: "POST", body: { username: data.username } });
        state.members = result.members;
        refreshMembersUi();
        form.reset();
        toast("Member added.");
      } catch (error) { $("#member-error").textContent = error.message; }
      submit.disabled = false;
    } else if (form.closest(".add-task")) {
      const status = form.dataset.status;
      const title = (data.title || "").trim();
      if (!title) return;
      submit.disabled = true;
      try {
        const { task } = await api(`/api/projects/${state.project.id}/tasks`, { method: "POST", body: { title, status } });
        applyTasks([task]);
        form.reset();
        form.querySelector("input").focus();
      } catch (error) { toast(error.message); }
      submit.disabled = false;
    } else if (form.id === "task-form") {
      submit.disabled = true;
      $("#task-error").textContent = "";
      try {
        const { task } = await api(`/api/tasks/${dialog.dataset.taskId}`, {
          method: "PATCH",
          body: {
            title: data.title, description: data.description, status: data.status, priority: data.priority,
            assignee_id: data.assignee_id ? Number(data.assignee_id) : null, due_date: data.due_date || null
          }
        });
        delete dialog.dataset.dirty;
        applyTasks([task]);
        toast("Task saved.");
      } catch (error) { $("#task-error").textContent = error.message; }
      submit.disabled = false;
    } else if (form.id === "comment-form") {
      const text = (data.content || "").trim();
      if (!text) return;
      submit.disabled = true;
      try {
        const taskId = Number(dialog.dataset.taskId);
        const result = await api(`/api/tasks/${taskId}/comments`, { method: "POST", body: { content: text } });
        addCommentToDialog(taskId, result.comment);
        setCommentCount(taskId, result.comment_count);
        form.reset();
      } catch (error) { toast(error.message); }
      submit.disabled = false;
      form.querySelector("textarea").focus();
    }
  });

  window.addEventListener("hashchange", route);

  /* ---------- start ---------- */

  renderTopbar();
  route();
  if (state.token) {
    connectSocket();
    api("/api/auth/me").then(({ user }) => { setSession(user); renderTopbar(); }).catch(() => { /* a 401 already signed out */ });
    loadNotifications();
  }
})();
