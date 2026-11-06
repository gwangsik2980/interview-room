// 완료 기준 확인: 1회차 8~10문항 → 평가 → 2회차는 1회차와 겹치지 않고 막힌 질문이 표현을 바꿔 다시 나온다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir(mkdtempSync(join(tmpdir(), "ir-"))); // 로컬 파일 저장소를 임시 폴더에
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;
process.env.APP_PASSWORD = "test-pw";

const { default: handler } = await import("../api/app.js");
const { mix } = await import("../lib/interview.js");

let cookie = "";
async function call(action, body = {}) {
  const req = { method: "POST", headers: { cookie }, body: { action, ...body } };
  let status, headers, out;
  const res = { writeHead: (s, h) => ((status = s), (headers = h)), end: (b) => (out = JSON.parse(b)) };
  await handler(req, res);
  if (headers["Set-Cookie"]) cookie = headers["Set-Cookie"].split(";")[0];
  return { status, ...out };
}

test("mix: 기본 7개는 직무 5, 인성 2", () => {
  assert.deepEqual(mix({}), { variable: 7, job: 5, person: 2 });
  assert.equal(mix({ variable: 20 }).variable, 8);
});

test("로그인 없이는 막힌다", async () => {
  assert.equal((await call("companies")).status, 401);
  assert.equal((await call("login", { password: "wrong" })).status, 401);
  assert.equal((await call("login", { password: "test-pw" })).status, 200);
});

test("두 회차 흐름", async () => {
  const { company } = await call("saveCompany", { name: "테스트회사", docs: { resume: "이력" }, settings: { variable: 7, jobPercent: 70 } });
  const r1 = (await call("startRound", { companyId: company.id })).round;
  assert.ok(r1.items.length >= 8 && r1.items.length <= 10, `문항 수 ${r1.items.length}`);
  assert.deepEqual(r1.items.slice(0, 2).map((i) => i.type), ["자기소개", "지원동기"]);

  // 첫 변동 질문은 짧게 답해 막히게 하고 나머지는 길게
  for (const [i, it] of r1.items.entries()) {
    const answer = i === 2 ? "음 잘 모르겠습니다" : "저는 현장에서 재고 차이를 줄이기 위해 매일 실사를 하고 원인을 기록해 개선했습니다. ".repeat(2);
    await call("saveAnswer", { companyId: company.id, roundId: r1.id, itemId: it.id, answer, seconds: i === 2 ? 8 : 50 });
    await call("followUp", { companyId: company.id, roundId: r1.id, itemId: it.id });
  }
  const done = await call("finishRound", { companyId: company.id, roundId: r1.id });
  assert.equal(done.round.status, "done");
  const stuck = done.round.items[2];
  assert.equal(stuck.retry, true);
  assert.ok(done.round.items.every((it) => it.evaluation));

  const r2 = (await call("startRound", { companyId: company.id })).round;
  assert.equal(r2.no, 2);
  const v1 = new Set(r1.items.filter((i) => i.kind !== "fixed").map((i) => i.q));
  const v2 = r2.items.filter((i) => i.kind !== "fixed");
  assert.ok(v2.every((i) => !v1.has(i.q)), "2회차 변동 질문이 1회차와 겹침");
  const again = v2.find((i) => i.rephraseOf === stuck.id);
  assert.ok(again, "막힌 질문이 다시 나오지 않음");
  assert.notEqual(again.q, stuck.q);

  // 다시 낸 질문을 잘 답하면 원래 질문의 '다시 연습'이 내려간다
  await call("saveAnswer", { companyId: company.id, roundId: r2.id, itemId: again.id, answer: "저는 결론부터 말씀드리면 매일 실사로 차이를 줄였습니다. 원인을 기록하고 개선했습니다.", seconds: 45 });
  const fin2 = await call("finishRound", { companyId: company.id, roundId: r2.id });
  assert.equal(fin2.rounds[0].items.find((i) => i.id === stuck.id).retry, false);
  assert.equal(fin2.round.items.length, 1, "안 답한 질문은 회차에서 빠짐");
});
