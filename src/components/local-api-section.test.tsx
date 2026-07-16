import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { LocalApiSection } from "@/components/local-api-section";

afterEach(() => {
  cleanup();
  invoke.mockReset();
  vi.restoreAllMocks();
});

describe("LocalApiSection", () => {
  it("shows the listening address and token path", async () => {
    invoke.mockResolvedValue({
      enabled: true,
      state: "listening",
      bindAddr: "127.0.0.1:6736",
      port: 6736,
      tokenFilePath: "/tmp/local-api-token",
    });

    render(<LocalApiSection />);

    expect(await screen.findByText("Active")).toBeInTheDocument();
    expect(screen.getByText("127.0.0.1:6736")).toBeInTheDocument();
    expect(screen.getByText("/tmp/local-api-token")).toBeInTheDocument();
  });

  it("explains when the token file cannot be stored", async () => {
    invoke.mockResolvedValue({
      enabled: false,
      state: "tokenFileError",
      bindAddr: "127.0.0.1:6736",
      port: 6736,
      tokenFilePath: null,
    });

    render(<LocalApiSection />);

    expect(await screen.findByText("Disabled (Token File Error)")).toBeInTheDocument();
    expect(
      screen.getByText("The API token could not be stored securely. Check the app logs for details.")
    ).toBeInTheDocument();
  });

  it("shows a friendly error when status lookup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    invoke.mockRejectedValue(new Error("IPC failed"));

    render(<LocalApiSection />);

    expect(await screen.findByText("Unable To Read API Status")).toBeInTheDocument();
  });
});
