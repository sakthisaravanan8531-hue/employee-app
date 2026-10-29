import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App.jsx";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const reply = (data, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: async () => data });
describe("employee workspace", () => {
  it("signs in and loads the dashboard", async () => {
    let loggedIn = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((url, options) => {
        if (url === "/api/me") return reply({ error: "Please sign in" }, 401);
        if (url === "/api/login") {
          loggedIn = true;
          return reply({ username: "admin" });
        }
        if (url === "/api/employees")
          return reply([
            {
              id: "1",
              name: "Alex Rivera",
              email: "alex@example.test",
              department: "Engineering",
              title: "Engineer",
            },
          ]);
        throw new Error(`Unexpected ${url}`);
      }),
    );
    render(<App />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "password");
    await user.click(screen.getByRole("button", { name: "Sign in →" }));
    expect(await screen.findByText("Alex Rivera")).toBeTruthy();
    expect(loggedIn).toBe(true);
  });
  it("adds, edits and deletes employees through the API", async () => {
    let records = [];
    const fetchMock = vi.fn((url, options) => {
      if (url === "/api/me") return reply({ username: "admin" });
      if (url === "/api/employees" && options.method === "POST") {
        records = [{ ...JSON.parse(options.body), id: "one" }];
        return reply(records[0], 201);
      }
      if (url === "/api/employees/one" && options.method === "PUT") {
        records = [{ ...JSON.parse(options.body), id: "one" }];
        return reply(records[0]);
      }
      if (url === "/api/employees/one" && options.method === "DELETE") {
        records = [];
        return reply(null, 204);
      }
      if (url === "/api/employees") return reply([...records]);
      throw new Error(`Unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "+ Add employee" }),
    );
    for (const [label, value] of [
      ["Name", "Sam Taylor"],
      ["Email", "sam@example.test"],
      ["Department", "Design"],
      ["Job title", "Designer"],
    ])
      await user.type(screen.getByLabelText(label), value);
    await user.click(screen.getByRole("button", { name: "Save employee" }));
    expect(await screen.findByText("Sam Taylor")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.clear(screen.getByLabelText("Job title"));
    await user.type(screen.getByLabelText("Job title"), "Lead Designer");
    await user.click(screen.getByRole("button", { name: "Save employee" }));
    expect(await screen.findByText("Lead Designer")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("Sam Taylor")).toBeNull());
    expect(fetchMock.mock.calls.some(([, o]) => o.method === "DELETE")).toBe(
      true,
    );
  });
  it("shows authentication errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => reply({ error: "Invalid username or password" }, 401)),
    );
    render(<App />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in →" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Invalid username or password",
    );
  });
});
