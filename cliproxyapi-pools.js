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

const standardPeriods = {
  session: { label: "5-hour", minutes: 300 },
  weekly: { label: "Weekly", minutes: 10080 },
  monthly: { label: "Monthly", minutes: 43200 },
};
const codexPeriods = Object.keys(standardPeriods);
const periods = {
  ...standardPeriods,
  fable: { label: "Fable only", minutes: 10080 },
};

const managementPath = "/v0/management/";
const requestTimeout = 6;
const maxDetailRows = 24;

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

function resetTimestamp(resetMillis) {
  return new Date(resetMillis).toJSON();
}

function setWindow(windows, key, percent, resetMillis, windowMinutes = periods[key].minutes) {
  if (!Number.isFinite(percent)) return;
  windows[key] = {
    usedPercent: Math.max(0, Math.min(100, percent)),
    resetsAt: resetTimestamp(resetMillis),
    windowMinutes,
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
      ? codexPeriods.find((period) => periods[period].minutes === minutes)
      : fallback;
    if (!key) continue;
    const reset = Number.isFinite(window.reset_at) ? window.reset_at * 1000 : NaN;
    setWindow(windows, key, window.used_percent, reset, minutes > 0 ? minutes : null);
  }
  return windows;
}

function parseResetDate(value) {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

function claudeWindows(value) {
  const windows = {};
  setWindow(windows, "session", value.five_hour?.utilization, parseResetDate(value.five_hour?.resets_at));
  setWindow(windows, "weekly", value.seven_day?.utilization, parseResetDate(value.seven_day?.resets_at));

  const fable = Array.isArray(value.limits) && value.limits.find((limit) => {
    const modelName = limit?.scope?.model?.display_name;
    return limit?.kind === "weekly_scoped" && limit.group === "weekly"
      && Number.isFinite(limit.percent) && typeof modelName === "string"
      && /^fable(?:\s+\d+(?:\.\d+)*)?$/i.test(modelName.trim());
  });
  if (fable) setWindow(windows, "fable", fable.percent, parseResetDate(fable.resets_at));
  return windows;
}

function isSpendAmount(value) {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function claudeSpendCap(value) {
  const { is_enabled: enabled, used_credits: used, monthly_limit: limit, currency } = value.extra_usage ?? {};
  if (enabled !== true || !isSpendAmount(used) || !isSpendAmount(limit) || limit < 1) return null;
  const code = (typeof currency === "string" && currency.trim().toUpperCase()) || "USD";
  if (!/^[A-Z]{3}$/.test(code)) return null;
  // Claude's OAuth usage endpoint reports both amounts in hundredths of the currency.
  return { used: used / 100, limit: limit / 100, currency: code };
}

function codexCreditAmount(value) {
  const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
  const amount = typeof value === "string" && decimal.test(value.trim()) ? Number(value) : value;
  return isSpendAmount(amount) ? amount : undefined;
}

function codexSpendCap(value) {
  for (const container of [value, value.rate_limit, value.spend_control, value.spendControl]) {
    const cap = container?.individual_limit ?? container?.individualLimit;
    const limit = codexCreditAmount(cap?.limit);
    if (!(limit > 0)) continue;

    let used = codexCreditAmount(cap.used);
    let estimated = false;
    if (used === undefined) {
      let usedPercent = codexCreditAmount(cap.used_percent ?? cap.usedPercent);
      if (usedPercent === undefined) {
        const remainingPercent = codexCreditAmount(cap.remaining_percent ?? cap.remainingPercent);
        if (remainingPercent <= 100) usedPercent = 100 - remainingPercent;
      }
      if (usedPercent <= 100) {
        used = limit * usedPercent / 100;
        estimated = true;
      }
    }
    const resetSeconds = codexCreditAmount(cap.reset_at ?? cap.resets_at ?? cap.resetsAt);
    return {
      used,
      estimated,
      limit,
      resetsAt: Number.isInteger(resetSeconds) && resetSeconds > 0 ? resetTimestamp(resetSeconds * 1000) : null,
    };
  }
  return null;
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
  const isCodex = hub.id === "codex";
  const windows = isCodex ? codexWindows(quota, account) : claudeWindows(quota);
  const spend = isCodex ? codexSpendCap(quota) : claudeSpendCap(quota);
  return spend || Object.keys(windows).length > 0 ? { windows, spend } : { error: "Quota windows unavailable" };
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
  if (remainingMillis < 1000) return "now";

  const totalMinutes = Math.ceil(remainingMillis / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return [[days, "d"], [hours, "h"], [minutes, "m"]]
    .filter(([amount]) => amount > 0)
    .slice(0, 2)
    .map(([amount, unit]) => `${amount}${unit}`)
    .join(" ");
}

function resetZoneLabel(date, timeZone) {
  if (timeZone === "Asia/Kolkata" || timeZone === "Asia/Calcutta") return "IST";
  const offset = -date.getTimezoneOffset();
  if (offset === 0) return "UTC";
  const hours = Math.floor(Math.abs(offset) / 60);
  const minutes = Math.abs(offset) % 60;
  const fractionalHour = minutes ? `:${String(minutes).padStart(2, "0")}` : "";
  return `UTC${offset < 0 ? "-" : "+"}${hours}${fractionalHour}`;
}

function resetDetailFields(resetsAt, timeZone, nowMillis) {
  if (!resetsAt) return {};
  const date = new Date(resetsAt);
  const [month, day, hour, minute] = [
    date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(),
  ].map((part) => String(part).padStart(2, "0"));
  const zone = resetZoneLabel(date, timeZone);
  return { secondaryValue: `${hour}:${minute} ${zone} · ${formatResetCountdown(date, nowMillis)} · ${month}-${day}` };
}

function quotaPace({ resetsAt, windowMinutes, usedPercent }, nowMillis) {
  if (!resetsAt || !(windowMinutes > 0)) return undefined;
  const duration = windowMinutes * 60_000;
  const remaining = Date.parse(resetsAt) - nowMillis;
  if (!(remaining > 0) || remaining > duration) return undefined;
  if (remaining === duration && usedPercent > 0) return undefined;
  return (duration - remaining) / duration;
}

function spendRow(accountLabel, spend, ctx, nowMillis) {
  const formatAmount = spend.currency
    ? (amount) => ctx.format.currency(amount, spend.currency)
    : (amount) => ctx.format.number(amount, { maximumFractionDigits: 2 });
  const unit = spend.currency ? "" : " credits";
  const cap = `${formatAmount(spend.limit)}${unit}`;
  const hasUsage = spend.used !== undefined;
  const used = hasUsage ? `${spend.estimated ? "~" : ""}${formatAmount(spend.used)}` : null;
  return {
    label: `${accountLabel} · ${spend.currency ? "Monthly spend" : "Monthly credits"}`,
    value: hasUsage ? `${used} / ${cap}` : `${cap} cap`,
    ...(hasUsage ? { progress: Math.min(1, spend.used / spend.limit) } : {}),
    ...resetDetailFields(spend.resetsAt, ctx.env.timeZone, nowMillis),
  };
}

function visibleDetailRows(rows) {
  return rows.length > maxDetailRows
    ? [...rows.slice(0, maxDetailRows - 1), { label: "Details", value: "Additional rows hidden" }]
    : rows;
}

function detailSections({ hub, accounts, error }, ctx, nowMillis, showUsed) {
  if (error) return [{ title: hub.name, rows: [{ label: "Quota", value: error }] }];

  const rows = [];
  const standardRows = [];
  const extraRows = [];
  function addRow(row, extra = false) {
    rows.push(row);
    (extra ? extraRows : standardRows).push(row);
  }
  for (const [index, account] of accounts.entries()) {
    const label = `Account ${index + 1}`;
    if (account.error) {
      addRow({ label, value: account.error });
      continue;
    }
    for (const [period, window] of Object.entries(account.windows)) {
      const percent = showUsed ? window.usedPercent : 100 - window.usedPercent;
      const pace = quotaPace(window, nowMillis);
      // CodexBar compares the marker and fill as consumed fractions, so show the target as text for remaining quota.
      const target = !showUsed && pace !== undefined ? ` · target ${Math.round((1 - pace) * 100)}%` : "";
      addRow({
        label: `${label} · ${periods[period].label}`,
        value: `${Math.round(percent)}% ${showUsed ? "used" : "left"}${target}`,
        progress: percent / 100,
        pace: showUsed ? pace : undefined,
        ...resetDetailFields(window.resetsAt, ctx.env.timeZone, nowMillis),
      }, period === "fable");
    }
    if (account.spend) addRow(spendRow(label, account.spend, ctx, nowMillis), true);
  }

  if (rows.length <= maxDetailRows || extraRows.length === 0) {
    return [{ title: hub.name, rows: visibleDetailRows(rows) }];
  }
  return [
    { title: hub.name, rows: visibleDetailRows(standardRows) },
    { title: `${hub.name} extra limits`, rows: visibleDetailRows(extraRows) },
  ].filter((section) => section.rows.length > 0);
}

function averageWindows({ hub, accounts }) {
  const keys = hub.id === "codex" ? codexPeriods : Object.keys(periods);
  return keys.flatMap((key) => {
    const windows = accounts.map((account) => account.windows?.[key]).filter(Boolean);
    if (windows.length === 0) return [];
    const period = periods[key];
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
    { key: "QUOTA_BARS", title: "Quota bars", subtitle: "Enter remaining (default) or used.", type: "plain" },
  ],
  async fetchUsage(ctx) {
    requireLocalOrigins(ctx);
    const readings = await Promise.all(hubs.map((hub) => readHub(ctx, hub)));
    const extraWindows = readings.flatMap(averageWindows);
    const nowMillis = ctx.date.nowMillis();
    const showUsed = ctx.settings.get("QUOTA_BARS")?.trim().toLowerCase() === "used";
    const details = readings.flatMap((reading) => detailSections(reading, ctx, nowMillis, showUsed));
    const hasUsage = extraWindows.length > 0 || readings.some(({ accounts }) => accounts.some(({ spend }) => spend));
    if (!hasUsage) {
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
