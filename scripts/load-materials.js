// 자료 불러오기: md 하나의 '## 직무기술서 칸 / ## 경험 정리 칸 / ## 자소서 칸 / ## 이력서 칸'을 그 회사 자료 4칸에 저장.
// 사용: npm run load -- <md 경로> <회사 이름>
// .env의 DATABASE_URL이 있으면 배포 DB(Neon), 없으면 로컬 .data/store.json. md는 저장소 밖에서 읽기만 한다.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as store from "../lib/store.js";
import { actions } from "../api/app.js";

const HEADS = { "직무기술서": "jd", "경험 정리": "exp", "자소서": "cover", "이력서": "resume" };

export function parse(md) {
  const docs = {};
  // 첫 ## 앞('#' 제목·'>' 안내)은 버리고, '## <이름> 칸' 덩이마다 자른다
  for (const part of md.replace(/\r\n/g, "\n").split(/^## /m).slice(1)) {
    const nl = part.indexOf("\n");
    const head = (nl < 0 ? part : part.slice(0, nl)).trim().replace(/\s*칸$/, "");
    if (!(head in HEADS)) throw new Error(`모르는 칸: "## ${head}"`);
    docs[HEADS[head]] = (nl < 0 ? "" : part.slice(nl + 1)).trim();
  }
  const missing = Object.entries(HEADS).filter(([, k]) => !(k in docs)).map(([h]) => h);
  if (missing.length) throw new Error(`빠진 칸: ${missing.join(", ")}`);
  return docs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [path, name] = process.argv.slice(2);
  if (!path || !name) { console.error("사용: npm run load -- <md 경로> <회사 이름>"); process.exit(1); }
  const docs = parse(await readFile(path, "utf8"));
  const found = ((await store.get("companies")) || []).find((c) => c.name === name.trim());
  const old = found ? (await actions.getCompany({ id: found.id })).company : null;
  // 있으면 같은 id로 덮어씀(설정·회차 기록 유지), 없으면 새로 만듦
  const { company } = await actions.saveCompany({ id: old?.id, name, docs, settings: old?.settings });
  const back = (await actions.getCompany({ id: company.id })).company.docs;
  console.log(`${process.env.DATABASE_URL || process.env.POSTGRES_URL ? "배포 DB" : "로컬 파일"}에 저장: ${company.name} (${old ? "덮어씀" : "새로 만듦"}, id ${company.id})`);
  for (const [h, k] of Object.entries(HEADS)) console.log(`  ${h}: ${back[k].length.toLocaleString()}자`);
}
