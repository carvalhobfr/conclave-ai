// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AcceptanceEditor } from "./acceptance-editor.js";
import { api } from "./api.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("loads persisted criteria, resets confirmation on edits and saves against the loaded revision", async () => {
  const criterion = { id: "reload", statement: "Survives reload", verificationPlan: "Save then reload", confirmed: true, kind: "runtime" as const, claimIds: [], implementationPaths: [] };
  const saved = { revision: "r1", contract: { objective: "Persist", claims: [], allowedPathPrefixes: [], criteria: [criterion] } };
  vi.spyOn(api, "acceptance").mockResolvedValue(saved);
  const save = vi.spyOn(api, "saveAcceptance").mockResolvedValue({ ...saved, revision: "r2" });
  const onChange = vi.fn(); const onLoad = vi.fn();
  render(<AcceptanceEditor projectId="local" objective="Persist" onChange={onChange} onLoad={onLoad} />);
  const input = await screen.findByDisplayValue("Survives reload");
  expect(onLoad).toHaveBeenCalledWith("Persist");
  fireEvent.change(input, { target: { value: "Survives two reloads" } });
  expect(screen.getByRole<HTMLInputElement>("checkbox").checked).toBe(false);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Save criteria" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith("local", expect.objectContaining({ criteria: [expect.objectContaining({ id: "reload", statement: "Survives two reloads", confirmed: true })] }), "r1"));
});
