import { escapeHtml } from "../lib/mail";
import type {
  DayBar,
  LongInfo,
  RecentInfo,
  Service,
  ServiceState,
  SlotBar,
  StatusView,
} from "./data";

const STATE_LABEL: Record<ServiceState, string> = {
  up: "Up",
  down: "Down",
  nodata: "No data",
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function clock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function when(ms: number, now: number): string {
  const sameDay = Math.floor(ms / 86_400_000) === Math.floor(now / 86_400_000);
  return `${sameDay ? "" : `${weekday(ms)} `}${clock(ms)}`;
}

function weekday(ms: number): string {
  return `${WEEKDAYS[new Date(ms).getUTCDay()]}, ${shortDate(ms)}`;
}

function shortDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

function dateTime(ms: number): string {
  const date = new Date(ms);
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${shortDate(ms)} ${date.getUTCFullYear()}, ${hours}:${minutes}`;
}

const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`;

const STYLE = `
:root{color-scheme:dark;--bg:#0c0c0e;--card:#141417;--border:#27272d;--fg:#ededf0;--muted:#8a8a94;--up:#34d399;--partial:#f5b544;--down:#f0616d}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:760px;margin:0 auto;padding:40px 16px 56px}
h1{margin:0;font-size:24px;font-weight:600;letter-spacing:-0.01em}
.banner{margin:16px 0 0;padding:14px 16px;border:1px solid var(--border);border-radius:10px;background:var(--card);font-weight:500}
.banner-up{color:var(--up);border-color:rgba(52,211,153,.35)}
.banner-down{color:var(--down);border-color:rgba(240,97,109,.45)}
.banner-nodata{color:var(--muted)}
h2{margin:40px 0 12px;font:500 11px/1.4 ${MONO};letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.services,.incidents{list-style:none;margin:0;padding:0;border:1px solid var(--border);border-radius:10px;background:var(--card)}
.service{padding:16px}
.service+.service,.incidents li+li{border-top:1px solid var(--border)}
.head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.name{min-width:0}
h3{margin:0;font-size:15px;font-weight:600;overflow-wrap:anywhere}
.note{margin:2px 0 0;color:var(--muted);font-size:13px;overflow-wrap:anywhere}
.meta{display:flex;flex:none;align-items:center;gap:8px}
.latency{font:12px/1 ${MONO};color:var(--muted)}
.state{flex:none;padding:5px 8px;border:1px solid var(--border);border-radius:999px;font:500 12px/1 ${MONO}}
.state-up{color:var(--up)}
.state-down{color:var(--down);border-color:rgba(240,97,109,.45)}
.state-nodata{color:var(--muted)}
.range{position:absolute;opacity:0;pointer-events:none}
.section-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin:40px 0 12px}
.section-head h2{margin:0}
.tabs{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--border);border-radius:8px;background:var(--card)}
.tabs label{padding:4px 10px;border-radius:6px;font:500 12px/1.4 ${MONO};color:var(--muted);cursor:pointer}
.tabs label:hover{color:var(--fg)}
#range-day:checked~.section-head label[for=range-day],#range-90:checked~.section-head label[for=range-90]{background:var(--border);color:var(--fg)}
#range-day:focus-visible~.section-head label[for=range-day],#range-90:focus-visible~.section-head label[for=range-90]{outline:2px solid #8b7bff;outline-offset:1px}
.view-90{display:none}
#range-90:checked~.services .view-day{display:none}
#range-90:checked~.services .view-90{display:block}
.bars{display:flex;gap:2px;height:28px;margin-top:12px}
.bar{position:relative;flex:1;min-width:0;border-radius:2px}
.bar:hover{filter:brightness(1.3)}
.bar:hover::after,.tip:hover::after,.tip:focus::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);z-index:2;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:#1e1e23;color:var(--fg);font:12px/1.3 ${MONO};white-space:nowrap;pointer-events:none}
.bar:nth-child(-n+8):hover::after{left:0;transform:none}
.bar:nth-last-child(-n+8):hover::after{left:auto;right:0;transform:none}
.tip{position:relative;border-radius:4px;cursor:help;text-decoration:underline dotted;text-underline-offset:3px}
.tip:hover{color:var(--fg)}
.tip:hover::after,.tip:focus::after{white-space:pre;text-align:left}
.tip:focus{outline:none}
.tip:focus-visible{outline:2px solid #8b7bff;outline-offset:2px}
.bar-up{background:rgba(52,211,153,.85)}
.bar-partial{background:var(--partial)}
.bar-down{background:var(--down)}
.bar-none,.bar-nodata{background:var(--border)}
.legend{display:flex;justify-content:space-between;gap:8px;margin-top:6px;font:11px/1.4 ${MONO};color:var(--muted)}
.narrow{display:none}
.basis{margin:8px 0 0;color:var(--muted);font-size:12px}
.incidents li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;padding:12px 16px}
.incident-name{font-weight:500;overflow-wrap:anywhere}
.incident-time{grid-column:1;color:var(--muted);font:12px/1.4 ${MONO}}
.incident-open,.incident-resolved{grid-column:2;grid-row:1/3;align-self:center;font:12px/1.4 ${MONO};text-align:right}
.incident-open{color:var(--down)}
.incident-resolved{color:var(--muted)}
.empty{margin:0;padding:16px;border:1px solid var(--border);border-radius:10px;background:var(--card);color:var(--muted)}
footer{margin-top:40px;color:var(--muted);font:12px/1.5 ${MONO}}
.paused{margin:16px 0 0;padding:14px 16px;border:1px solid rgba(139,123,255,.45);border-radius:10px;background:var(--card)}
.paused p{margin:0;color:var(--muted);font-size:14px}
.paused strong{color:var(--fg)}
.resume{display:inline-block;margin-top:12px;padding:8px 14px;border-radius:8px;background:#8b7bff;color:#0c0c0e;font-weight:600;text-decoration:none}
.resume:hover{background:#9d8fff}
@media (max-width:560px){.view-90 .bar:nth-child(-n+60){display:none}.view-90 .bar:nth-child(n+61):nth-child(-n+68):hover::after{left:0;transform:none}.wide{display:none}.narrow{display:inline}}
`;

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  return `${rest}m`;
}

export function banner(services: Service[]): {
  text: string;
  tone: ServiceState;
} {
  if (services.length === 0)
    return { text: "Nothing to show yet", tone: "nodata" };
  const down = services.filter((service) => service.state === "down").length;
  if (down > 0) {
    return {
      text: `${down} ${down === 1 ? "service" : "services"} down`,
      tone: "down",
    };
  }
  if (services.every((service) => service.state === "nodata")) {
    return { text: "No recent data", tone: "nodata" };
  }
  return { text: "All systems operational", tone: "up" };
}

function uptimeText(value: number | null): string {
  return value === null
    ? "--"
    : `${(Math.floor(value * 100) / 100).toFixed(2)}%`;
}

function dayTip(day: DayBar): string {
  const date = weekday(day.start);
  if (day.state === "none") return `${date} · not monitored yet`;
  if (day.state === "up") return `${date} · no incidents`;
  return `${date} · down ${formatDuration(day.downMs)}`;
}

function slotTip(slot: SlotBar, now: number): string {
  const span = `${when(slot.start, now)}–${clock(slot.start + 30 * 60_000)} UTC`;
  if (slot.state === "none") return `${span} · not monitored yet`;
  if (slot.state === "nodata") return `${span} · no data`;
  if (slot.state === "up") return `${span} · up`;
  return `${span} · down ${slot.down} of ${slot.up + slot.down}`;
}

function recentTip(info: RecentInfo, now: number): string {
  const since = `Since ${when(info.since, now)} UTC`;
  if (info.total === 0) return `${since}\nNo reports yet`;
  return [
    since,
    `${info.up} of ${info.total} reports up`,
    info.lastDown === null
      ? "No downtime recorded"
      : `Last down ${when(info.lastDown, now)} UTC`,
  ].join("\n");
}

function longTip(info: LongInfo): string {
  const since = `Since ${weekday(info.since)}`;
  if (info.lastDown === null) return `${since}\nNo downtime recorded`;
  return [
    since,
    `${info.incidents} ${info.incidents === 1 ? "incident" : "incidents"}, down ${formatDuration(info.downMs)}`,
    `Last down ${weekday(info.lastDown)} ${clock(info.lastDown)} UTC`,
  ].join("\n");
}

function uptimeTip(value: number | null, tip: string): string {
  return `<span class="tip" tabindex="0" data-tip="${escapeHtml(tip)}">${uptimeText(value)} uptime</span>`;
}

function bar(state: string, tip: string): string {
  return `<span class="bar bar-${state}" data-tip="${escapeHtml(tip)}"></span>`;
}

function serviceItem(service: Service, now: number): string {
  const daySummary = `${service.name}: ${uptimeText(service.recentUptime)} of reports up over 24 hours`;
  const longSummary = `${service.name}: ${uptimeText(service.uptime)} uptime over 90 days`;
  const slots = service.recent
    .map((slot) => bar(slot.state, slotTip(slot, now)))
    .join("");
  const days = service.days.map((day) => bar(day.state, dayTip(day))).join("");
  return `<li class="service">
<div class="head"><div class="name"><h3>${escapeHtml(service.name)}</h3>${
    service.note ? `<p class="note">${escapeHtml(service.note)}</p>` : ""
  }</div><div class="meta">${
    service.state === "up" && service.latencyMs !== null
      ? `<span class="latency">${service.latencyMs} ms</span>`
      : ""
  }<span class="state state-${service.state}">${STATE_LABEL[service.state]}</span></div></div>
<div class="view view-day"><div class="bars" role="img" aria-label="${escapeHtml(daySummary)}">${slots}</div>
<div class="legend"><span>24 hours ago</span>${uptimeTip(service.recentUptime, recentTip(service.recentInfo, now))}<span>Now</span></div></div>
<div class="view view-90"><div class="bars" role="img" aria-label="${escapeHtml(longSummary)}">${days}</div>
<div class="legend"><span><span class="wide">90 days ago</span><span class="narrow">30 days ago</span></span>${uptimeTip(service.uptime, longTip(service.longInfo))}<span>Today</span></div></div>
</li>`;
}

function incidentList(view: StatusView, now: number): string {
  if (view.incidents.length === 0) {
    return `<p class="empty">No incidents in the last 30 days.</p>`;
  }
  const items = view.incidents
    .map((incident) => {
      const outcome =
        incident.resolvedAt === null
          ? `<span class="incident-open">Ongoing for ${formatDuration(now - incident.startedAt)}</span>`
          : `<span class="incident-resolved">Resolved after ${formatDuration(incident.resolvedAt - incident.startedAt)}</span>`;
      return `<li><span class="incident-name">${escapeHtml(incident.name)}</span>${outcome}<span class="incident-time">${dateTime(incident.startedAt)} UTC</span></li>`;
    })
    .join("");
  return `<ul class="incidents">${items}</ul>`;
}

const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0c0c0e"/><rect x="8" y="8" width="16" height="16" rx="4" fill="#8b7bff"/></svg>',
)}`;

export const REFRESH_ROUNDS = 2;
const REFRESH_SECONDS = 600;

export function personalize(
  html: string,
  round: number,
  renderedAt: number,
): string {
  const paused = round >= REFRESH_ROUNDS;
  const refresh = paused
    ? ""
    : `<meta http-equiv="refresh" content="${REFRESH_SECONDS};url=/?r=${round + 1}">`;
  const notice = paused
    ? `<div class="paused" role="status"><p><strong>Updates paused.</strong> This page stopped refreshing after ${(REFRESH_ROUNDS * REFRESH_SECONDS) / 60} minutes. The data below is from ${dateTime(renderedAt)} UTC.</p><a class="resume" href="/">Resume updates</a></div>`
    : "";
  return html
    .replace("<!--refresh-->", refresh)
    .replace("<!--paused-->", notice);
}

export function renderStatus(view: StatusView, now: number): string {
  const head = banner(view.services);
  const services =
    view.services.length > 0
      ? `<ul class="services">${view.services.map((service) => serviceItem(service, now)).join("")}</ul>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!--refresh-->
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark">
<title>Service status</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON}">
<style>${STYLE}</style>
</head>
<body>
<main>
<input type="radio" name="range" id="range-day" class="range" checked>
<input type="radio" name="range" id="range-90" class="range">
<h1>Service status</h1>
<!--paused-->
<p class="banner banner-${head.tone}">${head.text}</p>
<div class="section-head"><h2>Services</h2><div class="tabs" role="group" aria-label="Range"><label for="range-day">24 hours</label><label for="range-90">90 days</label></div></div>
${services}
<p class="basis">The 24-hour view counts check reports; the 90-day view and its uptime come from recorded incidents. Orange means part of a bar was down, red most of it. Times are UTC.</p>
<h2>Incidents, last 30 days</h2>
${incidentList(view, now)}
<footer>Monitored by Krynodes · updated ${dateTime(now)} UTC</footer>
</main>
</body>
</html>`;
}
