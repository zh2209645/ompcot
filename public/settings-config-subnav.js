// Settings → Configuration: sub-page navigation controller.
//
// Owns the pill strip (#settings-config-subnav) and the visibility of the
// Configuration panel's page regions: the static Providers section (auth keys,
// models.yml), the static Models & Reasoning page (models-reasoning.js), the
// shared agent-settings catalog host (one mount, living inside the Other
// page's section, whose groups are filtered per sub-page by agent-settings.js
// — it renders every catalog-backed page, not just Other), the static MCP
// servers page (mcp-manager.js), and the static Advanced section (raw
// config.yml only — no catalog keys).
//
// Behavior:
// - The last-active sub-page persists for the window session; `open()` (called
//   every time the Configuration tab is selected) restores it. Default: Providers.
// - Lazy loading: a page's loaders run once, on its first activation. The
//   catalog is fetched once on the first catalog-backed page visit and shared;
//   page pills for known-empty pages are then hidden (Providers, Models &
//   Reasoning, MCP and Advanced are always present). Before the first
//   successful load the catalog-backed pills all appear as candidates; a
//   failed load keeps them reachable so the inline error + retry stays
//   accessible.
// - Pill labels come from the i18n dictionaries and re-render on language
//   change (the strip is JS-built, so data-i18n attributes cannot reach it).

import { CONFIG_PAGES, isAlwaysPage } from "./agent-settings-pages.js";
import { onLanguageChanged, t } from "./i18n.js";

// Static pages own their entire markup (no shared agent-settings catalog
// mount, no catalog fetch). Advanced is static by design: it hosts only the
// raw config.yml editor — unmapped catalog keys render on the Other page.
const STATIC_PAGES = new Set(["providers", "models", "mcp", "advanced"]);

// Pages whose loader is a live list: re-run on every activation (providers /
// advanced are one-shot editors and load once per window session).
const RELOAD_ON_OPEN = new Set(["models", "mcp"]);

export function createConfigSubnav({ root, catalog, loaders = {} }) {
  const subnavEl = root?.querySelector("#settings-config-subnav") ?? null;
  const bodyEl = root?.querySelector(".settings-config-body") ?? null;
  const pageSections = bodyEl ? Array.from(bodyEl.querySelectorAll(".settings-config-page")) : [];
  const catalogHost = bodyEl?.querySelector("#agent-settings-host") ?? null;
  // The shared catalog mount lives inside the Other page's section but is the
  // render target for every catalog-backed page (appearance … tasks, other),
  // so that section tracks the mount's visibility rather than the active page.
  const catalogMountSection = catalogHost?.closest(".settings-config-page") ?? null;
  // The Other-only help line above the mount reads true nowhere else.
  const otherHelpEl = catalogMountSection?.querySelector("[data-other-help]") ?? null;

  if (!subnavEl || !bodyEl) {
    return { open: () => {}, getPage: () => null, onCatalogPageSet: () => {}, destroy: () => {} };
  }

  let activePage = "providers";
  // Pages whose static loaders have already run this window session.
  const loadedStaticPages = new Set();
  // Catalog fetch state: "unloaded" → "loading" → "known" (rendered) | "failed".
  let catalogState = "unloaded";
  let nonEmptyCatalogPages = new Set();

  const unsubscribeLanguage = onLanguageChanged(() => renderPills());

  function pageVisibleInNav(page) {
    if (isAlwaysPage(page.id)) return true;
    // Before the catalog is known every page is a candidate; once known, only
    // pages that actually have catalog entries stay.
    return catalogState !== "known" || nonEmptyCatalogPages.has(page.id);
  }

  // The catalog host holds the shared agent-settings mount (plus its help
  // text). It is visible on every catalog-backed page until the catalog is
  // known — a loading or failed state must stay readable — and hidden when the
  // page has no catalog entries at all (or on a static page, Advanced
  // included: it owns no catalog keys anymore).
  function catalogHostVisibleFor(pageId) {
    if (STATIC_PAGES.has(pageId)) return false;
    if (catalogState === "known") return nonEmptyCatalogPages.has(pageId);
    return true;
  }

  function renderPills() {
    subnavEl.replaceChildren();
    for (const page of CONFIG_PAGES) {
      if (!pageVisibleInNav(page)) continue;
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "settings-subnav-item";
      if (page.id === activePage) pill.classList.add("active");
      pill.dataset.configPage = page.id;
      pill.setAttribute("role", "tab");
      pill.setAttribute("aria-selected", String(page.id === activePage));
      pill.textContent = t(page.i18nKey);
      pill.addEventListener("click", () => activate(page.id));
      subnavEl.appendChild(pill);
    }
    // Keep the active pill in view when the strip overflows (narrow widths).
    const activePill = subnavEl.querySelector(".settings-subnav-item.active");
    if (typeof activePill?.scrollIntoView === "function") {
      activePill.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  function applyBody() {
    for (const section of pageSections) {
      section.hidden = section.dataset.configPage !== activePage;
    }
    catalog?.setActivePage?.(activePage);
    if (catalogHost) catalogHost.hidden = !catalogHostVisibleFor(activePage);
    // The mount's section renders whichever catalog-backed page is active
    // (not only Other), so it follows the mount; the Other-only help line
    // inside follows the active page instead.
    if (catalogMountSection) {
      catalogMountSection.hidden = catalogHost ? catalogHost.hidden : true;
      if (otherHelpEl) otherHelpEl.hidden = activePage !== "other";
    }
  }

  function runStaticLoaders(pageId) {
    const load = loaders[pageId];
    if (typeof load !== "function") return;
    if (!RELOAD_ON_OPEN.has(pageId)) {
      if (loadedStaticPages.has(pageId)) return;
      loadedStaticPages.add(pageId);
    }
    try {
      // Fire-and-forget: every loader owns its error UI (retry buttons,
      // inline save-status messages).
      void Promise.resolve(load()).catch(() => {});
    } catch {
      // Loader threw synchronously — same story, its own error surface wins.
    }
  }

  function ensureCatalog() {
    if (catalogState !== "unloaded" || typeof catalog?.load !== "function") return;
    catalogState = "loading";
    // The catalog reports its own failure via onCatalogPageSet(null).
    void Promise.resolve(catalog.load()).catch(() => {});
  }

  function ensureLoaded(pageId) {
    if (STATIC_PAGES.has(pageId)) {
      // Static pages never touch the catalog — visiting them must not pay
      // for a fetch the catalog-backed pages would otherwise share. That
      // includes Advanced: only its config.yml loader runs there.
      runStaticLoaders(pageId);
      return;
    }
    ensureCatalog();
  }

  function activate(pageId) {
    let target = CONFIG_PAGES.some((page) => page.id === pageId) ? pageId : "providers";
    if (catalogState === "known" && !isAlwaysPage(target) && !nonEmptyCatalogPages.has(target)) {
      target = "providers";
    }
    activePage = target;
    renderPills();
    applyBody();
    ensureLoaded(activePage);
  }

  /**
   * Called (via app.js wiring) when the agent-settings catalog finishes
   * rendering: `pageIds` is the list of sub-pages that have at least one
   * catalog entry, or null when the load failed (page set unknown).
   */
  function onCatalogPageSet(pageIds) {
    if (Array.isArray(pageIds)) {
      catalogState = "known";
      nonEmptyCatalogPages = new Set(pageIds);
    } else {
      catalogState = "failed";
      nonEmptyCatalogPages = new Set();
    }
    renderPills();
    // The active page may have collapsed (zero catalog entries) — fall back
    // to Providers instead of showing an empty page.
    if (
      catalogState === "known" &&
      !isAlwaysPage(activePage) &&
      !nonEmptyCatalogPages.has(activePage)
    ) {
      activate("providers");
      return;
    }
    applyBody();
  }

  renderPills();
  applyBody();

  return {
    /**
     * Re-selects the last-active sub-page; called whenever Configuration
     * opens. Pass a page id to force a target (e.g. the API-key onboarding
     * deep-link lands on Providers regardless of last-active).
     */
    open: (pageId) => activate(typeof pageId === "string" && pageId ? pageId : activePage),
    getPage: () => activePage,
    onCatalogPageSet,
    destroy: () => unsubscribeLanguage(),
  };
}
