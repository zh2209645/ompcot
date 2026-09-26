import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearPackageCache,
  DEFAULT_REGISTRY_BASE,
  fetchPackages,
  getRegistryBase,
  REGISTRY_UNREACHABLE_KEY,
  resetRegistryBase,
  setRegistryBase,
  validateRegistryBase,
} from "./pkg-registry.js";

const CACHE_KEY = "ompcot-pkg-cache";

function clearRegistryCookie() {
  // biome-ignore lint/suspicious/noDocumentCookie: test fixture — Cookie Store API is async and unnecessary in tests
  document.cookie = "ompcot-pkg-registry=; Max-Age=0; Path=/; SameSite=Lax";
}

function jsonResponse(body) {
  return { ok: true, json: async () => body };
}

beforeEach(() => {
  clearRegistryCookie();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("registry base persistence", () => {
  test("defaults to the pi-packages worker origin when no cookie is set", () => {
    expect(getRegistryBase()).toBe(DEFAULT_REGISTRY_BASE);
    expect(DEFAULT_REGISTRY_BASE).toBe("https://pi-packages-aomp.shixin.workers.dev");
  });

  test("setRegistryBase stores the origin and getRegistryBase reads it back", () => {
    expect(setRegistryBase("https://pkgs.example.com/")).toBe("https://pkgs.example.com");
    expect(getRegistryBase()).toBe("https://pkgs.example.com");
    // URI-encoded, cross-port cookie (same scheme as ompcot-lang/ompcot-theme)
    expect(document.cookie).toContain("ompcot-pkg-registry=https%3A%2F%2Fpkgs.example.com");
  });

  test("keeps an explicit port and accepts http (local mirrors)", () => {
    expect(setRegistryBase("http://localhost:8787")).toBe("http://localhost:8787");
    expect(getRegistryBase()).toBe("http://localhost:8787");
  });

  test.each([
    "not a url",
    "ftp://example.com",
    "https://example.com/packages",
    "https://example.com/?q=1",
    "https://example.com#frag",
    "https://user:pass@example.com",
    "",
    "   ",
  ])("rejects invalid base %j without writing the cookie", (input) => {
    expect(validateRegistryBase(input)).toBeNull();
    expect(setRegistryBase(input)).toBeNull();
    expect(getRegistryBase()).toBe(DEFAULT_REGISTRY_BASE);
    expect(document.cookie).not.toContain("ompcot-pkg-registry=");
  });

  test("a corrupted cookie value falls back to the default", () => {
    // biome-ignore lint/suspicious/noDocumentCookie: test fixture — Cookie Store API is async and unnecessary in tests
    document.cookie = "ompcot-pkg-registry=not%20a%20url; Max-Age=3600; Path=/; SameSite=Lax";
    expect(getRegistryBase()).toBe(DEFAULT_REGISTRY_BASE);
  });

  test("resetRegistryBase clears the override and the cache", async () => {
    setRegistryBase("https://pkgs.example.com");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ packages: [{ name: "a" }], totalPages: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchPackages();
    expect(sessionStorage.getItem(CACHE_KEY)).toBeTruthy();

    expect(resetRegistryBase()).toBe(DEFAULT_REGISTRY_BASE);
    expect(getRegistryBase()).toBe(DEFAULT_REGISTRY_BASE);
    expect(sessionStorage.getItem(CACHE_KEY)).toBeNull();
  });

  test("setRegistryBase drops a previously cached catalog", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ packages: [{ name: "a" }], totalPages: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchPackages();
    expect(sessionStorage.getItem(CACHE_KEY)).toBeTruthy();

    setRegistryBase("https://mirror.example.com");
    expect(sessionStorage.getItem(CACHE_KEY)).toBeNull();
  });
});

describe("fetchPackages", () => {
  test("fetches the configured base with the page/pageSize query shape", async () => {
    setRegistryBase("https://pkgs.example.com");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ packages: [{ name: "a" }], totalPages: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPackages({ page: 1, pageSize: 250 });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://pkgs.example.com/packages?page=1&pageSize=250",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toEqual({
      ok: true,
      packages: [expect.objectContaining({ name: "a" })],
      cached: false,
    });
  });

  test("normalizes entries and caches the merged list", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          packages: [
            {
              name: "@scope/pkg-a",
              description: 42,
              types: "extension",
              downloads: "120",
              links: null,
            },
            { description: "no name — dropped" },
          ],
          totalPages: 2,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ packages: [{ name: "pkg-b", types: ["skill", 7], downloads: 3 }] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPackages();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://pi-packages-aomp.shixin.workers.dev/packages?page=2&pageSize=250",
      expect.anything(),
    );
    expect(result.ok).toBe(true);
    expect(result.cached).toBe(false);
    expect(result.packages).toEqual([
      {
        name: "@scope/pkg-a",
        description: "",
        author: "",
        types: [],
        downloads: 120,
        links: {},
        updatedAt: 0,
      },
      {
        name: "pkg-b",
        description: "",
        author: "",
        types: ["skill"],
        downloads: 3,
        links: {},
        updatedAt: 0,
      },
    ]);

    const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY));
    expect(cached.packages).toHaveLength(2);
  });

  test("falls back to the cached catalog with cached:true on failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ packages: [{ name: "cached-pkg" }], totalPages: 1 }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    await fetchPackages(); // prime the cache

    const result = await fetchPackages(); // network now dead

    expect(result.ok).toBe(true);
    expect(result.cached).toBe(true);
    expect(result.packages).toEqual([expect.objectContaining({ name: "cached-pkg" })]);
  });

  test("returns ok:false with a localized error key when no cache exists", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    const result = await fetchPackages();

    expect(result.ok).toBe(false);
    expect(result.error).toBe(REGISTRY_UNREACHABLE_KEY);
    expect(REGISTRY_UNREACHABLE_KEY).toBe("pkg.registryUnreachable");
    expect(String(result.error)).not.toContain("Failed to fetch");
  });

  test("treats an HTTP error status as a failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const result = await fetchPackages();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("404");
  });

  test("aborts after 12s and reports ok:false", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );

    const promise = fetchPackages();
    await vi.advanceTimersByTimeAsync(12_000);
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.detail).toBe("timeout");
  });

  test("never breaks when sessionStorage is unavailable", async () => {
    // Make every sessionStorage access throw (storage disabled by policy).
    const proto = Object.getPrototypeOf(window);
    const owner = Object.hasOwn(window, "sessionStorage") ? window : proto;
    const descriptor = Object.getOwnPropertyDescriptor(owner, "sessionStorage");
    Object.defineProperty(owner, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("Storage disabled");
      },
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ packages: [{ name: "a" }], totalPages: 1 }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const success = await fetchPackages();
      expect(success).toEqual({
        ok: true,
        packages: [expect.objectContaining({ name: "a" })],
        cached: false,
      });

      const failure = await fetchPackages();
      expect(failure.ok).toBe(false);
      expect(failure.error).toBe(REGISTRY_UNREACHABLE_KEY);
    } finally {
      Object.defineProperty(owner, "sessionStorage", descriptor);
    }
  });

  test("clearPackageCache is safe when storage throws", () => {
    const proto = Object.getPrototypeOf(window);
    const owner = Object.hasOwn(window, "sessionStorage") ? window : proto;
    const descriptor = Object.getOwnPropertyDescriptor(owner, "sessionStorage");
    Object.defineProperty(owner, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("Storage disabled");
      },
    });
    try {
      expect(() => clearPackageCache()).not.toThrow();
    } finally {
      Object.defineProperty(owner, "sessionStorage", descriptor);
    }
  });
});
