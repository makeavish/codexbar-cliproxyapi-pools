const hubs = [
  {
    id: "codex",
    name: "Codex",
    setting: "CODEX_URL",
    origin: "http://127.0.0.1:8317",
    usageURL: "https://chatgpt.com/backend-api/wham/usage",
    headers: {
      "OpenAI-Beta": "codex-1",
      Originator: "Codex Desktop",
      "Content-Type": "application/json",
    },
  },
  {
    id: "claude",
    name: "Claude",
    setting: "CLAUDE_URL",
    origin: "http://127.0.0.1:8318",
    usageURL: "https://api.anthropic.com/api/oauth/usage",
    headers: {
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-code/2.1.273",
    },
  },
];

const periods = {
  session: { label: "5-hour", minutes: 300 },
  weekly: { label: "Weekly", minutes: 10080 },
  monthly: { label: "Monthly", minutes: 43200 },
};

const managementPath = "/v0/management/";
const requestTimeout = 6;

function requireLocalOrigins(ctx) {
  for (const hub of hubs) {
    const configured = ctx.settings.get(hub.setting)?.trim().replace(/\/$/, "");
    if (configured !== hub.origin) {
      throw ctx.fail.permissionDenied(`Set ${hub.name} hub URL to ${hub.origin}.`);
    }
  }
}

function parseJSON(body) {
  try {
    const value = JSON.parse(body);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function readProxyResponse(send) {
  try {
    const response = await send();
    if (response.status < 200 || response.status >= 300) {
      return { error: `Proxy HTTP ${response.status}` };
    }

    const value = parseJSON(response.bodyText);
    return value ? { value } : { error: "Proxy returned invalid data" };
  } catch (error) {
    if (error?.transportClass === "cancelled") throw error;
    return { error: "Proxy unavailable" };
  }
}

function setWindow(windows, key, percent, resetMillis) {
  if (!Number.isFinite(percent)) return;
  const reset = new Date(resetMillis);
  windows[key] = {
    usedPercent: Math.max(0, Math.min(100, percent)),
    resetsAt: Number.isFinite(reset.getTime()) ? reset.toISOString() : null,
  };
}

function codexWindows(value, account) {
  const windows = {};
  const plan = value.plan_type ?? account.id_token?.plan_type ?? account.id_token?.chatgpt_plan_type;
  const primaryDefault = plan === "free" || plan === "go" ? "monthly" : "session";
  const providerWindows = [
    [value.rate_limit?.primary_window, primaryDefault],
    [value.rate_limit?.secondary_window, "weekly"],
  ];
  for (const [window, fallback] of providerWindows) {
    if (!Number.isFinite(window?.used_percent)) continue;
    const minutes = window.limit_window_seconds / 60;
    const key = minutes > 0
      ? Object.keys(periods).find((period) => periods[period].minutes === minutes)
      : fallback;
    if (!key) continue;
    const reset = Number.isFinite(window.reset_at) ? window.reset_at * 1000 : NaN;
    setWindow(windows, key, window.used_percent, reset);
  }
  return windows;
}

function claudeWindows(value) {
  const windows = {};
  setWindow(windows, "session", value.five_hour?.utilization, Date.parse(value.five_hour?.resets_at));
  setWindow(windows, "weekly", value.seven_day?.utilization, Date.parse(value.seven_day?.resets_at));
  return windows;
}

async function readAccount(ctx, hub, account) {
  const headers = { Authorization: "Bearer $TOKEN$", ...hub.headers };
  const workspaceId = account.id_token?.chatgpt_account_id;
  if (hub.id === "codex" && typeof workspaceId === "string" && /^[A-Za-z0-9_-]+$/.test(workspaceId)) {
    headers["Chatgpt-Account-Id"] = workspaceId;
  }

  const response = await readProxyResponse(() => ctx.http.post(`${hub.origin}${managementPath}api-call`, {
    timeoutSeconds: requestTimeout,
    body: { auth_index: account.auth_index, method: "GET", url: hub.usageURL, header: headers },
  }));
  if (response.error) return response;
  const { body, status_code: status } = response.value;
  if (!Number.isInteger(status)) return { error: "Invalid proxy response" };
  if (status < 200 || status >= 300) return { error: `${hub.name} HTTP ${status}` };

  const quota = parseJSON(body);
  if (!quota) return { error: "Invalid quota response" };
  const windows = hub.id === "codex" ? codexWindows(quota, account) : claudeWindows(quota);
  return Object.keys(windows).length > 0 ? { windows } : { error: "Quota windows unavailable" };
}

async function readHub(ctx, hub) {
  const response = await readProxyResponse(() => ctx.http.get(`${hub.origin}${managementPath}auth-files`, {
    timeoutSeconds: requestTimeout,
  }));
  if (response.error) return { hub, accounts: [], error: response.error };
  if (!Array.isArray(response.value.files)) {
    return { hub, accounts: [], error: "Invalid credential list" };
  }

  const accounts = new Map();
  for (const credential of response.value.files) {
    if (credential?.provider !== hub.id || credential.disabled || credential.account_type === "api_key") continue;
    if (typeof credential.auth_index !== "string" || !credential.auth_index.trim()) continue;
    accounts.set(credential.auth_index, credential);
  }
  if (accounts.size === 0) return { hub, accounts: [], error: "No enabled OAuth accounts" };

  const sorted = [...accounts.keys()].sort();
  const readings = await Promise.all(sorted.map((id) => readAccount(ctx, hub, accounts.get(id))));
  return { hub, accounts: readings };
}

function formatResetCountdown(date, nowMillis) {
  const remainingMillis = date.getTime() - nowMillis;
  if (remainingMillis < 1000) return "Resets now";

  const totalMinutes = Math.ceil(remainingMillis / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  const duration = [[days, "d"], [hours, "h"], [minutes, "m"]]
    .filter(([amount]) => amount > 0)
    .slice(0, 2)
    .map(([amount, unit]) => `${amount}${unit}`)
    .join(" ");
  return `Resets in ${duration}`;
}

function formatResetDetails(resetsAt, timeZone, nowMillis) {
  const date = new Date(resetsAt);
  const [month, day, hour, minute] = [
    date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(),
  ].map((part) => String(part).padStart(2, "0"));
  const zone = timeZone === "Asia/Kolkata" || timeZone === "Asia/Calcutta" ? "IST" : timeZone;
  return `${formatResetCountdown(date, nowMillis)} · ${month}-${day} ${hour}:${minute} ${zone}`;
}

function detailSection({ hub, accounts, error }, timeZone, nowMillis) {
  if (error) return { title: hub.name, rows: [{ label: "Quota", value: error }] };

  const rows = accounts.flatMap((account, index) => {
    const label = `Account ${index + 1}`;
    if (account.error) return [{ label, value: account.error }];
    return Object.entries(account.windows).map(([period, window]) => ({
      label: `${label} · ${periods[period].label}`,
      value: `${Math.round(100 - window.usedPercent)}% left`,
      progress: window.usedPercent / 100,
      ...(window.resetsAt ? { secondaryValue: formatResetDetails(window.resetsAt, timeZone, nowMillis) } : {}),
    }));
  });
  const visibleRows = rows.length > 24
    ? [...rows.slice(0, 23), { label: "Details", value: "Additional rows hidden" }]
    : rows;
  return { title: hub.name, rows: visibleRows };
}

function averageWindows({ hub, accounts }) {
  return Object.entries(periods).flatMap(([key, period]) => {
    const windows = accounts.map((account) => account.windows?.[key]).filter(Boolean);
    if (windows.length === 0) return [];
    const usedPercent = windows.reduce((sum, window) => sum + window.usedPercent, 0) / windows.length;
    return [{
      id: `${hub.id}-${key}`,
      title: `${hub.name} ${period.label} average (${windows.length}/${accounts.length})`,
      window: { usedPercent, windowMinutes: period.minutes },
    }];
  });
}

defineProvider({
  id: "cliproxyapi-pools",
  name: "CLIProxyAPI Pools",
  icon: { monogram: "CP", tint: "#64748B" },
  endpoints: hubs.map((hub) => ({ setting: hub.setting, policy: "https-or-private-network-http" })),
  auth: { type: "bearer", secret: "MANAGEMENT_KEY" },
  capabilities: ["http-status"],
  settings: [
    ...hubs.map((hub) => ({ key: hub.setting, title: `${hub.name} hub URL`, subtitle: hub.origin, type: "plain" })),
    { key: "MANAGEMENT_KEY", title: "Management key", subtitle: "The shared management password for both local proxy panels", type: "secure" },
  ],
  async fetchUsage(ctx) {
    requireLocalOrigins(ctx);
    const readings = await Promise.all(hubs.map((hub) => readHub(ctx, hub)));
    const extraWindows = readings.flatMap(averageWindows);
    const nowMillis = ctx.date.nowMillis();
    const details = readings.map((reading) => detailSection(reading, ctx.env.timeZone, nowMillis));
    if (extraWindows.length === 0) {
      const errors = details.map(({ title, rows }) => `${title} (${rows[0].value})`);
      throw ctx.fail.providerUnavailable(`Quota unavailable for ${errors.join(" and ")}.`);
    }

    const snapshot = { extraWindows, details, dataConfidence: "percentOnly" };
    if (ctx.env.supportsMenuBarItems === true) {
      snapshot.menuBarItems = hubs.flatMap((hub) => {
        const window = extraWindows.find(({ id }) => id.startsWith(`${hub.id}-`));
        return window ? [{ title: hub.name, iconProvider: hub.id, windowID: window.id }] : [];
      });
    }
    return snapshot;
  },
});
