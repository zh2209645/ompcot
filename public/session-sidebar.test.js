import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readStoredJsonArray, SessionSidebar } from "./session-sidebar.js";

function makeSidebar() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return new SessionSidebar(container, vi.fn(), vi.fn());
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("readStoredJsonArray", () => {
  test("returns the stored array for valid JSON", () => {
    localStorage.setItem("ompcot-favourites", JSON.stringify(["/a.jsonl", "/b.jsonl"]));
    expect(readStoredJsonArray("ompcot-favourites")).toEqual(["/a.jsonl", "/b.jsonl"]);
  });

  test("falls back to [] for corrupt JSON", () => {
    localStorage.setItem("ompcot-favourites", "{not json");
    expect(readStoredJsonArray("ompcot-favourites")).toEqual([]);
  });

  test("falls back to [] for non-array JSON values", () => {
    localStorage.setItem("ompcot-archived", JSON.stringify({ nope: true }));
    expect(readStoredJsonArray("ompcot-archived")).toEqual([]);
  });

  test("falls back to [] when storage access throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("The operation is insecure.");
    });
    expect(readStoredJsonArray("ompcot-unread")).toEqual([]);
  });

  test("returns [] for missing keys", () => {
    expect(readStoredJsonArray("ompcot-missing")).toEqual([]);
  });
});

describe("SessionSidebar guarded localStorage construction", () => {
  test("corrupt favourites/archived/unread values do not prevent construction", () => {
    localStorage.setItem("ompcot-favourites", "{not json");
    localStorage.setItem("ompcot-archived", '["unterminated');
    localStorage.setItem("ompcot-unread", "%E0%A4%A");

    const sidebar = makeSidebar();

    expect(sidebar.favourites).toEqual([]);
    expect(sidebar.archived).toEqual([]);
    expect(sidebar.unread).toEqual(new Set());
  });

  test("unusable localStorage does not prevent construction", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("The operation is insecure.");
    });

    const sidebar = makeSidebar();

    expect(sidebar.favourites).toEqual([]);
    expect(sidebar.archived).toEqual([]);
    expect(sidebar.unread).toEqual(new Set());
    expect(sidebar.archivedCollapsed).toBe(true);
  });

  test("valid stored values still load", () => {
    localStorage.setItem("ompcot-favourites", JSON.stringify(["/a.jsonl"]));
    localStorage.setItem("ompcot-archived", JSON.stringify(["/b.jsonl"]));
    localStorage.setItem("ompcot-unread", JSON.stringify(["/c.jsonl"]));

    const sidebar = makeSidebar();

    expect(sidebar.favourites).toEqual(["/a.jsonl"]);
    expect(sidebar.archived).toEqual(["/b.jsonl"]);
    expect(sidebar.unread.has("/c.jsonl")).toBe(true);
  });
});
