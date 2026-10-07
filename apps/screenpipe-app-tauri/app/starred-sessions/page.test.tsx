// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Page from "./page";

const mocks = vi.hoisted(() => ({
  hide: vi.fn(),
  fetch: vi.fn(),
  visibility: null as null | ((e: { payload: boolean }) => void),
}));
vi.mock("@/lib/utils/tauri", () => ({
  commands: { hideStarredSessions: mocks.hide },
}));
vi.mock("@/lib/api", () => ({ localFetch: mocks.fetch }));
vi.mock("@/lib/hooks/use-tauri-event", () => ({
  useTauriEvent: (name: string, callback: typeof mocks.visibility) => {
    if (name === "starred-sessions-visibility") mocks.visibility = callback;
  },
}));
vi.mock("@/lib/chat-utils", () => ({ showChatWithPrefill: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.hide.mockResolvedValue({ status: "ok", data: null });
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("opens just the duration picker and dismisses with Escape", async () => {
  render(<Page />);
  expect(
    await screen.findByRole("dialog", { name: "Starred work sessions" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "15 min" })).toBeEnabled(),
  );
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(mocks.hide).toHaveBeenCalledTimes(1);
});
it("unmounts controls while hidden and reloads on reopening", async () => {
  render(<Page />);
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  act(() => mocks.visibility!({ payload: false }));
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => mocks.visibility!({ payload: true }));
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "5 min" })).toBeVisible();
});
it("keeps storage errors and retry visible inside the picker", async () => {
  mocks.fetch.mockResolvedValue({
    ok: false,
    json: async () => ({ error: "could not access starred sessions" }),
  });
  render(<Page />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "could not access starred sessions",
  );
  expect(screen.getByRole("button", { name: "15 min" })).toBeDisabled();
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "15 min" })).toBeEnabled(),
  );
});
it("does not dismiss when an editor consumes Escape", () => {
  render(<Page />);
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    cancelable: true,
  });
  event.preventDefault();
  window.dispatchEvent(event);
  expect(mocks.hide).not.toHaveBeenCalled();
});

it("dismisses after five idle seconds without changing the saved session", async () => {
  const session = { id: "active", start: new Date().toISOString(), end: new Date(Date.now() + 3600000).toISOString(), revision: 1, hd_requested: false, has_audio: false };
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [session] }) });
  render(<Page />);
  await screen.findByText("Starred session in progress");
  vi.useFakeTimers();
  fireEvent.pointerMove(screen.getByRole("region", { name: "Starred work sessions" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
  expect(mocks.hide).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(mocks.hide).toHaveBeenCalledTimes(1);
  expect(mocks.fetch.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
});
it("keeps the popup open during inline time edits", async () => {
  const session = { id: "active", start: new Date().toISOString(), end: new Date(Date.now() + 3600000).toISOString(), revision: 1, hd_requested: false, has_audio: false };
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [session] }) });
  render(<Page />);
  await screen.findByText("Starred session in progress");
  fireEvent.click(screen.getByRole("button", { name: "Edit session end" }));
  vi.useFakeTimers();
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(mocks.hide).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Session end")).toBeVisible();
});
it("does not auto-dismiss a storage error", async () => {
  mocks.fetch.mockResolvedValue({ ok: false, json: async () => ({ error: "Save unavailable" }) });
  render(<Page />);
  await screen.findByRole("alert");
  vi.useFakeTimers();
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(mocks.hide).not.toHaveBeenCalled();
});
