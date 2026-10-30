import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, home, readTextFile, exec, nextCommand, closeOverlay, props, notify } from "herdr";

// 5 minutos: el uso no cambia lo bastante rápido para justificar más, y mantiene
// las dos APIs tranquilas (288 lecturas por día por endpoint).
const REFRESH_MS = 5 * 60 * 1000;
const MIN_GAP_MS = 45 * 1000;
const ALERT_AT = 85;

const GO_URLS = [
  "https://opencode.ai/inference/go/v1/usage",
  "https://opencode.ai/zen/go/v1/usage",
];


function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pick(o, keys) {
  if (!o || typeof o !== "object") return undefined;
  for (const k of keys) if (o[k] != null) return o[k];
  return undefined;
}

function windowPct(w) {
  if (!w || typeof w !== "object") return null;
  const direct = num(pick(w, ["percent", "usagePercent", "usage_percent", "value"]));
  if (direct !== null) return Math.max(0, Math.min(100, direct));
  const used = num(pick(w, ["usedMicroCents", "used", "usage", "consumed"]));
  const limit = num(pick(w, ["limitMicroCents", "limit", "total", "quota"]));
  if (used !== null && limit > 0) return Math.max(0, Math.min(100, (used / limit) * 100));
  return null;
}

// Acepta resetsAt/resetAt ISO o epoch, resetInSec y variantes.
function windowReset(w, now) {
  if (!w || typeof w !== "object") return null;
  const at = pick(w, ["resetsAt", "resetAt", "resets_at", "reset_at", "resets"]);
  if (at != null) {
    const ms = typeof at === "number" ? (at < 1e12 ? at * 1000 : at) : Date.parse(at);
    if (Number.isFinite(ms)) return Math.max(0, ms - now);
  }
  const secs = num(pick(w, ["resetInSec", "reset_in_sec", "resetIn", "reset_in", "resetsInSec"]));
  return secs === null ? null : Math.max(0, secs * 1000);
}

function dur(ms) {
  if (ms == null) return "";
  const m = Math.round(ms / 60000);
  if (m <= 0) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

function usd(micro) {
  const n = num(micro);
  return n === null ? null : n / 100000000;
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${body ? ` ${body.replace(/\s+/g, " ").slice(0, 90)}` : ""}`);
  }
  return res.json();
}

// /connect guarda las credenciales en opencode.db (tabla credential); auth.json
// queda solo como respaldo de instalaciones viejas.
async function credentials() {
  const out = { goKey: "", consoleToken: "", orgID: "" };
  try {
    const r = await exec("sqlite3", [
      "-json", "-readonly", `${home()}/.local/share/opencode/opencode.db`,
      "SELECT integration_id, value FROM credential WHERE active=1 AND integration_id IN ('opencode-go','opencode');",
    ]);
    if (r.code === 0 && r.stdout.trim()) {
      for (const row of JSON.parse(r.stdout)) {
        let v;
        try { v = JSON.parse(row.value ?? "{}"); } catch { continue; }
        if (row.integration_id === "opencode-go" && v.key) out.goKey = v.key;
        if (row.integration_id === "opencode") {
          if (v.access) { out.consoleToken = v.access; out.orgID = v.metadata?.orgID ?? ""; }
          else if (v.key) out.consoleToken = v.key;
        }
      }
    }
  } catch { /* respaldo abajo */ }
  if (out.goKey && out.consoleToken) return out;
  const text = await readTextFile(`${home()}/.local/share/opencode/auth.json`).catch(() => null);
  if (text) {
    try {
      const j = JSON.parse(text);
      out.goKey ||= j?.["opencode-go"]?.key ?? "";
      out.consoleToken ||= j?.opencode?.key ?? "";
    } catch { /* sin respaldo */ }
  }
  return out;
}

// Último modelo de Go usado en esta máquina y gasto de hoy, de la DB local de opencode.
// v2 guarda el modelo en session_message; el costo por mensaje solo existe en el
// esquema legacy (message), así que si no hay dato no se muestra nada inventado.
async function localStats() {
  const db = `${home()}/.local/share/opencode/opencode.db`;
  const out = { model: "", today: null };
  try {
    const r = await exec("sqlite3", [
      "-json", "-readonly", db,
      `SELECT
         (SELECT json_extract(data,'$.model.id') FROM session_message
            WHERE type='assistant' AND json_extract(data,'$.model.providerID')='opencode-go'
            ORDER BY time_created DESC LIMIT 1) AS modelV2,
         (SELECT json_extract(data,'$.modelID') FROM message
            WHERE json_extract(data,'$.role')='assistant'
              AND json_extract(data,'$.providerID')='opencode-go'
            ORDER BY time_created DESC LIMIT 1) AS modelLegacy,
         (SELECT ROUND(SUM(json_extract(data,'$.cost')),4) FROM message
            WHERE json_extract(data,'$.role')='assistant'
              AND json_extract(data,'$.providerID')='opencode-go'
              AND time_created >= strftime('%s','now','start of day')*1000) AS today;`,
    ]);
    if (r.code === 0 && r.stdout.trim()) {
      const row = JSON.parse(r.stdout)[0] ?? {};
      out.model = row.modelV2 || row.modelLegacy || "";
      const t = num(row.today);
      out.today = t && t > 0 ? t : null;
    }
  } catch { /* sin stats */ }
  return out;
}

async function goUsage(key) {
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  let last;
  for (const url of GO_URLS) {
    try {
      const data = await getJson(url, headers);
      const usage = data?.usage ?? data;
      const now = Date.now();
      const roll = usage?.rolling, week = usage?.weekly, month = usage?.monthly ?? usage?.month;
      return {
        rolling: windowPct(roll),
        weekly: windowPct(week),
        monthly: windowPct(month),
        resetRolling: windowReset(roll, now),
        resetWeekly: windowReset(week, now),
        resetMonthly: windowReset(month, now),
      };
    } catch (e) { last = e; }
  }
  throw last;
}

async function zenUsage(token, orgID) {
  const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
  if (orgID) headers["x-org-id"] = orgID;
  const [billing, summary] = await Promise.all([
    getJson("https://opencode.ai/console/api/billing/status", headers),
    getJson("https://opencode.ai/console/api/usage/summary?range=30d", headers).catch(() => null),
  ]);
  return {
    balance: usd(pick(billing, ["balanceMicroCents"])),
    spent: usd(pick(summary, ["totalCostMicroCents"])),
  };
}

// A qué ritmo se agota el mes: % que se alcanzaría al terminar el mes.
function forecast(monthly) {
  if (monthly === null) return null;
  const now = new Date();
  const day = now.getDate();
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  if (day < 1 || days < 1) return null;
  const projected = (monthly / day) * days;
  return { projected: Math.min(999, projected), over: projected > 100 };
}

export default class OpencodeUsage extends View {
  init(_props, cx) {
    this.go = null;
    this.zen = null;
    this.stats = null;
    this.error = null;
    this.updatedAt = 0;
    this.busy = false;
    this.expanded = localStorage.getItem("expanded") === "1";
    this.alerted = Number(localStorage.getItem("alerted") ?? "0");
    this.handle = cx.focus_handle();
    this.closing = false;
    // El foco hace que la misma tecla cierre en vez de reabrir.
    this.handle.focus();
    cx.spawn(async () => {
      for (;;) {
        const c = await nextCommand();
        if (c === "close" || c === "toggle") this.close();
      }
    });
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx, false));
    this.refresh(cx, true);
  }

  close() {
    if (this.closing) return;
    this.closing = true;
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  toggleExpanded(cx) {
    this.expanded = !this.expanded;
    localStorage.setItem("expanded", this.expanded ? "1" : "0");
    cx.notify();
  }

  refresh(cx, force) {
    if (this.busy) return;
    if (!force && this.updatedAt && Date.now() - this.updatedAt < MIN_GAP_MS) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      const errors = [];
      try {
        const { goKey, consoleToken, orgID } = await credentials();
        if (goKey) {
          try { this.go = await goUsage(goKey); }
          catch (e) { this.go = null; errors.push(`Go: ${e.message ?? e}`); }
        } else errors.push("Go: sin credencial");
        if (consoleToken) {
          try { this.zen = await zenUsage(consoleToken, orgID); }
          catch (e) { this.zen = null; errors.push(`Zen: ${e.message ?? e}`); }
        } else errors.push("Zen: sin credencial");
        this.stats = await localStats().catch(() => null);
        this.error = errors.length ? errors.join(" · ") : null;
        this.updatedAt = Date.now();
        this.checkAlert();
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.busy = false;
      }
      cx.notify();
    });
  }

  // Un aviso por umbral: no repite hasta que las ventanas se reseteen por debajo.
  checkAlert() {
    const worst = Math.max(
      this.go?.rolling ?? 0,
      this.go?.weekly ?? 0,
      this.go?.monthly ?? 0,
    );
    if (worst >= ALERT_AT && this.alerted < ALERT_AT) {
      this.alerted = ALERT_AT;
      localStorage.setItem("alerted", String(ALERT_AT));
      const label = worst === (this.go?.monthly ?? -1) ? "mensual" : worst === (this.go?.weekly ?? -1) ? "semanal" : "de 5h";
      notify({
        title: "OpenCode Go",
        body: `Uso ${label} al ${worst.toFixed(0)}%.`,
        level: worst >= 95 ? "warning" : "info",
        timeout: 6000,
      });
    } else if (worst < ALERT_AT - 10 && this.alerted >= ALERT_AT) {
      this.alerted = 0;
      localStorage.setItem("alerted", "0");
    }
  }

  bar(label, value, reset, t) {
    const v = value ?? 0;
    const tone = value === null ? t.dim : v >= 85 ? t.blocked : v >= 60 ? t.done : t.working;
    return v_flex().gap(2)
      .child(h_flex().justify_between().items_center()
        .child(div().text_size(10.5).text_color(t.muted).child(label))
        .child(div().text_size(10.5).text_color(value === null ? t.dim : t.foreground)
          .child(value === null ? "—" : `${v.toFixed(0)}%`)))
      .child(div().h(3).w_full().rounded(2).bg(t.raised).overflow_hidden()
        .child(div().h_full().rounded(2).w(`${value === null ? 0 : Math.max(1.5, v)}%`).bg(tone)))
      .when(Boolean(reset), (el) =>
        el.child(div().text_size(9).text_color(t.dim).child(`resets in ${dur(reset)}`)));
  }

  money(label, value, t) {
    return h_flex().justify_between().items_center()
      .child(div().text_size(10.5).text_color(t.muted).child(label))
      .child(div().text_size(11.5).text_color(t.foreground)
        .child(value == null ? "—" : `$${value.toFixed(2)}`));
  }

  detail(t) {
    const f = forecast(this.go?.monthly ?? null);
    const model = this.stats?.model ?? "";
    return v_flex().gap(3)
      .child(div().h(1).w_full().bg(t.border))
      .when(Boolean(f), (el) =>
        el.child(h_flex().justify_between().items_center()
          .child(div().text_size(9.5).text_color(t.dim).child("Projected by month end"))
          .child(div().text_size(10).text_color(f.over ? t.blocked : t.foreground)
            .child(`${f.projected.toFixed(0)}%`))))
      .when(Boolean(model), (el) =>
        el.child(div().text_size(9.5).text_color(t.dim).truncate().child(model)))
      .when(this.stats?.today != null, (el) => el.child(this.money("Spend today", this.stats.today, t)));
  }

  render(cx) {
    const t = theme();
    const dot = this.error ? t.blocked : t.working;
    return v_flex().id("root").size_full().bg(t.surface).p(11).gap(8).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { cx.stop_propagation(); this.close(); }
      })
      .on_size_change((_s, cx) => cx.notify())
      .child(h_flex().justify_between().items_center()
        .child(h_flex().gap(5).items_center()
          .child(div().text_size(10).text_color(t.dim).child("⠿"))
          .child(div().size(5).rounded(3).bg(dot))
          .child(div().text_size(10).font_semibold().text_color(t.foreground).child("OPENCODE"))
          .child(div().text_size(9.5).text_color(t.dim).child(ago(this.updatedAt))))
        .child(h_flex().gap(1).items_center()
          .child(div().id("expand").w(18).h(18).flex().items_center().justify_center().rounded(4)
            .text_size(10).text_color(this.expanded ? t.foreground : t.dim).cursor_pointer()
            .hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); this.toggleExpanded(cx); })
            .child(this.expanded ? "⌃" : "⌄"))
          .child(div().id("refresh").w(18).h(18).flex().items_center().justify_center().rounded(4)
            .text_size(11).text_color(this.busy ? t.working : t.dim).cursor_pointer()
            .hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); this.refresh(cx, true); })
            .child(this.busy ? "…" : "↻"))
          .child(div().id("close").w(18).h(18).flex().items_center().justify_center().rounded(4)
            .text_size(11).text_color(t.dim).cursor_pointer()
            .hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); this.close(); })
            .child("×"))))
      .child(v_flex().gap(6)
        .child(this.bar("Go 5h", this.go?.rolling ?? null, this.go?.resetRolling, t))
        .child(this.bar("Go week", this.go?.weekly ?? null, this.go?.resetWeekly, t))
        .child(this.bar("Go month", this.go?.monthly ?? null, this.go?.resetMonthly, t)))
      .child(div().h(1).w_full().bg(t.border))
      .child(v_flex().gap(4)
        .child(this.money("Zen balance", this.zen?.balance, t))
        .child(this.money("Spent 30d", this.zen?.spent, t)))
      .when(this.expanded, (el) => el.child(this.detail(t)))
      .when(Boolean(this.error), (el) =>
        el.child(div().text_size(9.5).text_color(t.blocked).child(this.error)));
  }
}
