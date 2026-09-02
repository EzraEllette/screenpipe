// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

export type FrameContextNode = {
  role?: string;
  text?: string;
  depth?: number;
};

export type FrameContextPayload = {
  frame_id: number;
  timestamp?: string | null;
  app_name?: string | null;
  window_name?: string | null;
  browser_url?: string | null;
  focused?: boolean | null;
  text?: string | null;
  nodes?: FrameContextNode[];
  urls?: string[];
  text_source?: string;
};

function present(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "unknown";
}

export function formatFrameContext(data: FrameContextPayload): string {
  const focused =
    data.focused === true ? "true" : data.focused === false ? "false" : "unknown";
  const lines = [
    `Frame ${data.frame_id} (source: ${present(data.text_source)})`,
    `Timestamp: ${present(data.timestamp)}`,
    `App: ${present(data.app_name)}`,
    `Window: ${present(data.window_name)}`,
    `Browser URL: ${present(data.browser_url)}`,
    `Focused: ${focused}`,
  ];

  if (data.urls?.length) {
    lines.push("", "URLs:", ...data.urls.map((url) => `  ${url}`));
  }

  if (data.nodes?.length) {
    lines.push("", `Nodes: ${data.nodes.length}`);
    for (const node of data.nodes.slice(0, 50)) {
      const indent = "  ".repeat(Math.min(node.depth ?? 0, 5));
      lines.push(`${indent}[${node.role ?? ""}] ${node.text ?? ""}`);
    }
    if (data.nodes.length > 50) {
      lines.push(`  ... and ${data.nodes.length - 50} more nodes`);
    }
  }

  if (data.text) {
    const truncated =
      data.text.length > 2000 ? `${data.text.substring(0, 2000)}...` : data.text;
    lines.push("", "Full text:", truncated);
  }

  return lines.join("\n");
}
