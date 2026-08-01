import crypto from "crypto";
import { getStore } from "@netlify/blobs";

const STORE_NAME = "gre-words";

function json(value, statusCode = 200) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(value)
  };
}

async function readJson(key, fallback) {
  try {
    const value = await getStore(STORE_NAME).get(key, { type: "json" });
    return value === null ? fallback : value;
  } catch (err) {
    return fallback;
  }
}

async function writeJson(key, value) {
  await getStore(STORE_NAME).setJSON(key, value);
}

function routePath(event) {
  let pathname = "/";
  try {
    pathname = new URL(event.rawUrl).pathname;
  } catch (err) {
    pathname = event.path || "/";
  }
  return pathname
    .replace(/^\/\.netlify\/functions\/api/, "")
    .replace(/^\/api/, "") || "/";
}

function parseBody(event) {
  try {
    return JSON.parse(event.body || "{}");
  } catch (err) {
    return {};
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString("hex");
}

function publicProfile(profile) {
  return {
    userId: profile.userId,
    username: profile.username,
    token: profile.token,
    state: profile.state,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  };
}

async function createUser(username, password) {
  const users = await readJson("users", {});
  if (users[username]) return { error: "taken" };

  const userId = "u_" + crypto.randomBytes(8).toString("hex");
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(password, salt);
  const token = crypto.randomBytes(24).toString("hex");
  const now = new Date().toISOString();

  users[username] = userId;
  await writeJson("users", users);

  const tokens = await readJson("tokens", {});
  tokens[token] = userId;
  await writeJson("tokens", tokens);

  const profile = {
    userId,
    username,
    passwordHash,
    passwordSalt: salt,
    token,
    state: null,
    createdAt: now,
    updatedAt: now
  };
  await writeJson("profile:" + userId, profile);
  return { profile };
}

async function loginUser(username, password) {
  const users = await readJson("users", {});
  const userId = users[username];
  if (!userId) return { error: "not_found" };
  const profile = await readJson("profile:" + userId, null);
  if (!profile) return { error: "not_found" };
  const candidate = hashPassword(password, profile.passwordSalt);
  if (candidate !== profile.passwordHash) return { error: "bad_password" };

  const token = crypto.randomBytes(24).toString("hex");
  const tokens = await readJson("tokens", {});
  tokens[token] = userId;
  await writeJson("tokens", tokens);
  profile.token = token;
  profile.updatedAt = new Date().toISOString();
  await writeJson("profile:" + userId, profile);
  return { profile };
}

async function authUserId(event) {
  const header = event.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  const tokens = await readJson("tokens", {});
  return tokens[token] || null;
}

export async function handler(event) {
  const path = routePath(event);

  if (event.httpMethod === "POST" && path === "/register") {
    const body = parseBody(event);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!username || username.length > 30 || !password) {
      return json({ error: "invalid input" }, 400);
    }
    const result = await createUser(username, password);
    if (result.error === "taken") {
      return json({ error: "username taken" }, 409);
    }
    return json(publicProfile(result.profile));
  }

  if (event.httpMethod === "POST" && path === "/login") {
    const body = parseBody(event);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const result = await loginUser(username, password);
    if (result.error === "not_found") {
      return json({ error: "user not found" }, 404);
    }
    if (result.error === "bad_password") {
      return json({ error: "wrong password" }, 401);
    }
    return json(publicProfile(result.profile));
  }

  const userId = await authUserId(event);
  if (!userId) {
    return json({ error: "unauthorized" }, 401);
  }

  if (event.httpMethod === "GET" && path === "/profile") {
    const profile = await readJson("profile:" + userId, null);
    if (!profile) return json({ error: "profile not found" }, 404);
    return json(publicProfile(profile));
  }

  if (event.httpMethod === "PUT" && path === "/profile") {
    const body = parseBody(event);
    const profile = await readJson("profile:" + userId, null);
    if (!profile) return json({ error: "profile not found" }, 404);
    profile.state = body.state || null;
    profile.updatedAt = new Date().toISOString();
    await writeJson("profile:" + userId, profile);
    return json({ ok: true, updatedAt: profile.updatedAt });
  }

  return json({ error: "not found" }, 404);
}
