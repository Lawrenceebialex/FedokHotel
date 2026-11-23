/* Fedok 144 Suites · Staff — dashboard behaviour (vanilla JS, no dependencies)
   RESTORED after accidental overwrite. Integrated API wiring is in local artifacts;
   see desk/API.md for contracts. Set window.FEDOK_STAFF_CONFIG.apiBase to the Worker URL.
   Full integrated script will be re-pushed in the next commit. */
(() => {
  const CFG = window.FEDOK_STAFF_CONFIG || {};
  const API_BASE = (CFG.apiBase || "").replace(/\/+$/, "");
  const ENDPOINTS = Object.assign({
    health: "/health",
    summary: "/api/reports/dashboard",
    movements: "/api/reservations",
    rooms: "/api/config/rooms",
    search: "/api/reservations",
  }, CFG.endpoints || {});
  const TIMEOUT_MS = 8000, TZ = "Africa/Lagos";
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const setState = (el, s) => el && el.setAttribute("data-state", s);
  const hhmm = () => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  class ApiError extends Error { constructor(kind, status) { super(kind); this.kind = kind; this.status = status; } }
  async function request(key, params) {
    const path = ENDPOINTS[key];
    if (!API_BASE || !path) throw new ApiError("config");
    const url = new URL(path, API_BASE + "/");
    Object.entries(params || {}).forEach(([k, v]) => { if (v != null && v !== "") url.searchParams.set(k, v); });
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
  const explain = (e) => !e ? "" : ({ config: "The API isn’t configured for this screen yet.", timeout: "The service took too long to respond.", network: "The service couldn’t be reached.", http: "The service returned an error (HTTP " + e.status + ")." }[e.kind] || "Something went wrong.");
  const mapSummary = (d) => {
    d = d || {};
    if (d.occupancy || d.guests_checked_in != null || d.reservations) {
      const occ = d.occupancy || {}, res = d.reservations || {};
      return [d.arrivals, d.departures, d.guests_checked_in, occ.available_rooms, occ.occupied_rooms, res.pending];
    }
    return [d.arrivals, d.departures, d.inHouse, d.available, d.occupied, d.pending];
  };
  const mapMovements = (d) => {
    const list = Array.isArray(d) ? d : (d && d.reservations) || [];
    return list.map((r) => r.guest != null ? r : {
      guest: r.guest_name || "—", room: r.category_name || "—",
      stay: (r.check_in_date || "—") + " → " + (r.check_out_date || "—"),
      status: r.status || "—",
      tone: ({ checked_in: "ok", confirmed: "ok", pending: "pending", cancelled: "bad", no_show: "bad" })[r.status] || "off",
    });
  };
  const normStatus = (s) => ({ available: "available", occupied: "occupied", maintenance: "maintenance", out_of_service: "out" }[String(s ?? "").toLowerCase().replace(/[\s-]+/g, "_")] || "unknown");
  const mapRoom = (r) => ({
    number: r.room_number ?? r.number ?? r.id, name: r.name || null,
    category: r.category_name || r.category || null, floor: r.floor ?? null,
    status: normStatus(r.operational_status ?? r.status),
    occupied: r.operational_status === "occupied" ? true : r.operational_status === "available" ? false : null,
  });
  function tick() {
    const d = new Date(), f = (o) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...o }).format(d);
    $("#today").textContent = f({ weekday: "long", day: "numeric", month: "long", year: "numeric" });
    $("#clock").textContent = hhmm() + " Yenagoa";
    const h = +f({ hour: "2-digit", hour12: false });
    $("#greet").textContent = (h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening") + " · Reception";
  }
  tick(); setInterval(tick, 30000);
  const pill = $("#conn"), LABEL = { connecting: "Connecting…", connected: "Connected", disconnected: "Disconnected" };
  function setConn(s, why) {
    if (!pill) return; pill.dataset.s = s; $("#connText").textContent = LABEL[s]; pill.disabled = s === "connecting";
    pill.title = s === "disconnected" ? (why ? why + " " : "") + "Select to retry." : s === "connected" ? "The service has responded." : "Checking the service…";
  }
  pill && pill.addEventListener("click", () => loadAll());
  const statsEl = $(".stats"), note = $("#statsNote");
  function say(text, retry) {
    if (!note) return; note.textContent = text;
    if (retry) { const b = document.createElement("button"); b.className = "btn btn-secondary btn-sm"; b.textContent = "Try again"; b.type = "button"; b.onclick = () => loadAll(); note.append(b); }
  }
  async function loadSummary() {
    setState(statsEl, "loading"); say("Updating…");
    try {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const vals = mapSummary(await request("summary", { date: today })); let any = false;
      $$("[data-v]", statsEl).forEach((dd, i) => {
        const v = vals[i], n = v === null || v === undefined || v === "" ? NaN : Number(v);
        dd.classList.toggle("nodata", !Number.isFinite(n)); dd.textContent = Number.isFinite(n) ? n.toLocaleString("en-NG") : "—"; any = any || Number.isFinite(n);
      });
      setState(statsEl, "ready"); say(any ? "Updated " + hhmm() : "The service responded without any figures."); return "ok";
    } catch (e) {
      $$("[data-v]", statsEl).forEach((dd) => { dd.textContent = "—"; dd.classList.add("nodata"); });
      setState(statsEl, "error"); say(explain(e), true); return e;
    }
  }
  function rowEl(x) {
    const tr = document.createElement("tr");
    [x.guest, x.room, x.stay].forEach((t) => { const td = document.createElement("td"); td.textContent = t ?? "—"; tr.append(td); });
    const s = document.createElement("td"), b = document.createElement("span");
    b.className = "badge " + ({ ok: "b-ok", pending: "b-pend", bad: "b-bad" }[x.tone] || "b-off"); b.textContent = x.status ?? "—"; s.append(b); tr.append(s, document.createElement("td")); return tr;
  }
  let tab = "arrivals", mvSeq = 0;
  const TITLES = { arrivals: "No arrivals expected", departures: "No departures expected", inhouse: "No guests in house" };
  async function loadMovements() {
    const seq = ++mvSeq, r = $("#movements"), rows = $("#rows"); setState(r, "loading"); if (rows) rows.replaceChildren();
    try {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      let data;
      if (tab === "arrivals") data = await request("movements", { from: today, to: today });
      else if (tab === "inhouse") data = await request("movements", { status: "checked_in" });
      else {
        const [a, b] = await Promise.all([request("movements", { status: "checked_in" }), request("movements", { status: "confirmed" })]);
        const pool = [...((a && a.reservations) || []), ...((b && b.reservations) || [])];
        const seen = new Set();
        data = { reservations: pool.filter((rr) => { if (seen.has(rr.id)) return false; seen.add(rr.id); return rr.check_out_date === today && !["cancelled", "no_show"].includes(rr.status); }) };
      }
      let list = mapMovements(data);
      if (tab === "arrivals") list = mapMovements({ reservations: ((data && data.reservations) || []).filter((rr) => rr.check_in_date === today && !["cancelled", "no_show"].includes(rr.status)) });
      if (seq !== mvSeq) return "ok";
      list.forEach((x) => rows.append(rowEl(x)));
      if ($("#emTitle")) $("#emTitle").textContent = TITLES[tab];
      setState(r, list.length ? "ready" : "empty"); return "ok";
    } catch (e) { if (seq === mvSeq) { if ($("#mvErr")) $("#mvErr").textContent = explain(e); setState(r, "error"); } return e; }
  }
  $$("[role=tab]").forEach((t) => t.addEventListener("click", () => {
    $$("[role=tab]").forEach((x) => x.setAttribute("aria-selected", x === t)); tab = t.dataset.tab;
    if ($("#movements")) $("#movements").setAttribute("aria-labelledby", t.id); loadMovements();
  }));
  const ST = { available: "Available", occupied: "Occupied", maintenance: "Maintenance", out: "Out of service", unknown: "Status not reported" };
  const eff = (r) => (r.occupied === true || r.status === "occupied" ? "occupied" : r.status);
  let rooms = [], filter = "all", groupBy = "category";
  const nat = new Intl.Collator(undefined, { numeric: true });
  function renderRooms() {
    const counts = { all: rooms.length, available: 0, occupied: 0, maintenance: 0, out: 0, unknown: 0 };
    rooms.forEach((r) => counts[eff(r)]++);
    $$(".chip").forEach((c) => { const k = c.dataset.f; const b = c.querySelector("b"); if (b) b.textContent = counts[k] || 0; c.setAttribute("aria-pressed", k === filter); if (k === "unknown") c.hidden = !counts.unknown; });
    const hasFloors = rooms.some((r) => r.floor !== null); if (!hasFloors) groupBy = "category";
    $$("[data-g]").forEach((b) => { b.setAttribute("aria-pressed", b.dataset.g === groupBy); if (b.dataset.g === "floor") b.disabled = !hasFloors; });
    const shown = rooms.filter((r) => filter === "all" || eff(r) === filter).sort((a, b) => nat.compare(String(a.number), String(b.number)));
    const key = (r) => (groupBy === "floor" ? (r.floor === null ? "Floor not reported" : "Floor " + r.floor) : r.category || "Rooms");
    const groups = new Map(); shown.forEach((r) => { const k = key(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
    const host = $("#roomGroups"); if (!host) return; host.replaceChildren();
    [...groups.keys()].forEach((k) => {
      const g = document.createElement("div"); g.className = "grp";
      const h = document.createElement("h3"); h.innerHTML = "<span></span><span></span>"; h.children[0].textContent = k; h.children[1].textContent = groups.get(k).length;
      const ul = document.createElement("ul"); ul.className = "rooms-grid";
      groups.get(k).forEach((r) => {
        const s = eff(r), li = document.createElement("li"); li.className = "room"; li.dataset.st = s;
        const b = document.createElement("b"); b.textContent = r.number; li.append(b);
        const sm = document.createElement("small"); sm.textContent = ST[s]; li.append(sm); ul.append(li);
      });
      g.append(h, ul); host.append(g);
    });
    if ($("#roomNote")) $("#roomNote").textContent = shown.length + " of " + rooms.length + " rooms";
  }
  async function loadRooms() {
    const r = $("#roomMap"); setState(r, "loading"); if ($("#roomTools")) $("#roomTools").hidden = true;
    try {
      const d = await request("rooms"); const raw = Array.isArray(d) ? d : (d && d.rooms) || []; rooms = raw.map(mapRoom); filter = "all";
      if (!rooms.length) { setState(r, "empty"); return "ok"; }
      if ($("#roomTools")) $("#roomTools").hidden = false; renderRooms(); setState(r, "ready"); return "ok";
    } catch (e) {
      if ($("#roomErrT")) $("#roomErrT").textContent = e.kind === "config" ? "Rooms not connected" : "Rooms unavailable";
      if ($("#roomErrP")) $("#roomErrP").textContent = explain(e); setState(r, "error"); return e;
    }
  }
  $$(".chip").forEach((c) => c.addEventListener("click", () => { filter = c.dataset.f; renderRooms(); }));
  $$("[data-g]").forEach((b) => b.addEventListener("click", () => { groupBy = b.dataset.g; renderRooms(); }));
  let busy = false;
  async function loadAll() {
    if (busy) return; busy = true; setConn("connecting");
    const res = await Promise.all([loadSummary(), loadMovements(), loadRooms()]);
    busy = false;
    if (res.includes("ok")) setConn("connected"); else setConn("disconnected", explain(res.find((x) => x && x.kind) || res[0]));
  }
  $$("[data-retry]").forEach((b) => b.addEventListener("click", () => loadAll()));
  let by = "guest";
  $$("[data-by]").forEach((b) => b.addEventListener("click", () => {
    by = b.dataset.by; $$("[data-by]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    if ($("#q")) $("#q").placeholder = ({ guest: "Start typing a guest’s name", ref: "Enter the reservation reference", phone: "Enter the guest’s phone number" })[by];
  }));
  $("#searchForm") && $("#searchForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const q = $("#q").value.trim(), out = $("#results");
    if (q.length < 2) return;
    out.classList.add("searched"); setState(out, "empty");
    try {
      if (by !== "ref") { if ($("#resMsg")) $("#resMsg").textContent = "Search by guest name or phone is not available on the API yet. Use booking reference."; setState(out, "error"); return; }
      const list = mapMovements(await request("search", { reference: q })), body = $("#resRows"); body.replaceChildren();
      if (!list.length) { if ($("#resT")) $("#resT").textContent = "No reservations found"; return; }
      list.forEach((x) => { const r = rowEl(x); r.lastChild && r.lastChild.remove(); body.append(r); }); setState(out, "ready");
    } catch (err) { if ($("#resMsg")) $("#resMsg").textContent = explain(err); setState(out, "error"); }
  });
  const side = $("#side"), scrim = $("#scrim"), mb = $("#menuBtn");
  function drawer(open) { if (!side) return; side.classList.toggle("open", open); if (scrim) scrim.classList.toggle("on", open); if (mb) mb.setAttribute("aria-expanded", open); }
  mb && mb.addEventListener("click", () => drawer(!side.classList.contains("open")));
  scrim && scrim.addEventListener("click", () => drawer(false));
  if (!API_BASE) { setConn("disconnected", explain(new ApiError("config"))); say("Set window.FEDOK_STAFF_CONFIG.apiBase (see desk/API.md).", false); }
  loadAll();
})();
