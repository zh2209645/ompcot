import { describe, expect, it, vi } from "vitest";
import { createCommandOutputView, stripAnsi } from "./command-output.js";

const ESC = String.fromCharCode(27);

describe("stripAnsi", () => {
  it("removes SGR styling but keeps the text", () => {
    const raw = `${ESC}[1m${ESC}[38;5;39m░░░░░${ESC}[22m${ESC}[39m 0%  2477 tokens`;
    expect(stripAnsi(raw)).toBe("░░░░░ 0%  2477 tokens");
  });

  it("removes cursor and OSC sequences", () => {
    expect(stripAnsi(`${ESC}[2K${ESC}[1Gdone${ESC}]0;title${String.fromCharCode(7)}`)).toBe("done");
  });

  it("passes plain text through unchanged", () => {
    expect(stripAnsi("No background jobs running.")).toBe("No background jobs running.");
  });
});

describe("createCommandOutputView", () => {
  it("renders the report text as an id-keyed block", () => {
    const renderCommandOutput = vi.fn();
    const view = createCommandOutputView({ messageRenderer: { renderCommandOutput } });

    view.handle({ type: "command_output", text: "Context window: 1000000 tokens" });
    view.handle({ type: "command_output", text: "No background jobs running." });

    expect(renderCommandOutput).toHaveBeenCalledTimes(2);
    expect(renderCommandOutput.mock.calls[0][0]).toBe("Context window: 1000000 tokens");
    expect(renderCommandOutput.mock.calls[0][1].id).toBe("cmdout-1");
    expect(renderCommandOutput.mock.calls[1][1].id).toBe("cmdout-2");
  });

  it("strips terminal styling before drawing", () => {
    const renderCommandOutput = vi.fn();
    const view = createCommandOutputView({ messageRenderer: { renderCommandOutput } });
    view.handle({ type: "command_output", text: `${ESC}[32mok${ESC}[39m` });
    expect(renderCommandOutput).toHaveBeenCalledWith("ok", expect.anything());
  });

  it("skips blank and whitespace-only reports", () => {
    const renderCommandOutput = vi.fn();
    const view = createCommandOutputView({ messageRenderer: { renderCommandOutput } });
    view.handle({ type: "command_output", text: "   \n" });
    view.handle({ type: "command_output", text: "" });
    view.handle({});
    expect(renderCommandOutput).not.toHaveBeenCalled();
  });

  it("draws nothing while the app suppresses reports", () => {
    // A peeked transcript owns the surface, and an active compaction draws
    // its own outcome line — the raw text would double-report the result.
    const renderCommandOutput = vi.fn();
    const view = createCommandOutputView({
      messageRenderer: { renderCommandOutput },
      isSuppressed: () => true,
    });
    view.handle({ type: "command_output", text: "Compaction complete. Tokens: 1 -> 1" });
    expect(renderCommandOutput).not.toHaveBeenCalled();
  });
});
