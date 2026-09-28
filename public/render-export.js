/**
 * Export the live rendered page (not the session).
 *
 * The session export renders the *transcript* from the session file, so it can
 * never show a rendering bug: what the user is looking at is the live DOM — the
 * classes the renderers set (`streaming`, `finalized`, a pill stuck on
 * `pending`), the elements they drew (including a duplicate or a missing one),
 * the inline theme/font variables on `<html>`, the composer's state. This module
 * turns that into one standalone file:
 *
 *   - the live document, cloned (the page itself is never touched),
 *   - the app's stylesheets inlined *in place* so the cascade order survives,
 *   - every `<script>` removed — the artifact is a picture of the DOM, not a
 *     program that tries to boot the app over `file://`,
 *   - same-origin images turned into data URLs when they are small enough, so
 *     the file opens anywhere,
 *   - a capture-metadata comment (viewport, transcript census, scroll offsets,
 *     app state) and a two-line inline script that restores the transcript's
 *     scroll position, because "it looked wrong" is usually about where the
 *     viewport sat.
 */

/** Same-origin images larger than this stay as URLs (the page still renders). */
const IMAGE_INLINE_LIMIT_BYTES = 256 * 1024;

/** A comment cannot contain `--` (nor end with `-`), so sanitize the values. */
function escapeComment(text) {
  return String(text).replace(/--+/g, "- -").replace(/-$/, "- ");
}

function toBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * @param {Document} doc the live document
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] injectable for tests
 * @param {object} [options.meta] extra metadata for the header comment
 * @param {number} [options.imageLimitBytes]
 * @param {boolean} [options.restoreScroll] embed the scroll-restoring snippet
 * @returns {Promise<{html: string, bytes: number, stats: object}>}
 */
export async function buildRenderDump(doc, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    meta = {},
    imageLimitBytes = IMAGE_INLINE_LIMIT_BYTES,
    restoreScroll = true,
  } = options;
  if (!doc?.documentElement) throw new Error("buildRenderDump needs a document");

  const root = doc.documentElement.cloneNode(true);
  const baseHref = doc.baseURI || doc.location?.href || "";
  const origin = (() => {
    try {
      return new URL(baseHref).origin;
    } catch {
      return null;
    }
  })();
  const resolve = (href) => {
    try {
      return new URL(href, baseHref).href;
    } catch {
      return href;
    }
  };

  const stats = {
    scripts: 0,
    stylesheets: 0,
    stylesheetFailures: [],
    images: 0,
    imageFailures: 0,
  };

  for (const el of root.querySelectorAll("script")) {
    el.remove();
    stats.scripts += 1;
  }
  for (const el of root.querySelectorAll(
    'link[rel="preload"], link[rel="modulepreload"], link[rel="prefetch"]',
  )) {
    el.remove();
  }

  if (typeof fetchImpl === "function") {
    // In place, so `style-theme.css` still precedes `style.css`.
    for (const link of Array.from(root.querySelectorAll('link[rel="stylesheet"]'))) {
      const href = resolve(link.getAttribute("href") || "");
      try {
        const res = await fetchImpl(href);
        if (!res || res.ok === false) throw new Error(`HTTP ${res?.status ?? "?"}`);
        const style = doc.createElement("style");
        style.setAttribute("data-ompcot-href", href);
        style.textContent = await res.text();
        link.replaceWith(style);
        stats.stylesheets += 1;
      } catch (err) {
        stats.stylesheetFailures.push(`${href}: ${err?.message ?? String(err)}`);
      }
    }

    for (const img of Array.from(root.querySelectorAll("img[src]"))) {
      const raw = img.getAttribute("src") || "";
      if (!raw || raw.startsWith("data:")) continue;
      const url = resolve(raw);
      if (!/^https?:/i.test(url)) continue;
      if (origin && new URL(url).origin !== origin) continue;
      try {
        const res = await fetchImpl(url);
        if (!res || res.ok === false) throw new Error(`HTTP ${res?.status ?? "?"}`);
        const buffer = new Uint8Array(await res.arrayBuffer());
        if (buffer.byteLength > imageLimitBytes) continue;
        const type = res.headers?.get?.("content-type") || "image/svg+xml";
        img.setAttribute("src", `data:${type};base64,${toBase64(buffer)}`);
        stats.images += 1;
      } catch {
        stats.imageFailures += 1;
      }
    }
  }

  // Geometry comes from the *live* node: `cloneNode` copies attributes, not the
  // element's DOM properties, so the clone's `scrollTop` is 0 by definition.
  const messages = doc.querySelector("#messages");
  const scroll = messages
    ? {
        top: Math.round(messages.scrollTop || 0),
        height: Math.round(messages.scrollHeight || 0),
        viewport: Math.round(messages.clientHeight || 0),
      }
    : null;
  if (messages && scroll) {
    root.setAttribute("data-ompcot-scroll-top", String(scroll.top));
  }

  const census = {
    messages: messages ? messages.querySelectorAll(":scope > .message").length : 0,
    assistant: messages ? messages.querySelectorAll(":scope > .message.assistant").length : 0,
    user: messages ? messages.querySelectorAll(":scope > .message.user").length : 0,
    finalized: messages
      ? messages.querySelectorAll(':scope > .message.assistant[data-finalized="true"]').length
      : 0,
  };

  const view = doc.defaultView || globalThis;
  const lines = [
    "ompcot rendered page — the window's live DOM, stylesheets inlined",
    `capturedAt: ${new Date().toISOString()}`,
    `url: ${doc.location?.href ?? "(unknown)"}`,
    `viewport: ${view?.innerWidth ?? "?"}x${view?.innerHeight ?? "?"} @${view?.devicePixelRatio ?? 1}`,
    `transcript: ${census.messages} messages (assistant ${census.assistant}, finalized ${census.finalized}, user ${census.user})`,
    scroll
      ? `scroll: top ${scroll.top} of ${scroll.height - scroll.viewport} (viewport ${scroll.viewport})`
      : null,
    ...Object.entries(meta ?? {}).map(
      ([key, value]) => `${key}: ${value === null ? "(none)" : String(value)}`,
    ),
  ].filter(Boolean);

  if (restoreScroll && scroll && scroll.top > 0) {
    const script = doc.createElement("script");
    script.textContent =
      `addEventListener("DOMContentLoaded",()=>{const m=document.querySelector("#messages");` +
      `if(m){m.style.scrollBehavior="auto";m.scrollTop=${scroll.top};}});`;
    (root.querySelector("head") ?? root).append(script);
  }

  const html = `<!DOCTYPE html>\n<!--\n  ${lines.map(escapeComment).join("\n  ")}\n-->\n${root.outerHTML}\n`;
  return { html, bytes: html.length, stats, census, scroll };
}
