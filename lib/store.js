// 키-값 저장소. 한 사람만 쓰는 앱이라 문서 몇 개를 JSON으로 통째로 읽고 쓴다.
// DATABASE_URL이 있으면 Postgres(Neon), 없으면 로컬 파일(.data/store.json).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;

let sql = null;
let ready = null;
function db() {
  sql ??= neon(url);
  ready ??= sql`create table if not exists kv (k text primary key, v jsonb not null, updated_at timestamptz not null default now())`;
  return ready.then(() => sql);
}

const FILE = ".data/store.json";
async function readAll() {
  // Vercel은 파일을 쓸 수 없다. DB 없이 배포됐으면 원인을 바로 알려 준다.
  if (process.env.VERCEL) throw Object.assign(new Error("데이터베이스가 연결되지 않았어요. Vercel의 Storage에서 Neon을 이 프로젝트에 연결한 뒤 Redeploy 해 주세요."), { status: 500 });
  try {
    return JSON.parse(await readFile(FILE, "utf8"));
  } catch {
    return {};
  }
}

export async function get(key) {
  if (url) {
    const rows = await (await db())`select v from kv where k = ${key}`;
    return rows[0]?.v ?? null;
  }
  return (await readAll())[key] ?? null;
}

export async function set(key, value) {
  if (url) {
    await (await db())`insert into kv (k, v) values (${key}, ${JSON.stringify(value)}::jsonb)
      on conflict (k) do update set v = excluded.v, updated_at = now()`;
    return;
  }
  const all = await readAll();
  all[key] = value;
  await mkdir(".data", { recursive: true });
  await writeFile(FILE, JSON.stringify(all, null, 1));
}
