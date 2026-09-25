// Account-scoped settings surfaces, in two parts:
//
// 1. Account usage (B6) — Settings → Usage, a section above the cost
//    dashboard iframe. `get_usage` returns the omp-defined
//    `omp usage --json` payload, whose shape may drift, so rendering is
//    fully defensive: recognized provider → account → limit nesting renders
//    as titled groups with labeled rows, and any unrecognized shape falls
//    back to generic key/value rows or a pretty-printed <pre>. Auth-flavored
//    errors get a hint to log in on the Providers page.
//
// 2. OAuth login (B3) — Configuration → Providers, below the auth-keys
//    container. A provider name + Login button sends `run_omp_login`; while
//    it runs (up to five minutes) a spinner and a "we opened your browser"
//    hint show. Success reloads the API-keys panel; failure shows the
//    output tail plus the terminal escape hatch.
//
// Chrome follows the mcp-manager conventions: built once with data-i18n
// attributes (applyTranslations keeps it current), dynamic bodies re-render
// via t() on onLanguageChanged.

import { onLanguageChanged, t } from "./i18n.js";
import { wsRpc } from "./ws-rpc.js";

// F7: frontend timeouts must outlive the server-side windows they mirror —
// `get_usage` shells out to the omp CLI with a 45s allowance, and
// `run_omp_login` waits on a human completing a browser flow for up to 5
// minutes. When the frontend timer fired first it masked the server's own
// (diagnostic-rich) failure with a bare "timeout" — and ws-rpc discards a
// reply that arrives after its timer (the response listener is removed when
// the timer fires), so a late result cannot be recovered. The fix is
// headroom: usage = 45s server window + 15s, oauth = 5min + 30s. The
// frontend timer only fires when the server window has truly closed.
const USAGE_TIMEOUT_MS = 60000;
/** run_omp_login can wait on a human completing a browser flow (5min server
 * window + 30s headroom, see F7 note above). */
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000 + 30 * 1000;
const PROVIDER_RE = /^[a-z0-9_-]+$/i;
/** Keys that name a group when iterating unknown provider/account shapes. */
const NAME_KEYS = ["name", "id", "provider", "label", "title", "email", "account", "user"];
/** Output tail shown after a failed login — enough context, not a wall. */
const OUTPUT_TAIL_CHARS = 2000;

const REFRESH_ICON_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>';

function isPrimitive(value) {
  return value === null || typeof value !== "object";
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return String(value);
  return String(value);
}

function titleForItem(item, index) {
  if (item && typeof item === "object") {
    for (const key of NAME_KEYS) {
      const value = item[key];
      if (typeof value === "string" && value.trim()) return value;
      if (typeof value === "number") return String(value);
    }
  }
  return `#${index + 1}`;
}

/** Values from an object usable as a group title. */
function extractTitle(value) {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number") return String(value);
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// Account usage (Settings → Usage)
// ═══════════════════════════════════════════════════════════════════════

export function createAccountUsage({ root, wsClient, requestTimeoutMs = USAGE_TIMEOUT_MS } = {}) {
  if (!root) return { refresh: async () => {}, destroy: () => {} };

  let destroyed = false;
  let loading = false;
  let errorText = null;
  let data = null;

  // ── Chrome (data-i18n keeps labels language-current) ──────────────────
  const header = document.createElement("div");
  header.className = "account-usage-header";

  const title = document.createElement("span");
  title.className = "settings-section-title";
  title.setAttribute("data-i18n", "usage.accountUsage");
  title.textContent = t("usage.accountUsage");

  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "icon-btn account-usage-refresh";
  refreshBtn.innerHTML = REFRESH_ICON_SVG;
  refreshBtn.title = t("usage.refresh");
  refreshBtn.setAttribute("aria-label", t("usage.refresh"));
  refreshBtn.setAttribute("data-i18n-title", "usage.refresh");
  refreshBtn.setAttribute("data-i18n-aria-label", "usage.refresh");
  refreshBtn.addEventListener("click", () => void refresh());

  header.append(title, refreshBtn);

  const body = document.createElement("div");
  body.className = "account-usage-body";
  root.append(header, body);

  // ── Defensive rendering ───────────────────────────────────────────────

  function appendRow(container, label, value) {
    const row = document.createElement("div");
    row.className = "account-usage-row";
    const labelEl = document.createElement("span");
    labelEl.className = "account-usage-label";
    labelEl.textContent = label;
    const valueEl = document.createElement("span");
    valueEl.className = "account-usage-value";
    valueEl.textContent = formatValue(value);
    row.append(labelEl, valueEl);
    container.appendChild(row);
  }

  function appendGroupTitle(container, text) {
    const el = document.createElement("div");
    el.className = "account-usage-group-title";
    el.textContent = text;
    container.appendChild(el);
  }

  function appendPre(container, key, value) {
    const wrap = document.createElement("div");
    wrap.className = "account-usage-pre-wrap";
    const label = document.createElement("div");
    label.className = "account-usage-group-title";
    label.textContent = key;
    const pre = document.createElement("pre");
    pre.className = "account-usage-pre";
    try {
      pre.textContent = JSON.stringify(value, null, 2);
    } catch {
      pre.textContent = String(value);
    }
    wrap.append(label, pre);
    container.appendChild(wrap);
  }

  function entriesOf(value) {
    if (Array.isArray(value)) return value.map((v, i) => [String(i), v]);
    if (value && typeof value === "object") return Object.entries(value);
    return [];
  }

  /**
   * Generic walker: primitives become labeled rows; arrays of primitives
   * collapse into one row; collections become titled subgroups (array items
   * are titled by their name-ish field); anything too wide or too deep falls
   * back to a pretty-printed <pre>. Depth- and width-bounded so pathological
   * payloads can't explode the DOM.
   */
  function appendObject(container, value, depth) {
    const entries = entriesOf(value);
    const rows = entries.filter(([, v]) => isPrimitive(v));
    const groups = entries.filter(([, v]) => !isPrimitive(v));
    for (const [key, v] of rows) appendRow(container, key, v);
    for (const [key, v] of groups) {
      if (Array.isArray(v)) {
        if (v.every(isPrimitive) && v.length <= 12) {
          appendRow(container, key, v.map((item) => formatValue(item)).join(", "));
          continue;
        }
        if (v.length > 24 || depth >= 6) {
          appendPre(container, key, v);
          continue;
        }
        appendGroupTitle(container, key);
        v.forEach((item, index) => {
          appendGrouped(container, item, index, depth + 1);
        });
        continue;
      }
      if (depth < 6 && entriesOf(v).length > 0 && entriesOf(v).length <= 24) {
        appendGroupTitle(container, key);
        appendObject(container, v, depth + 1);
      } else {
        appendPre(container, key, v);
      }
    }
  }

  /** One collection entry: primitives become rows, objects become groups. */
  function appendGrouped(container, item, index, depth) {
    if (isPrimitive(item)) {
      appendRow(container, `#${index + 1}`, item);
      return;
    }
    appendGroupTitle(container, titleForItem(item, index));
    const group = document.createElement("div");
    group.className = "account-usage-group";
    appendObject(group, item, depth);
    container.appendChild(group);
  }

  function renderData(container, raw) {
    const usage = raw && typeof raw === "object" && raw.usage !== undefined ? raw.usage : raw;
    if (usage === null || usage === undefined) {
      container.append(note(t("usage.empty")));
      return;
    }
    const entries = entriesOf(usage);
    const list = Array.isArray(usage) ? usage : entries;

    if (list.length === 0) {
      container.append(note(t("usage.empty")));
      return;
    }

    // Provider-style shape: a `providers` collection renders as titled
    // provider groups, each walked generically so account → limit nesting
    // surfaces as labeled rows. Leftover top-level keys form a general group.
    const providers =
      usage && typeof usage === "object" && !Array.isArray(usage) ? usage.providers : undefined;

    if (providers !== undefined) {
      const providerEntries = entriesOf(providers);
      const restEntries = Object.entries(usage).filter(([key]) => key !== "providers");
      if (providerEntries.length === 0 && restEntries.length === 0) {
        container.append(note(t("usage.empty")));
        return;
      }
      providerEntries.forEach(([key, provider], index) => {
        appendGroupTitle(container, extractTitle(key) || titleForItem(provider, index));
        const group = document.createElement("div");
        group.className = "account-usage-group";
        appendObject(group, provider, 1);
        container.appendChild(group);
      });
      if (restEntries.length > 0) {
        appendGroupTitle(container, t("usage.general"));
        const group = document.createElement("div");
        group.className = "account-usage-group";
        appendObject(group, Object.fromEntries(restEntries), 1);
        container.appendChild(group);
      }
      return;
    }

    // Flat array of items → one titled group per item.
    if (Array.isArray(usage)) {
      usage.forEach((item, index) => {
        appendGroupTitle(container, titleForItem(item, index));
        const group = document.createElement("div");
        group.className = "account-usage-group";
        appendObject(group, item ?? {}, 1);
        container.appendChild(group);
      });
      return;
    }

    // Unknown object shape → generic key/value walk.
    appendObject(container, usage, 0);
  }

  function note(text, extraClass = "") {
    const el = document.createElement("div");
    el.className = `settings-api-keys-empty account-usage-note ${extraClass}`.trim();
    el.textContent = text;
    return el;
  }

  function render() {
    refreshBtn.disabled = loading;
    refreshBtn.setAttribute("aria-busy", String(loading));
    body.replaceChildren();
    if (loading) {
      body.append(note(t("common.loading")));
      return;
    }
    if (errorText !== null) {
      body.append(note(`${t("usage.loadFailed")}: ${errorText}`, "account-usage-error"));
      if (/auth|login|unauthor|401|403|token|credential/i.test(errorText)) {
        body.append(note(t("usage.authHint")));
      }
      return;
    }
    try {
      renderData(body, data);
    } catch {
      // Last-resort guard: shape drift must never take the settings down.
      body.replaceChildren();
      const pre = document.createElement("pre");
      pre.className = "account-usage-pre";
      try {
        pre.textContent = JSON.stringify(data, null, 2);
      } catch {
        pre.textContent = String(data);
      }
      body.appendChild(pre);
    }
  }

  async function refresh() {
    if (destroyed || loading) return;
    loading = true;
    render();
    const result = await wsRpc(wsClient, { type: "get_usage" }, { timeoutMs: requestTimeoutMs });
    if (destroyed) return;
    loading = false;
    if (!result.ok) {
      errorText = result.error || "unknown error";
    } else {
      errorText = null;
      data = result.data;
    }
    render();
  }

  const unsubscribeLanguage = onLanguageChanged(() => {
    refreshBtn.title = t("usage.refresh");
    refreshBtn.setAttribute("aria-label", t("usage.refresh"));
    render();
  });

  render();

  return {
    refresh,
    destroy: () => {
      destroyed = true;
      unsubscribeLanguage();
      root.replaceChildren();
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// OAuth login (Configuration → Providers)
// ═══════════════════════════════════════════════════════════════════════

export function createOAuthLogin({
  root,
  wsClient,
  reloadApiKeys = () => {},
  requestTimeoutMs = OAUTH_TIMEOUT_MS,
} = {}) {
  if (!root) return { destroy: () => {} };

  let destroyed = false;
  let pending = false;

  // ── Chrome ─────────────────────────────────────────────────────────────
  const label = document.createElement("span");
  label.className = "settings-label oauth-login-label";
  label.setAttribute("data-i18n", "oauth.title");
  label.textContent = t("oauth.title");

  const input = document.createElement("input");
  input.type = "text";
  input.className = "settings-input oauth-login-input";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = t("oauth.providerPlaceholder");
  input.setAttribute("data-i18n-placeholder", "oauth.providerPlaceholder");
  input.setAttribute("aria-label", t("oauth.title"));
  input.setAttribute("data-i18n-aria-label", "oauth.title");

  const loginBtn = document.createElement("button");
  loginBtn.type = "button";
  loginBtn.className = "settings-value-btn oauth-login-btn";
  loginBtn.setAttribute("data-i18n", "oauth.login");
  loginBtn.textContent = t("oauth.login");

  const row = document.createElement("div");
  row.className = "oauth-login-row";
  row.append(label, input, loginBtn);

  const status = document.createElement("div");
  status.className = "oauth-login-status hidden";
  const spinner = document.createElement("span");
  spinner.className = "settings-btn-spinner hidden";
  const statusText = document.createElement("span");
  status.append(spinner, statusText);

  const output = document.createElement("pre");
  output.className = "oauth-login-output hidden";
  const advice = document.createElement("div");
  advice.className = "oauth-login-advice hidden";

  root.append(row, status, output, advice);

  function setControlsDisabled(disabled) {
    input.disabled = disabled;
    loginBtn.disabled = disabled;
  }

  function showPending() {
    status.classList.remove("hidden");
    spinner.classList.remove("hidden");
    statusText.textContent = `${t("oauth.browserHint")} ${t("oauth.pending")}`;
    output.classList.add("hidden");
    output.textContent = "";
    advice.classList.add("hidden");
    advice.textContent = "";
  }

  function showFailure(provider, outputTail) {
    status.classList.remove("hidden");
    spinner.classList.add("hidden");
    statusText.textContent = t("oauth.loginFailed");
    const tail = String(outputTail || "").slice(-OUTPUT_TAIL_CHARS);
    if (tail.trim()) {
      output.textContent = tail;
      output.classList.remove("hidden");
    } else {
      output.classList.add("hidden");
    }
    advice.textContent = t("oauth.terminalHint", { provider });
    advice.classList.remove("hidden");
  }

  function showSuccess() {
    status.classList.remove("hidden");
    spinner.classList.add("hidden");
    statusText.textContent = t("oauth.loginSuccess");
    output.classList.add("hidden");
    advice.classList.add("hidden");
  }

  async function login() {
    if (pending || destroyed) return;
    const provider = input.value.trim();
    if (!PROVIDER_RE.test(provider)) {
      status.classList.remove("hidden");
      spinner.classList.add("hidden");
      statusText.textContent = t("oauth.invalidProvider");
      return;
    }
    pending = true;
    setControlsDisabled(true);
    showPending();
    const result = await wsRpc(
      wsClient,
      { type: "run_omp_login", provider },
      { timeoutMs: requestTimeoutMs },
    );
    if (destroyed) return;
    pending = false;
    setControlsDisabled(false);
    if (result.ok) {
      const exitCode = result.data?.exitCode;
      if (exitCode === undefined || exitCode === 0) {
        showSuccess();
        reloadApiKeys();
        return;
      }
      showFailure(provider, result.data?.output);
      return;
    }
    showFailure(provider, result.error);
  }

  loginBtn.addEventListener("click", () => void login());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void login();
    }
  });

  const unsubscribeLanguage = onLanguageChanged(() => {
    if (pending) {
      statusText.textContent = `${t("oauth.browserHint")} ${t("oauth.pending")}`;
    } else if (!status.classList.contains("hidden") && !statusText.textContent) {
      statusText.textContent = t("oauth.loginFailed");
    }
  });

  return {
    destroy: () => {
      destroyed = true;
      unsubscribeLanguage();
      root.replaceChildren();
    },
  };
}
