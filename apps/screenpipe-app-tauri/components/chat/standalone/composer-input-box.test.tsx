// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React, { createRef } from "react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerInputBox } from "./composer-input-box";
import type { ComposerInputProps, ComposerMentionsProps } from "./composer-types";

const LINE_HEIGHT = 22;
const PADDING = 16;
const MAX_HEIGHT = 208;

const mentions = {
  show: false,
  suggestions: [],
  dropdownRef: createRef(),
  selectedIndex: 0,
  onInsertMention: vi.fn(),
  isLoadingSpeakers: false,
  isLoadingTagSearch: false,
} as unknown as ComposerMentionsProps;

function composer(
  value: string,
  { chip = false, chipWidth = 0, placeholder }: { chip?: boolean; chipWidth?: number; placeholder?: string } = {},
) {
  const input = {
    value,
    placeholder,
    inputRef: createRef(),
    chipPrefixRef: createRef(),
    connectionChip: chip ? { id: "slack", name: "Slack", icon: "slack" } : null,
    chipPrefixWidth: chipWidth,
    chipScrollTop: 0,
    disabledReason: null,
    canChat: true,
    onChange: vi.fn(),
    onKeyDown: vi.fn(),
  } as unknown as ComposerInputProps;
  return <ComposerInputBox input={input} mentions={mentions} />;
}

// jsdom has no layout. Model 60 characters per line, the placeholder filling an
// empty box (as Chromium and WebKit measure it), one more line when the chip indent pushes
// the text over, a box held at its CSS max-height once the text is taller, and
// zero width while hidden.
let visible = true;
const layout: Record<string, (this: HTMLTextAreaElement) => number> = {
  scrollHeight() {
    const text = this.value || this.placeholder;
    const rows = text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 60)), 0);
    return (rows + (this.style.textIndent ? 1 : 0)) * LINE_HEIGHT + PADDING;
  },
  clientHeight() {
    return Math.min(parseFloat(this.style.height) || 0, MAX_HEIGHT);
  },
  offsetWidth() {
    return visible ? 600 : 0;
  },
};

beforeEach(() => {
  visible = true;
  for (const [name, get] of Object.entries(layout)) {
    Object.defineProperty(HTMLTextAreaElement.prototype, name, { configurable: true, get });
  }
});

afterEach(() => {
  for (const name of Object.keys(layout)) {
    delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

describe("ComposerInputBox", () => {
  it("fits text that is set without typing, then shrinks when cleared", () => {
    const { container, rerender } = render(composer(""));
    const textarea = container.querySelector("textarea")!;
    expect(textarea.style.height).toBe("auto");

    // e.g. a suggestion prompt or a failed send restored into the composer.
    rerender(composer("one\ntwo\nthree"));
    expect(textarea.style.height).toBe("82px");
    expect(textarea.style.overflowY).toBe("hidden");

    rerender(composer(""));
    expect(textarea.style.height).toBe("auto");
  });

  it("scrolls only once the text is taller than the max height", () => {
    const { container, rerender } = render(composer("short"));
    const textarea = container.querySelector("textarea")!;
    expect(textarea.style.overflowY).toBe("hidden");

    rerender(composer(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")));
    expect(textarea.style.overflowY).toBe("auto");
  });

  it("keeps its height while hidden instead of collapsing", () => {
    const { container, rerender } = render(composer("one\ntwo\nthree"));
    const textarea = container.querySelector("textarea")!;
    expect(textarea.style.height).toBe("82px");

    // Chat stays mounted but hidden behind another page.
    visible = false;
    rerender(composer("one\ntwo\nthree\nfour"));
    expect(textarea.style.height).toBe("82px");
  });

  it("refits when a connection chip rewraps the same text", () => {
    const { container, rerender } = render(composer("summarize my unread threads"));
    const textarea = container.querySelector("textarea")!;
    expect(textarea.style.height).toBe("38px");

    // As in the app: the chip renders first, and its measured width (which
    // sets the indent) arrives one render later with the text unchanged.
    rerender(composer("summarize my unread threads", { chip: true }));
    expect(textarea.style.height).toBe("38px");
    rerender(composer("summarize my unread threads", { chip: true, chipWidth: 64 }));
    expect(textarea.style.height).toBe("60px");

    rerender(composer("summarize my unread threads"));
    expect(textarea.style.height).toBe("38px");
  });

  it("never grows an empty box for a long placeholder", () => {
    // e.g. a hovered Home card's prompt, or "… is running. Reply after this run finishes."
    const longPlaceholder = "List every meeting I had today with its decisions, owners and deadlines, then flag follow-ups.";
    const { container, rerender } = render(composer("", { placeholder: longPlaceholder }));
    const textarea = container.querySelector("textarea")!;
    expect(textarea.style.height).toBe("auto");

    rerender(composer("typed text", { placeholder: longPlaceholder }));
    expect(textarea.style.height).toBe("38px");

    rerender(composer("", { placeholder: longPlaceholder }));
    expect(textarea.style.height).toBe("auto");
  });
});
