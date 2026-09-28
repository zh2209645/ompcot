import { afterEach, describe, expect, test, vi } from "vitest";
import { cancelHydration, hydrateTranscriptTailFirst } from "./transcript-hydration.js";

function entries(count) {
  return Array.from({ length: count }, (_, i) => ({
    type: "message",
    id: `e${i}`,
    message: { role: "user", content: `m${i}` },
  }));
}

/** A scroller whose metrics are derived from its content, so anchoring is testable. */
function makeContainer({ pxPerChild = 10, clientHeight = 100 } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  Object.defineProperty(container, "scrollHeight", {
    configurable: true,
    get: () => container.children.length * pxPerChild,
  });
  Object.defineProperty(container, "clientHeight", { configurable: true, get: () => clientHeight });
  container.scrollTop = 0;
  return container;
}

/** Renders slices as real elements: order, moves and identity are observable. */
function makeRender(container) {
  const slices = [];
  const render = vi.fn((slice) => {
    slices.push(slice.map((entry) => entry.id));
    for (const entry of slice) {
      const el = document.createElement("div");
      el.dataset.entryId = entry.id;
      el.textContent = entry.message.content;
      container.appendChild(el);
    }
  });
  return { render, slices };
}

const idsInOrder = (container) =>
  Array.from(container.querySelectorAll("[data-entry-id]")).map((el) => el.dataset.entryId);

afterEach(() => {
  cancelHydration();
  document.body.innerHTML = "";
});

describe("hydrateTranscriptTailFirst", () => {
  test("paints the newest slice first, in order, and holds the rest back", async () => {
    const container = makeContainer();
    const { render, slices } = makeRender(container);

    const result = await hydrateTranscriptTailFirst({
      container,
      entries: entries(200),
      render,
      earlierLabel: "Load earlier messages",
      loadingLabel: "Loading earlier messages…",
      sliceSize: 20,
      isViewportFilled: () => true,
    });

    expect(slices).toEqual([Array.from({ length: 20 }, (_, i) => `e${180 + i}`)]);
    expect(result).toEqual({ loaded: 20, total: 200 });
    expect(idsInOrder(container)).toEqual(slices[0]);
    expect(container.querySelector(".earlier-loader")).toBeTruthy();
  });

  test("anchors the tail before any earlier slice is pulled in", async () => {
    const container = makeContainer();
    const { render } = makeRender(container);
    const seen = [];

    await hydrateTranscriptTailFirst({
      container,
      entries: entries(120),
      render,
      sliceSize: 20,
      isViewportFilled: () => true,
      onTailRendered: () => {
        // The app's anchor: the newest entries are already on screen, and the
        // viewport is allowed to move to them before anything is inserted above.
        seen.push(idsInOrder(container).length);
        container.scrollTop = container.scrollHeight;
      },
    });

    expect(seen).toEqual([20]);
    // Bottom of the tail *plus* the row that now sits above it — the anchor is
    // "the content end", whatever the content is.
    expect(container.scrollTop).toBe(container.scrollHeight);
  });

  test("prepends an earlier slice above the tail and gives back its height", async () => {
    const container = makeContainer(); // 10px per child
    const { render, slices } = makeRender(container);

    await hydrateTranscriptTailFirst({
      container,
      entries: entries(60),
      render,
      sliceSize: 20,
      isViewportFilled: () => true,
      onTailRendered: () => {
        container.scrollTop = container.scrollHeight; // 20 entries + row = 210px
      },
    });
    expect(container.scrollTop).toBe(container.scrollHeight);

    // The reader reaches the top: the next earlier slice loads…
    container.scrollTop = 0;
    container.dispatchEvent(new Event("scroll"));

    // …above everything that was on screen (the tail keeps its identity), the
    // row stays first, and the reader's place is exactly where it was (the
    // 200px that were inserted above are given back to `scrollTop`).
    expect(idsInOrder(container)).toEqual([...slices[1], ...slices[0]]);
    expect(container.firstElementChild.className).toBe("earlier-loader");
    expect(container.scrollTop).toBe(200);

    // The row is also the manual affordance; the last slice removes it.
    container.querySelector(".earlier-loader").click();
    expect(idsInOrder(container)).toEqual([...slices[2], ...slices[1], ...slices[0]]);
    expect(container.querySelector(".earlier-loader")).toBe(null);
  });

  test("the row reads as loading while a slice is drawn, then back to idle", async () => {
    const container = makeContainer();
    const labels = [];
    const render = vi.fn((slice) => {
      labels.push(container.querySelector(".earlier-loader-label")?.textContent ?? null);
      for (const entry of slice) {
        const el = document.createElement("div");
        el.dataset.entryId = entry.id;
        container.appendChild(el);
      }
    });

    await hydrateTranscriptTailFirst({
      container,
      entries: entries(60),
      render,
      sliceSize: 20,
      isViewportFilled: () => true,
      earlierLabel: "Load earlier messages",
      loadingLabel: "Loading earlier messages…",
    });

    expect(labels[0]).toBe(null); // the tail's slice runs before the row exists
    container.scrollTop = 0;
    container.dispatchEvent(new Event("scroll"));
    expect(labels[1]).toBe("Loading earlier messages…");
    // 20 entries remain, so the row goes back to its idle text.
    expect(container.querySelector(".earlier-loader-label").textContent).toBe(
      "Load earlier messages",
    );
  });

  test("stops loading when a newer view claims the surface", async () => {
    const container = makeContainer();
    const { render } = makeRender(container);
    let allowed = true;

    await hydrateTranscriptTailFirst({
      container,
      entries: entries(200),
      render,
      sliceSize: 20,
      isViewportFilled: () => true,
      shouldContinue: () => allowed,
    });

    container.scrollTop = 0;
    allowed = false; // another selection / a peek claimed the transcript
    container.dispatchEvent(new Event("scroll"));

    expect(idsInOrder(container).length).toBe(20);
    expect(render).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".earlier-loader")).toBe(null);
  });

  test("a new hydration disposes the previous one and its row", async () => {
    const first = makeContainer();
    const second = makeContainer();
    const a = makeRender(first);
    const b = makeRender(second);

    await hydrateTranscriptTailFirst({
      container: first,
      entries: entries(200),
      render: a.render,
      sliceSize: 20,
      isViewportFilled: () => true,
    });
    expect(first.querySelector(".earlier-loader")).toBeTruthy();

    await hydrateTranscriptTailFirst({
      container: second,
      entries: entries(40),
      render: b.render,
      sliceSize: 20,
      isViewportFilled: () => true,
    });

    expect(first.querySelector(".earlier-loader")).toBe(null);
    first.scrollTop = 0;
    first.dispatchEvent(new Event("scroll"));
    expect(a.render).toHaveBeenCalledTimes(1);
    expect(b.render).toHaveBeenCalledTimes(1);
  });

  test("keeps pulling earlier slices until the viewport is covered", async () => {
    const container = makeContainer();
    const { render } = makeRender(container);

    // "Covered" only once the whole session is drawn: a tail of four short
    // entries leaves nothing to scroll, so no scroll event could ever ask for
    // the rest.
    const result = await hydrateTranscriptTailFirst({
      container,
      entries: entries(10),
      render,
      sliceSize: 4,
      isViewportFilled: () => idsInOrder(container).length >= 10,
      yieldTo: async () => {},
    });

    expect(result).toEqual({ loaded: 10, total: 10 });
    expect(idsInOrder(container)).toEqual(Array.from({ length: 10 }, (_, i) => `e${i}`));
    expect(container.querySelector(".earlier-loader")).toBe(null);
  });

  test("a container with no measurable box does not spin the fill loop", async () => {
    const container = makeContainer({ clientHeight: 0 });
    const { render } = makeRender(container);

    const result = await hydrateTranscriptTailFirst({
      container,
      entries: entries(200),
      render,
      sliceSize: 20,
    });

    expect(result.loaded).toBe(20); // headless: the tail alone is the paint
  });

  test("a slice that throws stops the hydration instead of wedging its row", async () => {
    const container = makeContainer();
    const render = vi.fn(() => {
      throw new Error("unrenderable entry");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await hydrateTranscriptTailFirst({
      container,
      entries: entries(40),
      render,
      sliceSize: 20,
      isViewportFilled: () => true,
    });

    expect(result.loaded).toBe(0);
    expect(container.querySelector(".earlier-loader")).toBe(null);
    errorSpy.mockRestore();
  });

  test("an empty session renders nothing and mounts no row", async () => {
    const container = makeContainer();
    const { render } = makeRender(container);

    await expect(hydrateTranscriptTailFirst({ container, entries: [], render })).resolves.toEqual({
      loaded: 0,
      total: 0,
    });
    expect(render).not.toHaveBeenCalled();
    expect(container.children.length).toBe(0);
  });
});
