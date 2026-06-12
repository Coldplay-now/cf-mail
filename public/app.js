/* cf-mail web UI — zero-dependency vanilla JS. */

const $ = (sel) => document.querySelector(sel);
const state = {
  token: localStorage.getItem("cf-mail-token") || "",
  domain: "",
  webPush: false,
  folder: "inbox",
  page: 1,
  totalPages: 1,
  q: "",
  current: null, // open mail
  replyTo: null
};

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    ...opts,
    headers: {
      Authorization: "Bearer " + state.token,
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers || {})
    }
  });
  if (res.status === 401) {
    showLogin();
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "HTTP " + res.status);
  }
  return res.headers.get("content-type")?.includes("json") ? res.json() : res;
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const fmtDate = (s) => {
  const d = new Date(s + (s.includes("Z") || s.includes("+") ? "" : "Z"));
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
};

// ---- auth ----
function showLogin() {
  $("#login").classList.remove("hidden");
  $("#main").classList.add("hidden");
}
async function tryLogin() {
  try {
    const me = await api("/me");
    state.domain = me.domain;
    state.webPush = me.webPush;
    document.querySelectorAll(".domain").forEach((el) => (el.textContent = me.domain));
    $("#login").classList.add("hidden");
    $("#main").classList.remove("hidden");
    loadList();
  } catch {
    showLogin();
  }
}
$("#login-btn").onclick = () => {
  state.token = $("#login-token").value.trim();
  localStorage.setItem("cf-mail-token", state.token);
  $("#login-error").textContent = "";
  tryLogin().catch(() => ($("#login-error").textContent = "Invalid token"));
};
$("#nav-logout").onclick = () => {
  localStorage.removeItem("cf-mail-token");
  state.token = "";
  showLogin();
};

// ---- views ----
function show(view) {
  for (const v of ["list", "detail", "settings"]) {
    $("#view-" + v).classList.toggle("hidden", v !== view);
  }
}

// ---- list ----
async function loadList() {
  const q = state.q ? "&q=" + encodeURIComponent(state.q) : "";
  const data = await api(`/mails?folder=${state.folder}&page=${state.page}${q}`);
  state.totalPages = data.totalPages;
  $("#count-unread").textContent = data.counts.unread || "";
  $("#page-info").textContent = `${data.page} / ${data.totalPages} · ${data.total} mails`;
  $("#prev").disabled = data.page <= 1;
  $("#next").disabled = data.page >= data.totalPages;
  const list = $("#mail-list");
  list.innerHTML = "";
  for (const m of data.items) {
    const li = document.createElement("li");
    li.className = m.read ? "" : "unread";
    const who = m.direction === "out" ? "→ " + m.to_addr : m.from_name || m.from_addr;
    li.innerHTML = `
      <span class="who">${esc(who)}</span>
      <span class="line">
        <span class="subject">${esc(m.subject || "(no subject)")}</span>
        <span class="snippet">${esc(m.snippet || "")}</span>
      </span>
      ${m.attachments ? '<span class="clip">📎</span>' : ""}
      <span class="date">${fmtDate(m.created_at)}</span>`;
    li.onclick = () => openMail(m.id);
    list.appendChild(li);
  }
  if (!data.items.length) list.innerHTML = '<li class="empty">Nothing here.</li>';
  show("list");
}

document.querySelectorAll("#folders a[data-folder]").forEach((a) => {
  a.onclick = () => {
    document.querySelectorAll("#folders a").forEach((x) => x.classList.remove("active"));
    a.classList.add("active");
    state.folder = a.dataset.folder;
    state.page = 1;
    loadList();
  };
});
$("#prev").onclick = () => { state.page--; loadList(); };
$("#next").onclick = () => { state.page++; loadList(); };
$("#refresh").onclick = () => loadList();
let searchTimer;
$("#search").oninput = (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    state.page = 1;
    loadList();
  }, 350);
};

// ---- detail ----
async function openMail(id) {
  const { mail, thread } = await api("/mails/" + id);
  state.current = mail;
  $("#d-subject").textContent = mail.subject || "(no subject)";
  $("#d-meta").textContent =
    `${mail.from_name ? mail.from_name + " · " : ""}${mail.from_addr} → ${mail.to_addr}` +
    (mail.cc_addr ? ` · cc ${mail.cc_addr}` : "") +
    ` · ${new Date(mail.created_at + "Z").toLocaleString()}`;

  const atts = mail.attachments ? JSON.parse(mail.attachments) : [];
  $("#d-attachments").innerHTML = atts
    .map((a) => `<a href="#" data-key="${esc(a.key)}">📎 ${esc(a.filename)} (${Math.round(a.size / 1024)} KB)</a>`)
    .join(" ");
  document.querySelectorAll("#d-attachments a").forEach((a) => {
    a.onclick = async (e) => {
      e.preventDefault();
      const res = await api("/attachments?key=" + encodeURIComponent(a.dataset.key));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const dl = document.createElement("a");
      dl.href = url;
      dl.download = a.textContent.replace(/^📎 /, "").replace(/ \(.*\)$/, "");
      dl.click();
      URL.revokeObjectURL(url);
    };
  });

  const frame = $("#d-frame");
  const text = $("#d-text");
  if (mail.html_body) {
    // sandboxed iframe: no scripts, no same-origin — wild marketing HTML stays caged
    frame.srcdoc =
      '<base target="_blank"><style>body{font:15px -apple-system,sans-serif;line-height:1.6;margin:8px;word-break:break-word}img{max-width:100%;height:auto}</style>' +
      mail.html_body;
    frame.classList.remove("hidden");
    text.classList.add("hidden");
  } else {
    text.textContent = mail.text_body || "(empty)";
    text.classList.remove("hidden");
    frame.classList.add("hidden");
  }

  $("#d-thread").innerHTML =
    thread.length > 1
      ? "<h3>Conversation</h3>" +
        thread
          .map(
            (t) =>
              `<p class="thread-row${t.id === mail.id ? " current" : ""}">` +
              `<span>${t.direction === "in" ? "←" : "→"}</span> ${esc(t.snippet || t.subject || "")}` +
              ` <span class="date">${fmtDate(t.created_at)}</span></p>`
          )
          .join("")
      : "";
  show("detail");
}
$("#back").onclick = () => loadList();
$("#d-reply").onclick = () => {
  const m = state.current;
  state.replyTo = m.id;
  openCompose({
    from: (m.to_addr || "").split("@")[0].split("+")[0],
    to: m.from_addr,
    subject: (m.subject || "").startsWith("Re:") ? m.subject : "Re: " + (m.subject || ""),
    title: "Reply"
  });
};
$("#d-archive").onclick = async () => { await api("/mails/" + state.current.id, { method: "PATCH", body: JSON.stringify({ archived: true }) }); loadList(); };
$("#d-spam").onclick = async () => { await api("/mails/" + state.current.id, { method: "PATCH", body: JSON.stringify({ spam: true, read: true }) }); loadList(); };
$("#d-delete").onclick = async () => {
  if (!confirm("Delete this mail permanently?")) return;
  await api("/mails/" + state.current.id, { method: "DELETE" });
  loadList();
};

// ---- compose ----
async function openCompose(prefill = {}) {
  const addresses = await api("/addresses");
  const sel = $("#c-from");
  sel.innerHTML = addresses
    .filter((a) => a.active)
    .map((a) => `<option value="${esc(a.address)}">${esc(a.address)}@${esc(state.domain)}</option>`)
    .join("");
  if (prefill.from) sel.value = prefill.from;
  $("#compose-title").textContent = prefill.title || "New message";
  $("#c-to").value = prefill.to || "";
  $("#c-cc").value = "";
  $("#c-subject").value = prefill.subject || "";
  $("#c-body").value = "";
  $("#c-files").value = "";
  $("#c-error").textContent = "";
  $("#compose").classList.remove("hidden");
}
$("#compose-btn").onclick = () => { state.replyTo = null; openCompose(); };
$("#c-cancel").onclick = () => $("#compose").classList.add("hidden");
$("#c-send").onclick = async () => {
  try {
    $("#c-send").disabled = true;
    const files = [...$("#c-files").files];
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > 5 * 1024 * 1024) throw new Error("Attachments exceed the 5 MiB per-message limit");
    if (files.length) {
      // multipart when attachments ride along
      const form = new FormData();
      form.append("from", $("#c-from").value);
      form.append("to", $("#c-to").value.trim());
      form.append("cc", $("#c-cc").value.trim());
      form.append("subject", $("#c-subject").value.trim());
      form.append("text", $("#c-body").value);
      if (state.replyTo) form.append("inReplyToId", state.replyTo);
      for (const f of files) form.append("attachments", f);
      const res = await fetch("/api/send", {
        method: "POST",
        headers: { Authorization: "Bearer " + state.token },
        body: form
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "HTTP " + res.status);
    } else {
      await api("/send", {
        method: "POST",
        body: JSON.stringify({
          from: $("#c-from").value,
          to: $("#c-to").value.trim(),
          cc: $("#c-cc").value.trim(),
          subject: $("#c-subject").value.trim(),
          text: $("#c-body").value,
          inReplyToId: state.replyTo
        })
      });
    }
    $("#compose").classList.add("hidden");
    loadList();
  } catch (e) {
    $("#c-error").textContent = e.message;
  } finally {
    $("#c-send").disabled = false;
  }
};

// ---- settings ----
$("#nav-settings").onclick = () => loadSettings();
$("#settings-back").onclick = () => loadList();

async function loadSettings() {
  const [addresses, contacts] = await Promise.all([api("/addresses"), api("/contacts")]);
  const tbody = $("#addr-table tbody");
  tbody.innerHTML = "";
  for (const a of addresses) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><code>${esc(a.address)}@${esc(state.domain)}</code></td>
      <td>${esc(a.display_name || "")}</td>
      <td>${esc(a.forward_to || "")}</td>
      <td><input type="checkbox" ${a.active ? "checked" : ""}></td>
      <td><button class="danger small">delete</button></td>`;
    tr.querySelector("input").onchange = (e) =>
      api("/addresses/" + a.id, { method: "PATCH", body: JSON.stringify({ active: e.target.checked }) });
    tr.querySelector("button").onclick = async () => {
      if (!confirm(`Delete ${a.address}@${state.domain}? Incoming mail will be rejected.`)) return;
      await api("/addresses/" + a.id, { method: "DELETE" });
      loadSettings();
    };
    tbody.appendChild(tr);
  }

  const blocked = contacts.filter((c) => c.blocked);
  $("#block-list").innerHTML = blocked.length
    ? blocked
        .map((c) => `<li><code>${esc(c.address)}</code> <button class="small" data-addr="${esc(c.address)}">unblock</button></li>`)
        .join("")
    : "<li class='empty'>No blocked senders.</li>";
  document.querySelectorAll("#block-list button").forEach((b) => {
    b.onclick = async () => {
      await api("/contacts", { method: "POST", body: JSON.stringify({ address: b.dataset.addr, blocked: false }) });
      loadSettings();
    };
  });

  $("#push-status").textContent = state.webPush
    ? "Web Push is configured on the worker."
    : "Web Push not configured (set the VAPID_* secrets to enable).";
  $("#push-subscribe").disabled = !state.webPush || !("serviceWorker" in navigator);
  show("settings");
}
$("#addr-add").onclick = async () => {
  const address = $("#addr-new").value.trim();
  if (!address) return;
  await api("/addresses", {
    method: "POST",
    body: JSON.stringify({ address, display_name: $("#addr-name").value.trim() || undefined })
  });
  $("#addr-new").value = "";
  $("#addr-name").value = "";
  loadSettings();
};
$("#block-add").onclick = async () => {
  const address = $("#block-new").value.trim();
  if (!address) return;
  await api("/contacts", { method: "POST", body: JSON.stringify({ address, blocked: true }) });
  $("#block-new").value = "";
  loadSettings();
};
$("#push-subscribe").onclick = async () => {
  const { publicKey } = await api("/push/key");
  if (!publicKey) return;
  const reg = await navigator.serviceWorker.register("/sw.js");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))
  });
  await api("/push", { method: "POST", body: JSON.stringify({ ...sub.toJSON(), label: navigator.userAgent.slice(0, 60) }) });
  $("#push-status").textContent = "This browser is subscribed.";
};

// ---- boot ----
if (state.token) tryLogin();
else showLogin();
