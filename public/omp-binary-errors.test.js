import { describe, expect, test } from "vitest";
import { appendOmpBinaryHint, isOmpBinaryNotFoundError } from "./omp-binary-errors.js";

describe("omp binary error helpers", () => {
  test("detects the Rust not-found error prefix", () => {
    expect(isOmpBinaryNotFoundError("Could not find omp binary in bundle")).toBe(true);
    expect(isOmpBinaryNotFoundError(new Error("Could not find omp binary on PATH"))).toBe(true);
    expect(isOmpBinaryNotFoundError("No omp instance on port 47821")).toBe(false);
    expect(isOmpBinaryNotFoundError("Failed to attach: boom")).toBe(false);
    expect(isOmpBinaryNotFoundError(null)).toBe(false);
  });

  test("appends the Settings hint only to not-found errors", () => {
    expect(appendOmpBinaryHint("Could not find omp binary in bundle")).toBe(
      "Could not find omp binary in bundle — set the omp binary path in Settings",
    );
    expect(appendOmpBinaryHint("Failed to start new session: boom")).toBe(
      "Failed to start new session: boom",
    );
  });

  test("does not duplicate an already-appended hint", () => {
    const once = appendOmpBinaryHint("Could not find omp binary in bundle");
    expect(appendOmpBinaryHint(once)).toBe(once);
  });
});
