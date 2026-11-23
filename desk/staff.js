/* Fedok 144 Suites · Staff — dashboard behaviour (vanilla JS, no dependencies)
   No fake data: until the Worker API is wired, regions fall into honest "not connected" states.

   TO CONNECT THE BACKEND (see worker/BACKEND.md):
   1. Set API_BASE (or define window.FEDOK_STAFF_CONFIG = { apiBase: "https://…" } before this script).
   2. Fill ENDPOINTS with the real paths and adapt the three `map*` functions to the real response shape.
   3. Add staff authentication in `request()` (token/cookie) — none is faked here. */
(() => {
  const CFG = window.FEDOK_STAFF_CONFIG || {};
  const API_BASE = CFG.apiBase || "";
  const ENDPOINTS = { summary: null, movements: null, rooms: null, search: null }; // null = not mapped yet
  const TZ = "Africa/Lagos";
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const setState = (el, s) => el.setAttribute("data-state", s);

  class NotConnected extends Error {}
  async function request(key, params) {
    const path = ENDPOINTS[key];
    if (!API_BASE || !path) throw new NotConnected();
    const url = new URL(path, API_BASE);
    Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url, { headers: { Accept: "application/json" }, credentials: "include" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  /* ---- date & greeting (hotel time) ---- */
  function tick() {
    const d = new Date(), f = (o) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...o }).format(d);
    $("#today").textContent = f({ weekday: "long", day: "numeric", month: "long", year: "numeric" });
    $("#clock").textContent = f({ hour: "2-digit", minute: "2-digit", hour12: false }) + " · Yenagoa";
    const h = +f({ hour: "2-digit", hour12: false });
    $("#greet").textContent = (h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening") + " · Reception";
  }
  tick(); setInterval(tick, 30000);

  /* ---- connection pill ---- */
  function conn(ok) {
    const p = $("#conn"); p.classList.toggle("ok", ok); p.classList.toggle("warn", !ok);
    $("#connText").textContent = ok ? "Connected" : "Service not connected";
  }

  /* ---- loaders ---- */
  async function loadSummary() {
    const r = $(".stats"); setState(r, "loading");
    try {
      const d = await request("summary");
      const v = [d.arrivals, d.departures, d.inHouse, d.available, d.occupied, d.pending];
      $$("[data-v]", r).forEach((el, i) => (el.textContent = v[i] ?? "—"));
      $$("[data-s]", r).forEach((el) => (el.textContent = ""));
      conn(true); setState(r, "ready");
    } catch (e) {
      $$("[data-v]", r).forEach((el) => (el.textContent = "—"));
      $$("[data-s]", r).forEach((el) => (el.textContent = e instanceof NotConnected ? "Not connected" : "Couldn’t load"));
      conn(false); setState(r, "error");
    }
  }
  let tab = "arrivals";
  const TITLES = { arrivals: "No arrivals expected", departures: "No departures expected", inhouse: "No guests in house" };
  async function loadMovements() {
    const r = $("#movements"); setState(r, "loading"); $("#rows").innerHTML = "";
    try {
      const rows = await request("movements", { list: tab });
      rows.forEach((x) => {
        const tr = document.createElement("tr");
        [x.guest, x.room, x.stay].forEach((t) => { const td = document.createElement("td"); td.textContent = t ?? "—"; tr.append(td); });
        const s = document.createElement("td"), b = document.createElement("span");
        b.className = "badge " + ({ ok: "b-ok", pending: "b-pend", bad: "b-bad" }[x.tone] || "b-off"); b.textContent = x.status; s.append(b); tr.append(s);
        tr.append(document.createElement("td")); $("#rows").append(tr);
      });
      $("#emTitle").textContent = TITLES[tab]; setState(r, rows.length ? "ready" : "empty");
    } catch (e) { setState(r, "error"); }
  }
  async function loadRooms() {
    const r = $("#roomMap"); setState(r, "loading");
    try {
      const rooms = await request("rooms");
      const g = $("#roomGrid"); g.innerHTML = "";
      rooms.forEach((x) => { const d = document.createElement("div"); d.className = "room"; d.textContent = x.number; g.append(d); });
      setState(r, rooms.length ? "ready" : "empty");
    } catch (e) { setState(r, "error"); }
  }
  const loadAll = () => { loadSummary(); loadMovements(); loadRooms(); };
  $$("[data-retry]").forEach((b) => b.addEventListener("click", loadAll));
  setTimeout(loadAll, 500);

  /* ---- tabs ---- */
  const tabs = $$("[role=tab]");
  tabs.forEach((t) => t.addEventListener("click", () => {
    tabs.forEach((x) => x.setAttribute("aria-selected", x === t)); tab = t.dataset.tab;
    $("#movements").setAttribute("aria-labelledby", t.id); loadMovements();
  }));
  $(".tabs").addEventListener("keydown", (e) => {
    const i = tabs.indexOf(document.activeElement); if (i < 0 || !/Arrow(Left|Right)/.test(e.key)) return;
    const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]; n.focus(); n.click();
  });

  /* ---- search ---- */
  const HINT = { guest: "Start typing a guest’s name", ref: "Enter the reservation reference", phone: "Enter the guest’s phone number" };
  let by = "guest";
  $$("[data-by]").forEach((b) => b.addEventListener("click", () => {
    by = b.dataset.by; $$("[data-by]").forEach((x) => x.setAttribute("aria-pressed", x === b)); $("#q").placeholder = HINT[by]; $("#q").focus();
  }));
  $("#searchForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const q = $("#q").value.trim(), f = $("#qField");
    f.classList.toggle("err", q.length < 2); $("#qMsg").textContent = q.length < 2 ? "Enter at least 2 characters." : "";
    if (q.length < 2) return;
    try { await request("search", { by, q }); } catch (err) {
      $("#resMsg").textContent = err instanceof NotConnected ? "The reservation service isn’t connected yet, so nothing can be searched." : "The search didn’t complete. Please try again.";
      setState($("#results"), "error");
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !$("dialog[open]")) { e.preventDefault(); $("#q").focus(); }
  });

  /* ---- drawer (mobile) ---- */
  const side = $("#side"), scrim = $("#scrim"), mb = $("#menuBtn");
  function drawer(open) {
    side.classList.toggle("open", open); scrim.classList.toggle("on", open); mb.setAttribute("aria-expanded", open);
    if (open) $(".nav-i[aria-current]", side)?.focus();
  }
  mb.addEventListener("click", () => drawer(!side.classList.contains("open")));
  scrim.addEventListener("click", () => drawer(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && side.classList.contains("open")) { drawer(false); mb.focus(); } });

  /* ---- confirmation dialog ---- */
  const dlg = $("#dlg"), toast = $("#toast");
  const ACTIONS = {
    new: { t: "New reservation", d: "Start a booking for a walk-in or phone guest.", l: "Guest name", h: "Room and dates are chosen in the next step." },
    checkin: { t: "Check in guest", d: "Confirm the guest’s arrival and assign their room.", l: "Reservation reference", h: "Found on the booking confirmation." },
    checkout: { t: "Check out guest", d: "You’ll review the stay and charges before closing it.", l: "Reservation reference or room number", h: "Checking out can’t be undone without a manager." },
  };
  $$("[data-action]").forEach((b) => b.addEventListener("click", () => {
    const a = b.dataset.action; if (a === "find") { $("#q").focus(); $("#q").scrollIntoView({ block: "center", behavior: "smooth" }); return; }
    const c = ACTIONS[a]; $("#dlgT").textContent = c.t; $("#dlgD").textContent = c.d; $("#dlgL").textContent = c.l; $("#dlgH").textContent = c.h;
    $("#dlgRef").value = ""; $("#dlgM").textContent = ""; $("#dlgField").classList.remove("err"); dlg.showModal(); $("#dlgRef").focus();
  }));
  $("#dlgGo").addEventListener("click", () => {
    const v = $("#dlgRef").value.trim(), f = $("#dlgField");
    if (!v) { f.classList.add("err"); $("#dlgM").textContent = "This field is required."; return $("#dlgRef").focus(); }
    f.classList.add("err"); $("#dlgM").textContent = "The reservation service isn’t connected yet — nothing was changed.";
  });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
})();
