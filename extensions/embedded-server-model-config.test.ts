// @vitest-environment node

// Unit coverage for the `omp config list --json` read fallback that backs
// `get_model_configuration` when the in-process Settings instance is
// unreachable (extension context still initializing on first page load).
// The end-to-end "no instance → fallback" path needs a live omp runtime and
// is exercised by the real-environment headless smoke; what is unit-testable
// is the catalog parser itself (exported for exactly that purpose).
import { describe, expect, it } from "vitest";
import { extractModelConfigCliValues } from "./embedded-server.ts";

describe("extractModelConfigCliValues", () => {
  it("mines the model/reasoning keys out of a CLI catalog", () => {
    const values = extractModelConfigCliValues({
      defaultModel: { value: "claude-opus-4-20250514", type: "string" },
      modelRoles: {
        value: { default: "claude-opus-4-20250514", advisor: "gpt-5" },
        type: "object",
      },
      cycleOrder: { value: ["default", "slow"], type: "array" },
      modelTags: { value: { fast: ["default"] }, type: "object" },
      defaultThinkingLevel: { value: "high", type: "string" },
      apiKey: { type: "string", redacted: true }, // unrelated keys ignored
    });
    expect(values).toEqual({
      modelRoles: { default: "claude-opus-4-20250514", advisor: "gpt-5" },
      cycleOrder: ["default", "slow"],
      modelTags: { fast: ["default"] },
      defaultThinkingLevel: "high",
    });
  });

  it("degrades missing or unusable keys to null fields instead of throwing", () => {
    expect(extractModelConfigCliValues({})).toEqual({
      modelRoles: null,
      cycleOrder: null,
      modelTags: null,
      defaultThinkingLevel: null,
    });
    // Wrong entry shapes must not crash the fallback.
    expect(extractModelConfigCliValues({ modelRoles: "junk", cycleOrder: 3 })).toEqual({
      modelRoles: null,
      cycleOrder: null,
      modelTags: null,
      defaultThinkingLevel: null,
    });
    // Unset values (key present, value absent) are null, not undefined.
    expect(extractModelConfigCliValues({ defaultThinkingLevel: { type: "string" } })).toEqual({
      modelRoles: null,
      cycleOrder: null,
      modelTags: null,
      defaultThinkingLevel: null,
    });
  });

  it("rejects non-object catalogs wholesale", () => {
    expect(extractModelConfigCliValues(null)).toBeNull();
    expect(extractModelConfigCliValues("nope")).toBeNull();
    expect(extractModelConfigCliValues([{ key: "modelRoles" }])).toBeNull();
  });
});
