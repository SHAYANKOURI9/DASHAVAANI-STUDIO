// Sign-in, sign-up and password reset, one page: /login, /signup, /forgot (email a reset link) and /reset?token=…
// (choose a new password). Then it goes where the editor was headed.
import { t } from "./i18n.js";

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
// The server sends ?next=<path>; the browser keeps any #part (File a story is /#desk) through the redirect.
const next = (params.get("next") ?? "/") + location.hash;
const mode = { "/signup": "up", "/forgot": "forgot", "/reset": "reset" }[location.pathname] ?? "in";
const BUTTON = { in: "Sign in", up: "Create account", forgot: "Send reset link", reset: "Set new password" };
const BUSY = { in: "Signing in…", up: "Creating account…", forgot: "Sending…", reset: "Saving…" };

for (const el of document.querySelectorAll("[data-mode]")) el.hidden = !el.dataset.mode.split(" ").includes(mode);
// The switch links keep where the editor was going (but never pass a reset token on).
for (const a of [$("#to-up"), $("#to-in"), $("#to-forgot")]) if (params.has("next")) a.search = `?next=${encodeURIComponent(params.get("next"))}`;
$("#go").textContent = t(BUTTON[mode]);
$("#pw").autocomplete = mode === "in" ? "current-password" : "new-password";
document.title = t({ in: "Sign in to Dashavani Studio", up: "Create your Dashavani Studio account", forgot: "Reset your Dashavani Studio password", reset: "Reset your Dashavani Studio password" }[mode]);
if (mode === "reset") {
  // The token is only needed once: keep it out of the address bar and browser history.
  history.replaceState(null, "", "/reset");
  if (!params.get("token")) { $("#err").textContent = t("This reset link has expired or was already used. Ask for a new one"); $("#go").disabled = true; }
  $("#pw").focus();
}
const token = params.get("token");

$("#show").addEventListener("click", (e) => {
  const shown = $("#pw").type === "text";
  $("#pw").type = shown ? "password" : "text";
  e.currentTarget.setAttribute("aria-pressed", String(!shown));
  e.currentTarget.textContent = shown ? t("Show") : t("Hide");
  $("#pw").focus();
});

const fail = (field, message) => {
  $("#err").textContent = t(message);
  field.setAttribute("aria-invalid", "true");
  field.focus();
};
const done = (id) => { $("#signin").hidden = true; $(id).hidden = false; $(`${id} h2`).focus(); };

$("#signin").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#email"), pw = $("#pw"), go = $("#go");
  if (mode !== "reset" && (!email.validity.valid || !email.value)) return fail(email, "Enter your email address.");
  if (mode !== "forgot" && !pw.value) return fail(pw, "Enter your password.");
  if ((mode === "up" || mode === "reset") && pw.value.length < 8) return fail(pw, "Use a password of at least 8 characters");
  go.disabled = true; go.textContent = t(BUSY[mode]); $("#err").textContent = "";
  try {
    const [url, data] = {
      in: ["/api/login", { email: email.value, password: pw.value, next }],
      up: ["/api/signup", { email: email.value, password: pw.value, next }],
      forgot: ["/api/forgot", { email: email.value }],
      reset: ["/api/reset", { token, password: pw.value }],
    }[mode];
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error ?? `Failed (${res.status})`);
    if (mode === "forgot") return done("#sent");
    if (out.pending) return done("#pending");
    // A reset for an account still waiting for approval has nowhere to go yet.
    location.replace(out.next ?? "/login");
  } catch (ex) {
    fail(mode === "up" || mode === "forgot" ? email : pw, ex.message);
    if (mode === "in") pw.select();
    go.disabled = false; go.textContent = t(BUTTON[mode]);
  }
});
for (const id of ["#email", "#pw"]) $(id).addEventListener("input", (e) => { e.target.removeAttribute("aria-invalid"); $("#err").textContent = ""; });
