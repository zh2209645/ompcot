//
// Renders omp's `command_output` frames — the report text of slash commands
// (`/context`, `/jobs`, `/mcp list`, …). Since omp 18.5.0 those reports are
// never added to the session transcript, so the native RPC lane relays the
// frames (`interesting_rpc_frame` in src-tauri) and this module turns them
// into notice blocks on the transcript. Reports carry terminal ANSI styling
// (`/context`'s usage bars), which is stripped before drawing.
//

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
// Built via RegExp(), not literals: biome forbids control characters in
// regex literals and these patterns are escape sequences by definition.
const ANSI_OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");
const ANSI_CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const ANSI_OTHER = new RegExp(`${ESC}[@-_]`, "g");

/** Remove terminal escape sequences from a report so the text renders clean. */
export function stripAnsi(text) {
  return String(text ?? "")
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(ANSI_OTHER, "");
}

/**
 * Build the report renderer.
 *
 * @param {{
 *   messageRenderer: {renderCommandOutput(text: string, opts?: {id?: string}): unknown},
 *   isSuppressed?: () => boolean,
 * }} deps
 *   `isSuppressed` carries the app-level guards: a peeked transcript owns
 *   `#messages` (a report must not pollute an agent's history view) and an
 *   active compaction draws its own outcome line from the pass's frames, so
 *   its raw `command_output` text would double-report the same result.
 * @returns {{handle(detail: {text?: unknown}): void}}
 */
export function createCommandOutputView({ messageRenderer, isSuppressed = () => false }) {
  let seq = 0;
  return {
    handle(detail) {
      if (isSuppressed()) return;
      const text = stripAnsi(detail?.text ?? "");
      if (!text.trim()) return;
      seq += 1;
      // Id-keyed like a notice so a re-delivered frame cannot double-draw.
      messageRenderer.renderCommandOutput(text, { id: `cmdout-${seq}` });
    },
  };
}
