/**
 * Package registry client — data source for Settings → Extensions browse.
 *
 * The registry is an external service (default: the pi-packages-api
 * Cloudflare Worker). It can be down, blocked, or replaced by a mirror, so
 * the base URL is user-configurable and every successful fetch is mirrored
 * into sessionStorage as an offline fallback.
 *
 * Storage note: the configured base is persisted in a cookie (not
 * localStorage) because Ompcot serves each workspace window from
 * `http://localhost:<port>` and localStorage is partitioned per origin —
 * `localhost:3001` and `localhost:3002` would each see a different value,
 * so every new workspace window would forget the override. Cookies on
 * localhost are shared across ports, so one cookie is visible to every
 * workspace window. (Same rationale as `ompcot-theme`/`ompcot-lang`.)
 *
 * This module has no import-time side effects; the cookie is only read
 * inside the exported functions.
 */

export const DEFAULT_REGISTRY_BASE = "https://pi-packages-aomp.shixin.workers.dev";

const REGISTRY_COOKIE = "ompcot-pkg-registry";
const REGISTRY_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10; // 10 years
const CACHE_KEY = "ompcot-pkg-cache";
const FETCH_TIMEOUT_MS = 12_000;
// Defensive cap: a broken registry echoing a huge totalPages would otherwise
// loop fetches forever. 40 pages × 250 rows is far beyond any real catalog.
const MAX_PAGES = 40;
export const REGISTRY_UNREACHABLE_KEY = "pkg.registryUnreachable";

// ── cookie persistence (same pattern as i18n.js / themes.js) ──

function readRegistryCookie() {
  try {
    const cookies = document.cookie ? document.cookie.split("; ") : [];
    for (const entry of cookies) {
      const eq = entry.indexOf("=");
      if (eq === -1) continue;
      const name = entry.slice(0, eq);
      if (name !== REGISTRY_COOKIE) continue;
      const raw = entry.slice(eq + 1);
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  } catch {
    // document.cookie can throw in sandboxed contexts; treat as missing.
  }
  return null;
}

function writeRegistryCookie(origin) {
  try {
    const value = encodeURIComponent(origin);
    // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API is async; sync persistence matches ompcot-theme/ompcot-lang
    document.cookie = `${REGISTRY_COOKIE}=${value}; Max-Age=${REGISTRY_COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`;
  } catch {
    // ignore — same fallback as the read path
  }
}

function deleteRegistryCookie() {
  try {
    // biome-ignore lint/suspicious/noDocumentCookie: test-visible reset; mirrors the write path
    document.cookie = `${REGISTRY_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
  } catch {
    // ignore
  }
}

// ── base URL validation ──

/**
 * Validates a registry base URL: must be an http(s) URL without a path,
 * query, fragment, or credentials. Returns the normalized origin
 * (e.g. "https://example.com", port preserved) or null when invalid.
 * A trailing "/" is accepted and normalized away.
 */
export function validateRegistryBase(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;
  return url.origin;
}

/** The configured registry origin (validated cookie value → default). */
export function getRegistryBase() {
  return validateRegistryBase(readRegistryCookie()) || DEFAULT_REGISTRY_BASE;
}

/**
 * Persists a new registry base. Returns the stored origin, or null when the
 * input is invalid (nothing is written). Also drops the offline cache so a
 * later fetch can never fall back to data from the previous registry.
 */
export function setRegistryBase(url) {
  const origin = validateRegistryBase(url);
  if (!origin) return null;
  writeRegistryCookie(origin);
  clearPackageCache();
  return origin;
}

/**
 * Clears the override and returns to the default registry. Also drops the
 * offline cache (same stale-fallback rationale as setRegistryBase).
 */
export function resetRegistryBase() {
  deleteRegistryCookie();
  clearPackageCache();
  return DEFAULT_REGISTRY_BASE;
}

// ── offline cache (best-effort sessionStorage) ──

function readCachedPackages() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.packages) ? parsed.packages : null;
  } catch {
    return null;
  }
}

function writeCachedPackages(packages) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), packages }));
  } catch {
    // best-effort only — quota exceeded or storage disabled
  }
}

/** Drops the offline fallback cache. Never throws. */
export function clearPackageCache() {
  try {
    sessionStorage.removeItem(CACHE_KEY);
  } catch {
    // sessionStorage may be unavailable; nothing to clear
  }
}

// ── fetching ──

function normalizePackage(pkg) {
  const raw = pkg && typeof pkg === "object" ? pkg : {};
  const downloads = Number(raw.downloads);
  return {
    name: typeof raw.name === "string" ? raw.name : "",
    description: typeof raw.description === "string" ? raw.description : "",
    author: typeof raw.author === "string" ? raw.author : "",
    types: Array.isArray(raw.types) ? raw.types.filter((t) => typeof t === "string") : [],
    downloads: Number.isFinite(downloads) ? Math.max(0, downloads) : 0,
    links: raw.links && typeof raw.links === "object" ? raw.links : {},
    updatedAt: raw.updatedAt ?? raw.updated ?? raw.modified ?? raw.date ?? raw.time ?? 0,
  };
}

function describeError(err) {
  if (err?.name === "AbortError") return "timeout";
  const message = String(err?.message || err || "").trim();
  return message || "network error";
}

async function fetchRegistryPage(base, page, pageSize) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(`${base}/packages?page=${page}&pageSize=${pageSize}`, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches the package catalog from `${base}/packages?page=&pageSize=`,
 * following the registry's `totalPages` until the whole catalog is
 * collected (same query shape the browse UI always used).
 *
 * Returns `{ok: true, packages, cached: false}` on success — `packages`
 * is the normalized, de-paginated list, mirrored into sessionStorage for
 * offline fallback. On failure: `{ok: true, packages, cached: true}` when a
 * previous successful fetch is cached, otherwise `{ok: false, error}` where
 * `error` is an i18n key (never a raw "Failed to fetch") and `detail`
 * carries the underlying reason for logging.
 */
export async function fetchPackages({ page = 1, pageSize = 250 } = {}) {
  const base = getRegistryBase();
  const collected = [];
  let current = page;
  let totalPages = 1;
  try {
    do {
      const res = await fetchRegistryPage(base, current, pageSize);
      if (!res?.ok) throw new Error(`Registry returned ${res?.status ?? "error"}`);
      const data = await res.json();
      if (Array.isArray(data?.packages)) collected.push(...data.packages);
      totalPages = Number(data?.totalPages) || 1;
      current += 1;
    } while (current <= totalPages && current < page + MAX_PAGES);
  } catch (err) {
    const cached = readCachedPackages();
    if (cached) return { ok: true, packages: cached, cached: true };
    return { ok: false, error: REGISTRY_UNREACHABLE_KEY, detail: describeError(err) };
  }
  const packages = collected.map(normalizePackage).filter((pkg) => pkg.name);
  writeCachedPackages(packages);
  return { ok: true, packages, cached: false };
}
