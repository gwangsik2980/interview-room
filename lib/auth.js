// 회장 한 사람만 쓰는 로그인: 환경 변수 APP_PASSWORD 하나와 서명된 쿠키.
// 비밀번호를 바꾸면 예전 쿠키는 모두 무효가 된다.
import { createHmac, timingSafeEqual } from "node:crypto";
import * as store from "./store.js";

const COOKIE = "ir_auth";
const DAYS = 180;
const MAX_FAILS = 10;
const WINDOW_MS = 15 * 60 * 1000;

function token() {
  return createHmac("sha256", process.env.APP_PASSWORD).update("interview-room-session-v1").digest("base64url");
}

function same(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((p) => p.length === 2),
  );
}

export function isAuthed(req) {
  if (!process.env.APP_PASSWORD) return false;
  return same(cookies(req)[COOKIE] || "", token());
}

function cookieHeader(req, value, maxAge) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/** 성공하면 Set-Cookie 값을, 실패하면 오류 문구를 던진다. 15분에 10번 틀리면 잠깐 막는다. */
export async function logIn(req, password) {
  if (!process.env.APP_PASSWORD) throw httpError(500, "서버에 비밀번호(APP_PASSWORD)가 아직 설정되지 않았어요.");
  const fails = (await store.get("login_fails")) || { count: 0, since: 0 };
  const now = Date.now();
  if (now - fails.since > WINDOW_MS) Object.assign(fails, { count: 0, since: now });
  if (fails.count >= MAX_FAILS) throw httpError(429, "비밀번호를 여러 번 틀려서 15분 동안 막혔어요. 잠시 뒤 다시 해 주세요.");
  if (!same(password || "", process.env.APP_PASSWORD)) {
    fails.count += 1;
    await store.set("login_fails", fails);
    throw httpError(401, "비밀번호가 맞지 않아요.");
  }
  if (fails.count) await store.set("login_fails", { count: 0, since: now });
  return cookieHeader(req, token(), DAYS * 86400);
}

export function logOutCookie(req) {
  return cookieHeader(req, "", 0);
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
