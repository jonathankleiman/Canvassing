const PASSWORD = "canvas";
const STORAGE_KEY = "canvas-threat-monitor-settings";

const gate = document.querySelector("#gate");
const app = document.querySelector("#app");
const passwordForm = document.querySelector("#passwordForm");
const settingsForm = document.querySelector("#settingsForm");
const lockButton = document.querySelector("#lockButton");
const saveLocalButton = document.querySelector("#saveLocal");
const message = document.querySelector("#message");
const runState = document.querySelector("#runState");
const runCount = document.querySelector("#runCount");
const matchCount = document.querySelector("#matchCount");
const sourceList = document.querySelector("#sourceList");

const fields = {
  emails: document.querySelector("#emails"),
  runTime: document.querySelector("#runTime"),
  fromEmail: document.querySelector("#fromEmail"),
  owner: document.querySelector("#owner"),
  repo: document.querySelector("#repo"),
  token: document.querySelector("#token")
};

init();

function init() {
  const inferred = inferRepo();
  fields.owner.value = inferred.owner;
  fields.repo.value = inferred.repo;

  const saved = readSaved();
  fields.emails.value = saved.emails || "";
  fields.runTime.value = saved.runTime || "";
  fields.fromEmail.value = saved.fromEmail || "";
  fields.owner.value = saved.owner || fields.owner.value;
  fields.repo.value = saved.repo || fields.repo.value;

  if (sessionStorage.getItem("monitorUnlocked") === "true") unlock();

  passwordForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const password = new FormData(passwordForm).get("password");
    if (password === PASSWORD) {
      sessionStorage.setItem("monitorUnlocked", "true");
      unlock();
    } else {
      showMessage("Wrong password.", true);
    }
  });

  lockButton.addEventListener("click", () => {
    sessionStorage.removeItem("monitorUnlocked");
    app.classList.add("hidden");
    gate.classList.remove("hidden");
  });

  saveLocalButton.addEventListener("click", () => {
    saveLocal();
    showMessage("Saved in this browser.");
  });

  settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    saveLocal();
    await saveVariables();
  });

  loadStatus();
}

function unlock() {
  gate.classList.add("hidden");
  app.classList.remove("hidden");
  showMessage("");
}

async function saveVariables() {
  const owner = fields.owner.value.trim();
  const repo = fields.repo.value.trim();
  const token = fields.token.value.trim();
  const recipients = normalizeRecipients(fields.emails.value).join(",");
  const runTime = fields.runTime.value || "14:15";
  const fromEmail = fields.fromEmail.value.trim();

  if (!owner || !repo || !token) {
    showMessage("Owner, repo, and token are required to update GitHub variables.", true);
    return;
  }
  if (!recipients) {
    showMessage("Add at least one recipient email.", true);
    return;
  }

  try {
    await upsertVariable({ owner, repo, token, name: "ALERT_RECIPIENTS", value: recipients });
    await upsertVariable({ owner, repo, token, name: "RUN_TIME_ET", value: runTime });
    if (fromEmail) {
      await upsertVariable({ owner, repo, token, name: "ALERT_FROM_EMAIL", value: fromEmail });
    }
    showMessage("Saved to GitHub Actions repository variables.");
  } catch (error) {
    showMessage(error.message, true);
  }
}

async function upsertVariable({ owner, repo, token, name, value }) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/variables/${encodeURIComponent(name)}`;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28"
  };

  const existing = await fetch(url, { headers });
  if (existing.ok) {
    const update = await fetch(url, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name, value })
    });
    if (!update.ok) throw new Error(await apiError(update));
    return;
  }

  if (existing.status !== 404) throw new Error(await apiError(existing));

  const create = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/variables`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name, value })
    }
  );
  if (!create.ok) throw new Error(await apiError(create));
}

async function apiError(response) {
  try {
    const body = await response.json();
    return body.message || `GitHub API failed with HTTP ${response.status}`;
  } catch {
    return `GitHub API failed with HTTP ${response.status}`;
  }
}

function saveLocal() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      emails: fields.emails.value,
      runTime: fields.runTime.value,
      fromEmail: fields.fromEmail.value,
      owner: fields.owner.value,
      repo: fields.repo.value
    })
  );
}

function readSaved() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

async function loadStatus() {
  try {
    const response = await fetch(`./status.json?cache=${Date.now()}`);
    const status = await response.json();
    const lastRun = status.lastRunAt ? new Date(status.lastRunAt).toLocaleString() : "No runs yet";
    runState.textContent = lastRun;
    if (!fields.runTime.value) {
      fields.runTime.value = status.runTimeEt || "14:15";
    }
    runCount.textContent = String(status.runCount ?? (status.lastRunAt ? 1 : 0));
    matchCount.textContent = String(status.matchesSent ?? 0);
    renderSources(status.sourceStatus || []);
  } catch {
    runState.textContent = "Status unavailable";
    renderSources([]);
  }
}

function renderSources(sources) {
  const fallback = [
    "Krebs on Security",
    "BleepingComputer",
    "The Record",
    "EdScoop",
    "Spiceworks",
    "Dark Reading"
  ].map((name) => ({ name, ok: null }));

  sourceList.replaceChildren(
    ...(sources.length ? sources : fallback).map((source) => {
      const item = document.createElement("li");
      const left = document.createElement("div");
      const title = document.createElement("strong");
      const meta = document.createElement("div");
      const badge = document.createElement("span");

      title.textContent = source.name;
      meta.textContent =
        source.ok == null ? "Pending first run" : `${source.checked} feed items, ${source.datedToday} from checked date`;
      badge.textContent = source.ok == null ? "Idle" : source.ok ? "OK" : "Fail";
      badge.className = `badge${source.ok === false ? " warn" : ""}`;

      left.append(title, meta);
      item.append(left, badge);
      return item;
    })
  );
}

function normalizeRecipients(value) {
  return value
    .split(/[,\n;]/)
    .map((email) => email.trim())
    .filter(Boolean);
}

function inferRepo() {
  const host = window.location.hostname;
  const firstPath = window.location.pathname.split("/").filter(Boolean)[0] || "";
  if (host.endsWith(".github.io")) {
    return { owner: host.replace(".github.io", ""), repo: firstPath };
  }
  return { owner: "", repo: "" };
}

function showMessage(value, error = false) {
  message.textContent = value;
  message.classList.toggle("error", error);
}
