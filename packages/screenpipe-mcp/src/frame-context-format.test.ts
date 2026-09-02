// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it } from "vitest";
import { formatFrameContext } from "./frame-context-format";

describe("frame-context formatter", () => {
  it("separates authoritative active-window metadata from surrounding tab text", () => {
    const output = formatFrameContext({
      frame_id: 42,
      timestamp: "2026-09-01T18:42:00Z",
      app_name: "Arc",
      window_name: "screenpipe issues",
      browser_url: "https://github.com/screenpipe/screenpipe/issues",
      focused: true,
      text_source: "accessibility",
      text: "Calendar pinned tab  screenpipe issues",
      nodes: [{ role: "AXTab", text: "Calendar", depth: 1 }],
      urls: [],
    });

    expect(output).toContain("Timestamp: 2026-09-01T18:42:00Z");
    expect(output).toContain("App: Arc");
    expect(output).toContain("Window: screenpipe issues");
    expect(output).toContain(
      "Browser URL: https://github.com/screenpipe/screenpipe/issues",
    );
    expect(output).toContain("Focused: true");
    expect(output).toContain("[AXTab] Calendar");
  });

  it("does not turn missing legacy focus metadata into false", () => {
    const output = formatFrameContext({
      frame_id: 7,
      text_source: "ocr",
    });

    expect(output).toContain("Timestamp: unknown");
    expect(output).toContain("App: unknown");
    expect(output).toContain("Focused: unknown");
  });
});
