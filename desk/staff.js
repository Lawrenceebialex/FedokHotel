/* Fedok 144 Suites · Staff — dashboard behaviour (vanilla JS, no dependencies)
   No fake data and no fake responses. Every region distinguishes:
     loading · empty (server answered, nothing to show) · error (couldn't get an answer) · ready.
   A real zero is shown as "0"; a missing value is shown as "—".

   TO CONNECT THE BACKEND (see worker/BACKEND.md):
   1. API address: window.FEDOK_STAFF_CONFIG = { apiBase: "https://…", endpoints: { summary:"/…", … } }
      (or edit API_BASE / ENDPOINTS below).
   2. Adapt mapSummary / mapMovements / mapRoom to the real response shapes.
   3. Staff authentication belongs in request() (token or cookie) — none is faked here. */
(() => {
  const CFG = window.FEDOK_STAFF_CONFIG || {};
  const API_BASE = CFG.apiBase || "";
  const ENDPOINTS = Object.assign({ health: null, summary: null, movements: null, rooms: null, search: null }, CFG.endpoints);
  const TIMEOUT_MS = 8000, STALE_MS = 5 * 60 * 1000, TZ = "Africa/Lagos";
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const setState = (el, s) => el.setAttribute("data-state", s);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const hhmm = () => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());

  /* ---------- API layer ---------- */
  class ApiError extends Error { constructor(kind, status) { super(kind); this.kind = kind; this.status = status; } }
  async function request(key, params) {
    const path = ENDPOINTS[key];
    if (!API_BASE || !path) throw new ApiError("config");
    const url = new URL(path, API_BASE);
    Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" }, signal: ctl.signal, credentials: "include" });
      if (!res.ok) throw new ApiError("http", res.status);
      return res.status === 204 ? null : await res.json();
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(e.name === "AbortError" ? "timeout" : "network");
    } finally { clearTimeout(timer); }
  }
  const explain = (e) => !e ? "" : ({
    config: "The API isn’t configured for this screen yet.",
    timeout: "The service took too long to respond.",
    network: "The service couldn’t be reached.",
    http: "The service returned an error (HTTP " + e.status + ").",
  }[e.kind] || "Something went wrong.");

  /* ---------- adapters: map real responses here ---------- */
  const mapSummary = (d) => { d = d || {}; return [d.arrivals, d.departures, d.inHouse, d.available, d.occupied, d.pending]; };
  const mapMovements = (d) => (Array.isArray(d) ? d : []); // rows → {guest, room, stay, status, tone}
  const normStatus = (s) => ({ available: "available", occupied: "occupied", maintenance: "maintenance", out_of_service: "out" }[String(s ?? "").toLowerCase().replace(/[\s-]+/g, "_")] || "unknown");
  const mapRoom = (r) => ({ // operational status and occupancy are kept separate; absent ≠ vacant
    number: r.number ?? r.id, name: r.name || null, category: r.category || null, floor: r.floor ?? null,
    status: normStatus(r.status), occupied: typeof r.occupied === "boolean" ? r.occupied : null,
  });

  /* ---------- date, greeting ---------- */
  function tick() {
    const d = new Date(), f = (o) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...o }).format(d);
    $("#today").textContent = f({ weekday: "long", day: "numeric", month: "long", year: "numeric" });
    $("#clock").textContent = hhmm() + " Yenagoa";
    const h = +f({ hour: "2-digit", hour12: false });
    $("#greet").textContent = (h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening") + " · Reception";
  }
  tick(); setInterval(tick, 30000); // local clock only — no network

  /* ---------- connection status: connecting / connected / disconnected ---------- */
  const pill = $("#conn"), LABEL = { connecting: "Connecting…", connected: "Connected", disconnected: "Disconnected" };
  function setConn(s, why) {
    pill.dataset.s = s; $("#connText").textContent = LABEL[s]; pill.disabled = s === "connecting";
    pill.title = s === "disconnected" ? (why ? why + " " : "") + "Select to retry." : s === "connected" ? "The service has responded." : "Checking the service…";
  }
  pill.addEventListener("click", () => loadAll());

  /* ---------- stats ---------- */
  const statsEl = $(".stats"), note = $("#statsNote");
  function say(text, retry) {
    note.textContent = text;
    if (retry) { const b = el("button", "btn btn-secondary btn-sm", "Try again"); b.type = "button"; b.addEventListener("click", () => loadAll()); note.append(b); }
  }
  async function loadSummary() {
    setState(statsEl, "loading"); say("Updating…");
    try {
      const vals = mapSummary(await request("summary")); let any = false;
      $$("[data-v]", statsEl).forEach((dd, i) => {
        const v = vals[i], n = v === null || v === undefined || v === "" ? NaN : Number(v);
        dd.classList.toggle("nodata", !Number.isFinite(n)); dd.title = Number.isFinite(n) ? "" : "No data reported";
        dd.textContent = Number.isFinite(n) ? n.toLocaleString("en-NG") : "—"; any = any || Number.isFinite(n);
      });
      setState(statsEl, "ready"); say(any ? "Updated " + hhmm() : "The service responded without any figures.");
      return "ok";
    } catch (e) {
      $$("[data-v]", statsEl).forEach((dd) => { dd.textContent = "—"; dd.classList.add("nodata"); dd.title = "Unavailable"; });
      setState(statsEl, "error"); say(explain(e), true); return e;
    }
  }

  /* ---------- movements + search rows ---------- */
  function rowEl(x) {
    const tr = el("tr");
    [["g", x.guest], ["r", x.room], ["sy", x.stay]].forEach(([c, t]) => tr.append(el("td", c, t ?? "—")));
    const s = el("td", "st"), b = el("span", "badge " + ({ ok: "b-ok", pending: "b-pend", bad: "b-bad" }[x.tone] || "b-off"), x.status ?? "—");
    s.append(b); tr.append(s, el("td", "a")); return tr;
  }
  let tab = "arrivals", mvSeq = 0;
  const TITLES = { arrivals: "No arrivals expected", departures: "No departures expected", inhouse: "No guests in house" };
  async function loadMovements() {
    const seq = ++mvSeq, r = $("#movements"), rows = $("#rows"); setState(r, "loading"); rows.replaceChildren();
    try {
      const list = mapMovements(await request("movements", { list: tab })); if (seq !== mvSeq) return "ok";
      list.forEach((x) => rows.append(rowEl(x)));
      $("#emTitle").textContent = TITLES[tab]; setState(r, list.length ? "ready" : "empty"); return "ok";
    } catch (e) { if (seq === mvSeq) { $("#mvErr").textContent = explain(e); setState(r, "error"); } return e; }
  }
  const tabs = $$("[role=tab]");
  tabs.forEach((t) => t.addEventListener("click", () => {
    tabs.forEach((x) => x.setAttribute("aria-selected", x === t)); tab = t.dataset.tab;
    $("#movements").setAttribute("aria-labelledby", t.id); loadMovements();
  }));
  $(".tabs").addEventListener("keydown", (e) => {
    const i = tabs.indexOf(document.activeElement); if (i < 0 || !/Arrow(Left|Right)/.test(e.key)) return;
    const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]; n.focus(); n.click();
  });

  /* ---------- rooms: individual status, filter, group ---------- */
  const ST = { available: "Available", occupied: "Occupied", maintenance: "Maintenance", out: "Out of service", unknown: "Status not reported" };
  const eff = (r) => (r.occupied === true || r.status === "occupied" ? "occupied" : r.status);
  let rooms = [], filter = "all", groupBy = "category";
  const nat = new Intl.Collator(undefined, { numeric: true });
  function renderRooms() {
    const counts = { all: rooms.length, available: 0, occupied: 0, maintenance: 0, out: 0, unknown: 0 };
    rooms.forEach((r) => counts[eff(r)]++);
    $$(".chip").forEach((c) => { const k = c.dataset.f; c.querySelector("b").textContent = counts[k]; c.setAttribute("aria-pressed", k === filter); if (k === "unknown") c.hidden = !counts.unknown; });
    const hasFloors = rooms.some((r) => r.floor !== null); if (!hasFloors) groupBy = "category";
    $$("[data-g]").forEach((b) => { b.setAttribute("aria-pressed", b.dataset.g === groupBy); if (b.dataset.g === "floor") b.disabled = !hasFloors; });
    const shown = rooms.filter((r) => filter === "all" || eff(r) === filter).sort((a, b) => nat.compare(String(a.number), String(b.number)));
    const key = (r) => (groupBy === "floor" ? (r.floor === null ? "Floor not reported" : "Floor " + r.floor) : r.category || "Rooms");
    const groups = new Map(); shown.forEach((r) => { const k = key(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
    const keys = [...groups.keys()]; if (groupBy === "floor") keys.sort(nat.compare);
    const host = $("#roomGroups"); host.replaceChildren();
    keys.forEach((k) => {
      const g = el("div", "grp"), h = el("h3"); h.append(el("span", null, k), el("span", null, groups.get(k).length));
      const ul = el("ul", "rooms-grid");
      groups.get(k).forEach((r) => {
        const s = eff(r), li = el("li", "room"); li.dataset.st = s;
        li.setAttribute("aria-label", ["Room " + r.number, r.name, r.category, r.floor !== null ? "floor " + r.floor : null, ST[s], r.occupied === null && s !== "occupied" ? "occupancy not reported" : null].filter(Boolean).join(", "));
        li.append(el("b", null, r.number));
        if (r.name) li.append(el("small", "nm", r.name));
        if (groupBy === "floor" && r.category) li.append(el("small", null, r.category));
        li.append(el("small", null, ST[s]));
        if (r.occupied === null && s !== "occupied") { const q = el("span", "q", "?"); q.title = "Occupancy not reported"; q.setAttribute("aria-hidden", "true"); li.append(q); }
        ul.append(li);
      });
      g.append(h, ul); host.append(g);
    });
    if (!shown.length) host.append(el("div", "state", "No rooms match this filter."));
    $("#roomNote").textContent = shown.length + " of " + rooms.length + " rooms";
  }
  async function loadRooms() {
    const r = $("#roomMap"); setState(r, "loading"); $("#roomTools").hidden = true;
    try {
      const d = await request("rooms"); rooms = (Array.isArray(d) ? d : []).map(mapRoom); filter = "all";
      if (!rooms.length) { $("#roomNote").textContent = ""; setState(r, "empty"); return "ok"; }
      $("#roomTools").hidden = false; renderRooms(); setState(r, "ready"); return "ok";
    } catch (e) {
      $("#roomErrT").textContent = e.kind === "config" ? "Rooms not connected" : "Rooms unavailable"; $("#roomErrP").textContent = explain(e);
      $("#roomNote").textContent = ""; setState(r, "error"); return e;
    }
  }
  $$(".chip").forEach((c) => c.addEventListener("click", () => { filter = c.dataset.f; renderRooms(); }));
  $$("[data-g]").forEach((b) => b.addEventListener("click", () => { groupBy = b.dataset.g; renderRooms(); }));

  /* ---------- orchestration: check on load, retry, return to tab, back online. No polling. ---------- */
  let lastLoad = 0, busy = false;
  async function loadAll() {
    if (busy) return; busy = true; setConn("connecting");
    const jobs = [loadSummary(), loadMovements(), loadRooms()];
    if (ENDPOINTS.health) jobs.push(request("health").then(() => "ok", (e) => e));
    const res = await Promise.all(jobs); lastLoad = Date.now(); busy = false;
    if (res.includes("ok")) setConn("connected");
    else setConn("disconnected", explain(res.find((x) => x.kind !== "config") || res[0]));
  }
  $$("[data-retry]").forEach((b) => b.addEventListener("click", () => loadAll()));
  document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - lastLoad > STALE_MS) loadAll(); });
  window.addEventListener("online", () => loadAll());
  window.addEventListener("offline", () => setConn("disconnected", "This device is offline."));
  loadAll();

  /* ---------- search ---------- */
  const HINT = { guest: "Start typing a guest’s name", ref: "Enter the reservation reference", phone: "Enter the guest’s phone number" };
  let by = "guest";
  $$("[data-by]").forEach((b) => b.addEventListener("click", () => {
    by = b.dataset.by; $$("[data-by]").forEach((x) => x.setAttribute("aria-pressed", x === b)); $("#q").placeholder = HINT[by]; $("#q").focus();
  }));
  $("#searchForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const q = $("#q").value.trim(), f = $("#qField"), out = $("#results");
    f.classList.toggle("err", q.length < 2); $("#qMsg").textContent = q.length < 2 ? "Enter at least 2 characters." : "";
    if (q.length < 2) return;
    out.classList.add("searched"); setState(out, "empty"); $("#resT").textContent = "Searching…"; $("#resP").textContent = "";
    try {
      const list = mapMovements(await request("search", { by, q })), body = $("#resRows"); body.replaceChildren();
      if (!list.length) { $("#resT").textContent = "No reservations found"; $("#resP").textContent = "Nothing matched “" + q + "”. Check the spelling or try another search type."; return; }
      list.forEach((x) => { const r = rowEl(x); r.lastChild.remove(); body.append(r); }); setState(out, "ready");
    } catch (err) { $("#resMsg").textContent = explain(err); setState(out, "error"); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !$("dialog[open]")) { e.preventDefault(); $("#q").focus(); }
  });

  /* ---------- mobile drawer ---------- */
  const side = $("#side"), scrim = $("#scrim"), mb = $("#menuBtn");
  function drawer(open) {
    side.classList.toggle("open", open); scrim.classList.toggle("on", open); mb.setAttribute("aria-expanded", open);
    if (open) $(".nav-i[aria-current]", side).focus();
  }
  mb.addEventListener("click", () => drawer(!side.classList.contains("open")));
  scrim.addEventListener("click", () => drawer(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && side.classList.contains("open")) { drawer(false); mb.focus(); } });

  /* ---------- confirmation dialog ---------- */
  const dlg = $("#dlg");
  const ACTIONS = {
    new: { t: "New reservation", d: "Start a booking for a walk-in or phone guest.", l: "Guest name", h: "Room and dates are chosen in the next step." },
    checkin: { t: "Check in guest", d: "Confirm the guest’s arrival and assign their room.", l: "Reservation reference", h: "Found on the booking confirmation." },
    checkout: { t: "Check out guest", d: "You’ll review the stay and charges before closing it.", l: "Reservation reference or room number", h: "Checking out can’t be undone without a manager." },
  };
  $$("[data-action]").forEach((b) => b.addEventListener("click", () => {
    const a = b.dataset.action; if (a === "find") { $("#q").scrollIntoView({ block: "center", behavior: "smooth" }); $("#q").focus({ preventScroll: true }); return; }
    const c = ACTIONS[a]; $("#dlgT").textContent = c.t; $("#dlgD").textContent = c.d; $("#dlgL").textContent = c.l; $("#dlgH").textContent = c.h;
    $("#dlgRef").value = ""; $("#dlgM").textContent = ""; $("#dlgField").classList.remove("err"); dlg.showModal(); $("#dlgRef").focus();
  }));
  $("#dlgGo").addEventListener("click", () => {
    const v = $("#dlgRef").value.trim(), f = $("#dlgField");
    f.classList.add("err");
    if (!v) { $("#dlgM").textContent = "This field is required."; return $("#dlgRef").focus(); }
    $("#dlgM").textContent = "This action isn’t available yet — nothing was changed.";
  });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
})();
