// RAID Log: Risks, Assumptions, Issues, Dependencies.
// Runs as a plain local page (saves to localStorage) or as a published
// claude.ai artifact (saves to the artifact's shared db).

const TYPES = {
  risk:       { letter: "R", name: "Risk",       plural: "Risks",        action: "Mitigation" },
  assumption: { letter: "A", name: "Assumption", plural: "Assumptions",  action: "How we'll validate it" },
  issue:      { letter: "I", name: "Issue",      plural: "Issues",       action: "Resolution plan" },
  dependency: { letter: "D", name: "Dependency", plural: "Dependencies", action: "Plan / agreed handoff" },
};
const STATUSES = ["Open", "In progress", "Monitoring", "Closed"];
const PRIORITY_WEIGHT = { High: 20, Medium: 10, Low: 3 };
const LOCAL_KEY = "raid-log-v1";

const state = {
  items: [],            // [{id, ...fields}]
  project: "Patient Portal Rollout",
  type: "all",
  status: "active",
  search: "",
  cell: null,           // {l, i} heat-map filter
  sort: { key: "rating", dir: "desc" },
  editingId: null,
  readOnly: false,
  ready: false,
};

const $ = (sel) => document.querySelector(sel);

/* ---------- dates ---------- */
function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function parseDay(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function daysFromToday(iso) {
  const d = parseDay(iso);
  if (!d) return null;
  return Math.round((d - parseDay(todayISO())) / 86400000);
}
function shiftDays(n) {
  const d = parseDay(todayISO());
  d.setDate(d.getDate() + n);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function fmtDay(iso) {
  const d = parseDay(iso);
  return d ? d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
}

/* ---------- derived values ---------- */
function rating(item) {
  if (item.type === "risk") {
    const score = (Number(item.likelihood) || 1) * (Number(item.impact) || 1);
    const band = score >= 15 ? "r" : score >= 8 ? "a" : "g";
    return { band, score, label: band === "r" ? "High" : band === "a" ? "Medium" : "Low", sortValue: score };
  }
  const p = PRIORITY_WEIGHT[item.priority] ? item.priority : "Medium";
  return { band: p === "High" ? "r" : p === "Medium" ? "a" : "g", score: null, label: p, sortValue: PRIORITY_WEIGHT[p] };
}
function isClosed(item) { return item.status === "Closed"; }
function isOverdue(item) {
  const n = daysFromToday(item.due);
  return !isClosed(item) && n !== null && n < 0;
}
function nextRef(type, excludeId) {
  const letter = TYPES[type].letter;
  let max = 0;
  for (const it of state.items) {
    if (it.id === excludeId || !it.ref || it.ref[0] !== letter) continue;
    const n = parseInt(it.ref.slice(2), 10);
    if (n > max) max = n;
  }
  return `${letter}-${String(max + 1).padStart(3, "0")}`;
}

/* ---------- storage ---------- */
const store = {
  mode: "local",
  db: null,
  downloads: null,

  async init() {
    let db = null;
    if (window.claude && typeof window.claude.use === "function") {
      try { db = await window.claude.use("db"); } catch (e) { db = null; }
      try { this.downloads = await window.claude.use("downloads"); } catch (e) { this.downloads = null; }
    }
    if (db) {
      this.mode = "db";
      this.db = db;
      db.collection("raid").onSnapshot(
        (snap) => {
          state.items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          state.ready = true;
          render();
        },
        (err) => { toast(`Lost connection to the shared log (${err.code}). Reload to try again.`); }
      );
      db.doc("settings/project").onSnapshot((snap) => {
        if (snap.exists && snap.data().name && document.activeElement !== $("#project-name")) {
          state.project = snap.data().name;
          $("#project-name").value = state.project;
        }
      }, () => {});
      return;
    }
    this.mode = "local";
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LOCAL_KEY) || "null"); } catch (e) { saved = null; }
    if (saved && Array.isArray(saved.items)) {
      state.items = saved.items;
      if (saved.project) state.project = saved.project;
    } else {
      state.items = exampleItems();
      this.persistLocal();
    }
    $("#project-name").value = state.project;
    state.ready = true;
    render();
  },

  persistLocal() {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ project: state.project, items: state.items })); }
    catch (e) { toast("Couldn't save in this browser. Export to CSV to keep a copy."); }
  },

  async save(id, body) {
    if (this.mode === "db") {
      const ref = id ? this.db.collection("raid").doc(id) : this.db.collection("raid").doc();
      await ref.set(body);
      return ref.id;
    }
    const newId = id || `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const i = state.items.findIndex((x) => x.id === newId);
    if (i >= 0) state.items[i] = { id: newId, ...body };
    else state.items.push({ id: newId, ...body });
    this.persistLocal();
    render();
    return newId;
  },

  async remove(id) {
    if (this.mode === "db") { await this.db.collection("raid").doc(id).delete(); return; }
    state.items = state.items.filter((x) => x.id !== id);
    this.persistLocal();
    render();
  },

  async saveProject(name) {
    state.project = name;
    if (this.mode === "db") { await this.db.doc("settings/project").set({ name }); return; }
    this.persistLocal();
  },
};

function writeFailed(err) {
  if (err && err.code === "invalid_argument") {
    state.readOnly = true;
    render();
    toast("You can view this log but not change it. Ask the owner for edit access.");
  } else if (err && err.code === "quota_exceeded") {
    toast("The log is full. Delete some closed entries, then try again.");
  } else {
    toast("That change didn't save. Check your connection and try again.");
  }
}

/* ---------- example data (local first run only) ---------- */
function exampleItems() {
  const ex = (o) => ({ example: true, raised: shiftDays(-21), updated: new Date().toISOString(), ...o });
  return [
    ex({ id: "ex1", type: "risk", ref: "R-001", title: "Clinic staff not trained before go-live",
      description: "Training sessions compete with clinic hours. If fewer than 80% of front-desk staff finish training, booking errors will spike in week one.",
      owner: "Training lead", status: "In progress", likelihood: 4, impact: 4,
      action: "Run short evening sessions and record them. Track completion weekly by site.", due: shiftDays(10) }),
    ex({ id: "ex2", type: "risk", ref: "R-002", title: "Identity verification vendor misses SLA",
      description: "Patient sign-up depends on the vendor's ID check. Their uptime last quarter was 98.7% against a 99.5% target.",
      owner: "Vendor manager", status: "Monitoring", likelihood: 3, impact: 5,
      action: "Agree a manual fallback with Health Records. Escalate at the monthly vendor review.", due: shiftDays(24) }),
    ex({ id: "ex3", type: "risk", ref: "R-003", title: "Accessibility audit finds blocking defects",
      description: "The audit runs late in the schedule, leaving little room to fix anything it finds.",
      owner: "UX lead", status: "Open", likelihood: 2, impact: 3,
      action: "Run axe checks in every sprint so the audit finds less.", due: shiftDays(35) }),
    ex({ id: "ex4", type: "assumption", ref: "A-001", title: "Most patients have an email address on file",
      description: "Invitations go out by email. We're assuming at least 70% of active patients have a valid address recorded.",
      owner: "Data analyst", status: "Open", priority: "High",
      action: "Pull a count from the registration system and share it at the next steering meeting.", due: shiftDays(-3) }),
    ex({ id: "ex5", type: "issue", ref: "I-001", title: "Test environment refresh failed",
      description: "The UAT environment hasn't been refreshed since the last release, so testers are working on stale data.",
      owner: "Infrastructure", status: "In progress", priority: "High",
      action: "Infrastructure to rerun the refresh tonight. Testing paused until it's done.", due: shiftDays(1) }),
    ex({ id: "ex6", type: "issue", ref: "I-002", title: "Appointment reminder text needs sign-off",
      description: "Communications team hasn't approved the SMS wording yet.",
      owner: "Comms", status: "Closed", priority: "Low",
      action: "Approved wording received and loaded.", due: shiftDays(-7) }),
    ex({ id: "ex7", type: "dependency", ref: "D-001", title: "Single sign-on integration from the identity team",
      description: "Staff log-in to the admin console needs the SSO connector delivered by the identity team.",
      owner: "Tech lead", status: "Open", priority: "Medium", dependsOn: "Identity & Access team",
      action: "Connector due in their sprint ending mid-month. Weekly check-in booked.", due: shiftDays(14) }),
  ];
}

/* ---------- rendering ---------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function filtered() {
  const q = state.search.trim().toLowerCase();
  return state.items.filter((it) => {
    if (state.type !== "all" && it.type !== state.type) return false;
    if (state.status === "active" && isClosed(it)) return false;
    if (state.status === "overdue" && !isOverdue(it)) return false;
    if (STATUSES.includes(state.status) && it.status !== state.status) return false;
    if (state.cell && (it.type !== "risk" || isClosed(it) || Number(it.likelihood) !== state.cell.l || Number(it.impact) !== state.cell.i)) return false;
    if (q) {
      const hay = [it.ref, it.title, it.description, it.owner, it.action, it.dependsOn].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function sorted(list) {
  const { key, dir } = state.sort;
  const sign = dir === "asc" ? 1 : -1;
  const val = (it) => {
    switch (key) {
      case "rating": return rating(it).sortValue;
      case "status": return STATUSES.indexOf(it.status);
      case "due": return it.due || "9999-99-99";
      case "ref": return (it.ref || "").padEnd(6);
      default: return String(it[key] || "").toLowerCase();
    }
  };
  return [...list].sort((a, b) => {
    // closed entries always sink to the bottom
    if (isClosed(a) !== isClosed(b)) return isClosed(a) ? 1 : -1;
    const va = val(a), vb = val(b);
    if (va < vb) return -sign;
    if (va > vb) return sign;
    return (a.ref || "").localeCompare(b.ref || "");
  });
}

function renderTiles() {
  const html = Object.entries(TYPES).map(([key, t]) => {
    const all = state.items.filter((x) => x.type === key);
    const open = all.filter((x) => !isClosed(x));
    const high = open.filter((x) => rating(x).band === "r").length;
    const late = open.filter(isOverdue).length;
    const meta = [
      high ? `<span class="hot">${high} high</span>` : `<span>0 high</span>`,
      late ? `<span class="hot">${late} overdue</span>` : "",
      `<span>${all.length - open.length} closed</span>`,
    ].join("");
    return `<button class="tile" type="button" data-type="${key}" aria-pressed="${state.type === key}">
      <span class="tile-head"><span class="type-badge">${t.letter}</span><span class="tile-name">${t.plural}</span></span>
      <span class="tile-count">${open.length}<small>open</small></span>
      <span class="tile-meta">${meta}</span>
    </button>`;
  }).join("");
  $("#tiles").innerHTML = html;
}

function renderHeat() {
  const counts = {};
  state.items.filter((x) => x.type === "risk" && !isClosed(x)).forEach((x) => {
    const k = `${x.likelihood}-${x.impact}`;
    counts[k] = (counts[k] || 0) + 1;
  });
  let html = "";
  for (let l = 5; l >= 1; l--) {
    for (let i = 1; i <= 5; i++) {
      const score = l * i;
      const band = score >= 15 ? "r" : score >= 8 ? "a" : "g";
      const n = counts[`${l}-${i}`] || 0;
      const sel = state.cell && state.cell.l === l && state.cell.i === i;
      html += `<button type="button" class="heat-cell band-${band}${n ? " has" : ""}${sel ? " selected" : ""}"
        data-l="${l}" data-i="${i}" ${n ? "" : "tabindex=\"-1\""}
        aria-label="Likelihood ${l}, impact ${i}: ${n} open risk${n === 1 ? "" : "s"}">${n || ""}</button>`;
    }
  }
  $("#heat-grid").innerHTML = html;
}

function renderTabs() {
  document.querySelectorAll("#type-tabs button").forEach((b) => {
    const t = b.dataset.type;
    const n = state.items.filter((x) => !isClosed(x) && (t === "all" || x.type === t)).length;
    b.setAttribute("aria-selected", String(state.type === t));
    const label = t === "all" ? "All" : TYPES[t].plural;
    b.innerHTML = `${label}<span class="n">${n}</span>`;
  });
  document.querySelectorAll(".raid-table th").forEach((th) => {
    if (th.dataset.sort === state.sort.key) th.setAttribute("aria-sort", state.sort.dir === "asc" ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
  });
}

function dueCell(it) {
  if (!it.due) return `<span class="due">—</span>`;
  const n = daysFromToday(it.due);
  let cls = "", note = "";
  if (!isClosed(it)) {
    if (n < 0) { cls = "late"; note = `${-n} day${n === -1 ? "" : "s"} overdue`; }
    else if (n === 0) { cls = "soon"; note = "Due today"; }
    else if (n <= 7) { cls = "soon"; note = `In ${n} day${n === 1 ? "" : "s"}`; }
  }
  return `<span class="due ${cls}">${esc(fmtDay(it.due))}${note ? `<small>${note}</small>` : ""}</span>`;
}

function renderRows() {
  const list = sorted(filtered());
  $("#rows").innerHTML = list.map((it) => {
    const t = TYPES[it.type] || TYPES.risk;
    const r = rating(it);
    const statusCls = "s-" + String(it.status || "Open").toLowerCase().replace(/\s+/g, "-");
    return `<tr data-id="${esc(it.id)}" class="${isClosed(it) ? "closed" : ""}" tabindex="0">
      <td><span class="ref"><span class="type-badge" title="${t.name}">${t.letter}</span>${esc(it.ref)}</span></td>
      <td><div class="entry">
        <span class="entry-title">${esc(it.title)}</span>
        ${it.description ? `<span class="entry-desc">${esc(it.description)}</span>` : ""}
        ${it.type === "dependency" && it.dependsOn ? `<span class="entry-dep">Depends on <b>${esc(it.dependsOn)}</b></span>` : ""}
        ${it.example ? `<span class="example-tag">Example</span>` : ""}
      </div></td>
      <td>${esc(it.owner) || `<span class="due">Unassigned</span>`}</td>
      <td><span class="rating ${r.band}">${r.label}${r.score ? ` <span class="score">${r.score}</span>` : ""}</span></td>
      <td><span class="status ${statusCls}">${esc(it.status || "Open")}</span></td>
      <td>${dueCell(it)}</td>
    </tr>`;
  }).join("");

  const empty = list.length === 0;
  $("#empty").hidden = !empty;
  if (empty) {
    if (!state.ready) {
      $("#empty-title").textContent = "Loading the log…";
      $("#empty-text").textContent = "";
    } else if (state.items.length === 0) {
      $("#empty-title").textContent = "The log is empty.";
      $("#empty-text").textContent = "Add your first risk, assumption, issue or dependency with “+ New entry”.";
    } else {
      $("#empty-title").textContent = "Nothing matches these filters.";
      $("#empty-text").textContent = "Try another tab or status, or clear the search.";
    }
  }
}

function render() {
  renderTiles();
  renderHeat();
  renderTabs();
  renderRows();

  $("#cell-filter").hidden = !state.cell;
  if (state.cell) {
    $("#cell-filter-text").textContent = `Showing open risks with likelihood ${state.cell.l} and impact ${state.cell.i}.`;
  }
  const exampleCount = state.items.filter((x) => x.example).length;
  $("#example-banner").hidden = exampleCount === 0 || state.readOnly;

  const where = store.mode === "db" ? "Shared log. Changes save for everyone with access." : "Saved in this browser.";
  const open = state.items.filter((x) => !isClosed(x)).length;
  $("#sync-note").textContent = state.ready ? `${open} open of ${state.items.length} entries · ${where}` : "Loading entries…";

  $("#new-btn").disabled = state.readOnly;
  $("#project-name").readOnly = state.readOnly;
}

/* ---------- editor ---------- */
const dlg = $("#editor");
const form = $("#editor-form");

function currentFormType() { return form.querySelector("input[name=type]:checked").value; }

function syncTypeFields() {
  const type = currentFormType();
  $("#risk-scoring").hidden = type !== "risk";
  $("#priority-row").hidden = type === "risk";
  $("#depends-field").hidden = type !== "dependency";
  $("#f-action-label").textContent = TYPES[type].action;
  updateScoreLine();
}
function updateScoreLine() {
  const l = Number($("#f-likelihood").value), i = Number($("#f-impact").value);
  const r = rating({ type: "risk", likelihood: l, impact: i });
  $("#score-line").textContent = `Risk score ${r.score} of 25 · ${r.label}`;
}

function openEditor(item) {
  state.editingId = item ? item.id : null;
  form.reset();
  $("#form-error").textContent = "";
  $("#delete-confirm").hidden = true;
  $("#delete-btn").hidden = false;
  $("#delete-zone").hidden = !item || state.readOnly;

  const type = item ? item.type : (state.type !== "all" ? state.type : "risk");
  form.querySelector(`input[name=type][value=${type}]`).checked = true;
  $("#editor-ref").textContent = item ? `${item.ref} · ${TYPES[item.type].name}` : "New entry";
  $("#editor-title").textContent = item ? item.title : "Add to the log";

  $("#f-title").value = item?.title || "";
  $("#f-desc").value = item?.description || "";
  $("#f-owner").value = item?.owner || "";
  $("#f-status").value = item?.status || "Open";
  $("#f-likelihood").value = String(item?.likelihood || 3);
  $("#f-impact").value = String(item?.impact || 3);
  $("#f-priority").value = item?.priority || "Medium";
  $("#f-depends").value = item?.dependsOn || "";
  $("#f-action").value = item?.action || "";
  $("#f-raised").value = item?.raised || todayISO();
  $("#f-due").value = item?.due || "";

  form.querySelectorAll("input, select, textarea").forEach((el) => { el.disabled = state.readOnly; });
  $("#save-btn").hidden = state.readOnly;

  syncTypeFields();
  if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
  if (!item) $("#f-title").focus();
}
function closeEditor() {
  if (typeof dlg.close === "function") dlg.close(); else dlg.removeAttribute("open");
  state.editingId = null;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.readOnly) return;
  const title = $("#f-title").value.trim();
  if (!title) {
    $("#form-error").textContent = "Give the entry a title so people can find it in the log.";
    $("#f-title").focus();
    return;
  }
  const type = currentFormType();
  const existing = state.items.find((x) => x.id === state.editingId);
  const ref = existing && existing.type === type ? existing.ref : nextRef(type, existing?.id);
  const body = {
    type, ref, title,
    description: $("#f-desc").value.trim(),
    owner: $("#f-owner").value.trim(),
    status: $("#f-status").value,
    action: $("#f-action").value.trim(),
    raised: $("#f-raised").value || todayISO(),
    due: $("#f-due").value || "",
    updated: new Date().toISOString(),
  };
  if (type === "risk") {
    body.likelihood = Number($("#f-likelihood").value);
    body.impact = Number($("#f-impact").value);
  } else {
    body.priority = $("#f-priority").value;
  }
  if (type === "dependency") body.dependsOn = $("#f-depends").value.trim();
  if (existing?.example) body.example = true;

  $("#save-btn").disabled = true;
  try {
    await store.save(existing?.id || null, body);
    closeEditor();
    toast(existing ? `Saved ${ref}` : `Added ${ref}`);
  } catch (err) {
    writeFailed(err);
  } finally {
    $("#save-btn").disabled = false;
  }
});

form.addEventListener("change", (e) => {
  if (e.target.name === "type") syncTypeFields();
  if (e.target.id === "f-likelihood" || e.target.id === "f-impact") updateScoreLine();
});
$("#editor-close").addEventListener("click", closeEditor);
$("#cancel-btn").addEventListener("click", closeEditor);
dlg.addEventListener("click", (e) => { if (e.target === dlg) closeEditor(); });

$("#delete-btn").addEventListener("click", () => {
  $("#delete-btn").hidden = true;
  $("#delete-confirm").hidden = false;
});
$("#delete-no").addEventListener("click", () => {
  $("#delete-btn").hidden = false;
  $("#delete-confirm").hidden = true;
});
$("#delete-yes").addEventListener("click", async () => {
  const item = state.items.find((x) => x.id === state.editingId);
  if (!item) return closeEditor();
  try {
    await store.remove(item.id);
    closeEditor();
    toast(`Deleted ${item.ref}`);
  } catch (err) { writeFailed(err); }
});

/* ---------- toolbar + table events ---------- */
$("#new-btn").addEventListener("click", () => openEditor(null));

$("#type-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-type]");
  if (!b) return;
  state.type = b.dataset.type;
  if (state.type !== "risk") state.cell = null;
  render();
});
$("#tiles").addEventListener("click", (e) => {
  const b = e.target.closest(".tile");
  if (!b) return;
  state.type = state.type === b.dataset.type ? "all" : b.dataset.type;
  state.cell = null;
  render();
});
$("#heat-grid").addEventListener("click", (e) => {
  const b = e.target.closest(".heat-cell.has");
  if (!b) return;
  const l = Number(b.dataset.l), i = Number(b.dataset.i);
  if (state.cell && state.cell.l === l && state.cell.i === i) {
    state.cell = null;
  } else {
    state.cell = { l, i };
    state.type = "risk";
  }
  render();
});
$("#cell-filter-clear").addEventListener("click", () => { state.cell = null; render(); });

$("#search").addEventListener("input", (e) => { state.search = e.target.value; renderRows(); });
$("#status-filter").addEventListener("change", (e) => { state.status = e.target.value; render(); });

document.querySelector(".raid-table thead").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-sort]");
  if (!th) return;
  const key = th.dataset.sort;
  if (state.sort.key === key) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
  else state.sort = { key, dir: key === "rating" ? "desc" : "asc" };
  render();
});

function openRow(tr) {
  const item = state.items.find((x) => x.id === tr.dataset.id);
  if (item) openEditor(item);
}
$("#rows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (tr) openRow(tr);
});
$("#rows").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const tr = e.target.closest("tr[data-id]");
  if (tr) { e.preventDefault(); openRow(tr); }
});

/* ---------- project name ---------- */
let projectTimer = null;
$("#project-name").addEventListener("input", (e) => {
  clearTimeout(projectTimer);
  const name = e.target.value.trim();
  if (!name) return;
  projectTimer = setTimeout(() => store.saveProject(name).catch(writeFailed), 800);
});
$("#project-name").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });

/* ---------- examples ---------- */
let clearArmed = false;
$("#clear-examples").addEventListener("click", async () => {
  const examples = state.items.filter((x) => x.example);
  if (!clearArmed) {
    clearArmed = true;
    $("#clear-examples").textContent = `Click again to remove ${examples.length} examples`;
    setTimeout(() => { clearArmed = false; $("#clear-examples").textContent = "Remove examples"; }, 4000);
    return;
  }
  clearArmed = false;
  $("#clear-examples").textContent = "Remove examples";
  try {
    for (const ex of examples) await store.remove(ex.id);
    toast(`Removed ${examples.length} example entries`);
  } catch (err) { writeFailed(err); }
});

/* ---------- CSV export ---------- */
function toCSV() {
  const cols = ["Ref", "Type", "Title", "Description", "Owner", "Status", "Likelihood", "Impact", "Score", "Rating",
    "Depends on", "Action", "Raised", "Due", "Overdue", "Last updated"];
  const cell = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = sorted(state.items).map((it) => {
    const r = rating(it);
    return [it.ref, TYPES[it.type]?.name, it.title, it.description, it.owner, it.status,
      it.type === "risk" ? it.likelihood : "", it.type === "risk" ? it.impact : "", r.score ?? "", r.label,
      it.dependsOn, it.action, it.raised, it.due, isOverdue(it) ? "Yes" : "", it.updated ? it.updated.slice(0, 10) : ""]
      .map(cell).join(",");
  });
  return [cols.join(","), ...rows].join("\n");
}
$("#export-btn").addEventListener("click", async () => {
  const slug = (state.project || "raid-log").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const filename = `${slug}-raid-log-${todayISO()}.csv`;
  const data = toCSV();
  if (store.downloads) {
    try { await store.downloads.save({ filename, data }); } catch (e) { /* viewer declined */ }
    return;
  }
  if (window.claude) { toast("Export isn't available in this view."); return; }
  const url = URL.createObjectURL(new Blob([data], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

/* ---------- toast ---------- */
let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

render();
store.init();
