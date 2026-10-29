import React, { useEffect, useState } from "react";
export async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const error = new Error(data?.error || "Request failed");
    error.status = response.status;
    throw error;
  }
  return data;
}
const empty = { name: "", email: "", department: "", title: "" };
export default function App() {
  const [user, setUser] = useState(null),
    [booting, setBooting] = useState(true),
    [employees, setEmployees] = useState([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(""),
    [editing, setEditing] = useState(null),
    [form, setForm] = useState(empty),
    [adding, setAdding] = useState(false);
  useEffect(() => {
    api("/me")
      .then(setUser)
      .catch((e) => {
        if (e.status !== 401) setError(e.message);
      })
      .finally(() => setBooting(false));
  }, []);
  async function refresh() {
    try {
      setEmployees(await api("/employees"));
    } catch (e) {
      setError(e.message);
      if (e.status === 401) setUser(null);
    }
  }
  useEffect(() => {
    if (user) refresh();
  }, [user]);
  async function login(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      setUser(
        await api("/login", {
          method: "POST",
          body: JSON.stringify(Object.fromEntries(data)),
        }),
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(editing ? `/employees/${editing}` : "/employees", {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify(form),
      });
      setAdding(false);
      setEditing(null);
      setForm(empty);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(employee) {
    if (!window.confirm(`Delete ${employee.name}?`)) return;
    setBusy(true);
    setError("");
    try {
      await api(`/employees/${employee.id}`, { method: "DELETE" });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (booting) return <main className="loading">Loading workspace…</main>;
  if (!user)
    return (
      <main className="login">
        <section className="login-story">
          <div className="brand">● people</div>
          <h1>
            Great teams.
            <br />
            One workspace.
          </h1>
          <p>A simple home for the people who make your business work.</p>
          <span>EMPLOYEE MANAGEMENT</span>
        </section>
        <section className="login-card">
          <p className="eyebrow">WELCOME BACK</p>
          <h2>Sign in to your workspace</h2>
          <p className="muted">
            Use your administrator credentials to continue.
          </p>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <form onSubmit={login}>
            <label>
              Username
              <input name="username" autoComplete="username" required />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <button disabled={busy}>
              {busy ? "Signing in…" : "Sign in →"}
            </button>
          </form>
          <small>Access is restricted to authorized team administrators.</small>
        </section>
      </main>
    );
  const visible = employees.filter((e) =>
    Object.values(e).some((v) =>
      String(v).toLowerCase().includes(query.toLowerCase()),
    ),
  );
  return (
    <div className="workspace">
      <aside>
        <div className="brand">● people</div>
        <p className="eyebrow">WORKSPACE</p>
        <a href="#dashboard" className="nav-item">
          ◫ Overview
        </a>
        <a href="#employees" className="nav-item active">
          ♙ Employees
        </a>
        <div className="sidebar-bottom">
          People operations
          <br />
          <small>Built for your team.</small>
        </div>
      </aside>
      <main className="content">
        <header>
          <span>
            Workspace <span className="muted">/ People</span>
          </span>
          <button
            className="secondary"
            onClick={async () => {
              try {
                await api("/logout", { method: "POST", body: "{}" });
                setUser(null);
                setEmployees([]);
              } catch (e) {
                setError(e.message);
              }
            }}
          >
            Sign out · {user.username}
          </button>
        </header>
        <section id="dashboard" className="page-heading">
          <p className="eyebrow">YOUR TEAM, AT A GLANCE</p>
          <h1>People make it happen.</h1>
          <p className="muted">Manage your team and keep everyone connected.</p>
        </section>
        <section className="stats">
          <article>
            <span>Total employees</span>
            <strong>{employees.length}</strong>
            <small>People in your workspace</small>
          </article>
          <article>
            <span>Departments</span>
            <strong>{new Set(employees.map((e) => e.department)).size}</strong>
            <small>Teams working together</small>
          </article>
          <article className="accent">
            <span>One team. Endless potential.</span>
            <p>A little organization goes a long way.</p>
          </article>
        </section>
        <section id="employees" className="directory">
          <div className="directory-heading">
            <div>
              <h2>
                Employee directory{" "}
                <span className="badge">{employees.length}</span>
              </h2>
              <p className="muted">All your people, in one place.</p>
            </div>
            <button
              onClick={() => {
                setForm(empty);
                setEditing(null);
                setAdding(true);
              }}
            >
              + Add employee
            </button>
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <label className="search">
            Search employees
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, role, department…"
            />
          </label>
          {(adding || editing) && (
            <form className="employee-form" onSubmit={save}>
              <h3>{editing ? "Edit employee" : "New employee"}</h3>
              <div className="form-grid">
                {Object.keys(empty).map((key) => (
                  <label key={key}>
                    {key === "title"
                      ? "Job title"
                      : key[0].toUpperCase() + key.slice(1)}
                    <input
                      required
                      maxLength={
                        key === "email" ? 254 : key === "department" ? 100 : 120
                      }
                      type={key === "email" ? "email" : "text"}
                      value={form[key]}
                      onChange={(e) =>
                        setForm({ ...form, [key]: e.target.value })
                      }
                    />
                  </label>
                ))}
              </div>
              <button disabled={busy}>Save employee</button>{" "}
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setAdding(false);
                  setEditing(null);
                }}
              >
                Cancel
              </button>
            </form>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Department</th>
                  <th>Job title</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <div className="person">
                        <span className="avatar">
                          {e.name
                            .split(" ")
                            .map((v) => v[0])
                            .slice(0, 2)
                            .join("")}
                        </span>
                        <div>
                          <strong>{e.name}</strong>
                          <small>{e.email}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="department">{e.department}</span>
                    </td>
                    <td>{e.title}</td>
                    <td>
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => {
                          setForm({
                            name: e.name,
                            email: e.email,
                            department: e.department,
                            title: e.title,
                          });
                          setEditing(e.id);
                          setAdding(false);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="text-button danger"
                        disabled={busy}
                        onClick={() => remove(e)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!visible.length && (
              <div className="empty">
                <h3>
                  {query ? "No matching employees" : "Your team starts here"}
                </h3>
                <p>
                  {query
                    ? "Try another search."
                    : "Add your first employee to build your directory."}
                </p>
              </div>
            )}
          </div>
          <footer>
            {visible.length} of {employees.length} employees
          </footer>
        </section>
        <p className="footnote">
          People workspace · A better place to manage your team
        </p>
      </main>
    </div>
  );
}
