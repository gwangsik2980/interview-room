import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../scripts/load-materials.js";

test("md 4칸 자르기: 머리·안내 줄은 빼고 칸 이름으로 나눔", () => {
  const md = "# 제목\n\n> 안내\n\n## 직무기술서 칸\n가\n## 경험 정리 칸\n나\n\n## 자소서 칸\n다\n## 이력서 칸\n라\n";
  assert.deepEqual(parse(md), { jd: "가", exp: "나", cover: "다", resume: "라" });
  assert.throws(() => parse("## 직무기술서 칸\n가"), /빠진 칸/);
});
