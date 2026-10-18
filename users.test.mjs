import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { userStore } from "./users.mjs";

const fresh = () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "users-")), "users.json");
  return { file, users: userStore(file) };
};

test("the first account is the owner; later ones wait for approval", () => {
  const { users } = fresh();
  const owner = users.signUp("Owner@Example.com ", "longpassword").user;
  assert.deepEqual([owner.email, owner.role, owner.status], ["owner@example.com", "owner", "approved"]);
  const ed = users.signUp("ed@example.com", "longpassword").user;
  assert.deepEqual([ed.role, ed.status], ["editor", "pending"]);
  assert.match(users.signIn("ed@example.com", "longpassword").error, /approval/);
  assert.equal(users.setStatus(ed.id, "approved"), null);
  assert.equal(users.signIn("ED@example.com", "longpassword").user.id, ed.id);
  assert.equal(users.setStatus(owner.id, "removed"), "No such account", "the owner can't be removed");
  assert.match(users.signUp("ed@example.com", "longpassword").error, /already exists/);
  assert.match(users.signUp("not-an-email", "longpassword").error, /email/);
  assert.match(users.signUp("x@example.com", "short").error, /8 characters/);
});

test("wrong passwords: one answer for every failure, and a lock after five", () => {
  const { users } = fresh();
  users.signUp("o@example.com", "longpassword");
  const nobody = users.signIn("nobody@example.com", "longpassword").error;
  assert.equal(users.signIn("o@example.com", "wrong-pass").error, nobody, "an unknown email and a wrong password look the same");
  for (let i = 0; i < 4; i++) users.signIn("o@example.com", "wrong-pass", 1000);
  assert.match(users.signIn("o@example.com", "longpassword", 2000).error, /Too many/, "locked even with the right password");
  assert.ok(users.signIn("o@example.com", "longpassword", 2000 + 16 * 60_000).user, "unlocked after 15 minutes");
});

test("nothing secret is stored or shown in the clear, and no API key is ever kept for an account", () => {
  const { file, users } = fresh();
  users.signUp("o@example.com", "longpassword");
  const ed = users.signUp("e@example.com", "longpassword").user;
  assert.ok(!fs.readFileSync(file, "utf8").includes("longpassword"), "no plain password on disk");
  assert.equal(users.setKeys, undefined, "accounts can't save keys: they live only in the server's .env.local");
  assert.equal("keys" in users.pub(users.find(ed.id)), false);
  assert.deepEqual(Object.keys(users.pub(users.find(ed.id))).sort(), ["createdAt", "email", "id", "role", "status"]);
});

test("forgot password: a one-time link that lasts an hour, stored only as a hash", () => {
  const { file, users } = fresh();
  users.signUp("o@example.com", "longpassword");
  assert.equal(users.startReset("nobody@example.com", 0), null, "no account: nothing sent");
  const r = users.startReset(" O@Example.com", 1000);
  assert.equal(r.email, "o@example.com");
  assert.ok(!fs.readFileSync(file, "utf8").includes(r.token), "the users file holds only the token's hash");
  assert.equal(users.startReset("o@example.com", 30_000), null, "one email a minute");
  assert.match(users.finishReset("wrong-token", "newpassword1", 2000).error, /expired/);
  assert.match(users.finishReset(r.token, "short", 2000).error, /8 characters/);
  assert.match(users.finishReset(r.token, "newpassword1", 1000 + 61 * 60_000).error, /expired/, "after an hour");
  assert.ok(users.finishReset(r.token, "newpassword1", 2000).user);
  assert.match(users.finishReset(r.token, "another-pass", 3000).error, /already used/, "works once");
  assert.ok(users.signIn("o@example.com", "newpassword1").user);
  assert.ok(users.signIn("o@example.com", "longpassword").error, "the old password stops working");
});

test("change password needs the current one; the owner's temporary password must be changed", () => {
  const { users } = fresh();
  const owner = users.signUp("o@example.com", "longpassword").user;
  const ed = users.signUp("ed@example.com", "longpassword").user;
  users.setStatus(ed.id, "approved");
  assert.match(users.changePassword(ed.id, "wrong-pass", "newpassword").error, /current password/);
  assert.match(users.changePassword(ed.id, "longpassword", "short").error, /8 characters/);
  assert.ok(users.changePassword(ed.id, "longpassword", "newpassword").user);
  assert.ok(users.signIn("ed@example.com", "longpassword").error, "the old password stops working");
  assert.ok(users.signIn("ed@example.com", "newpassword").user);
  assert.match(users.tempPassword(owner.id).error, /No such/, "the owner's own password is never reset this way");
  const { password } = users.tempPassword(ed.id);
  assert.ok(users.signIn("ed@example.com", "newpassword").error);
  assert.equal(users.pub(users.signIn("ed@example.com", password).user).mustChange, true);
  users.changePassword(ed.id, password, "mine-again");
  assert.equal(users.pub(users.find(ed.id)).mustChange, undefined, "changed: no longer forced");
});
