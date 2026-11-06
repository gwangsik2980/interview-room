// AI 면접관. ANTHROPIC_API_KEY가 없으면 데모 면접관(정해진 질문, 규칙 기반 평가)으로 돈다.
import Anthropic from "@anthropic-ai/sdk";
import { JOB_TYPES, PERSON_TYPES } from "./interview.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
export const demo = !client;

const DOC_LABELS = { resume: "이력서", cover: "자소서 최종본", jd: "직무기술서(공고)", exp: "경험 정리" };

// 모든 호출이 같은 규칙과 자료를 앞에 두어 캐시를 같이 쓴다.
const RULES = `당신은 한국 기업의 1차 직무면접 면접관입니다. 지원자 한 명의 면접 연습을 돕습니다.

지킬 것:
- 말투는 실제 면접처럼 격식체입니다. ("~말씀해 주십시오", "~입니까?")
- 지원자의 경험을 지어내지 마십시오. 질문에서 지원자 경험을 언급할 때는 아래 자료에 적힌 사실만 쓰고, 자료에 없는 숫자·기간·역할·성과를 지원자의 것처럼 말하지 마십시오.
- 회사·직무에 관한 사실도 자료에 있는 것만 씁니다. 모르면 일반적인 표현으로 묻습니다.
- 다대다 면접이라 한 질문은 짧고 하나만 묻습니다. 여러 질문을 한 문장에 묶지 않습니다.
- 모든 출력은 한국어입니다.`;

function system(company) {
  const docs = Object.entries(DOC_LABELS)
    .map(([k, label]) => `<${label}>\n${company.docs?.[k]?.trim() || "(없음)"}\n</${label}>`)
    .join("\n\n");
  return [
    { type: "text", text: RULES },
    { type: "text", text: `회사: ${company.name}\n\n지원자 자료:\n${docs}`, cache_control: { type: "ephemeral" } },
  ];
}

async function ask(company, task, schema, effort) {
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      system: system(company),
      messages: [{ role: "user", content: task }],
      output_config: { effort, format: { type: "json_schema", schema } },
      // 안전 분류기가 거절하면 서버가 다른 모델로 다시 돌린다.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    const res = await stream.finalMessage();
    console.info(`[ai] model=${res.model} in=${res.usage.input_tokens} cache_read=${res.usage.cache_read_input_tokens ?? 0} out=${res.usage.output_tokens}`);
    if (res.stop_reason === "refusal") throw aiError("AI가 이 요청에 답하지 못했어요. 다시 시도해 주세요.");
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return JSON.parse(text);
  } catch (err) {
    if (err.status && err.expose) throw err;
    if (err instanceof Anthropic.APIError && err.status === 402) throw aiError("이번 달 AI 사용 한도를 다 썼어요. 지금까지 답변은 저장돼 있어요.");
    if (err instanceof Anthropic.RateLimitError) throw aiError("AI가 잠시 바빠요. 몇 초 뒤 다시 눌러 주세요.");
    if (err instanceof Anthropic.AuthenticationError) throw aiError("AI 키 설정에 문제가 있어요. Vercel의 ANTHROPIC_API_KEY를 확인해 주세요.");
    console.error(`[ai] ${err?.constructor?.name} status=${err?.status ?? "-"}`);
    throw aiError("AI 응답을 받지 못했어요. 잠시 뒤 다시 시도해 주세요.");
  }
}

const aiError = (message) => Object.assign(new Error(message), { status: 502, expose: true });

const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const str = { type: "string" };

/** 변동 질문 만들기. */
export async function generateQuestions(company, hist, m) {
  if (demo) return demoQuestions(hist, m);
  const task = `이번 회차의 변동 질문 ${m.variable}개를 만드십시오. (고정 질문인 1분 자기소개·지원동기는 따로 묻으니 만들지 마십시오.)

- 직무 질문 ${m.job}개: 유형은 ${JOB_TYPES.join(", ")} 중에서. 지원 직무의 실제 업무 장면에 맞게, 지원자 자료의 경험과 연결되면 좋습니다.
- 인성 질문 ${m.person}개: 유형은 "인성".
- 지금까지 유형별 출제 수: ${JSON.stringify(hist.typeCounts)}. 덜 나온 유형을 먼저 고르십시오.
- 지난 회차까지 나온 질문(같은 질문이나 거의 같은 질문 금지):
${hist.asked.map((q) => `  - ${q}`).join("\n") || "  (없음)"}
- 지난 회차에 막힌 질문입니다. 최대 2개를 골라 같은 것을 묻되 표현과 각도를 바꿔 다시 내고, rephrase_of에 그 id를 넣으십시오. 나머지 질문의 rephrase_of는 빈 문자열입니다.
${hist.retry.map((r) => `  - id=${r.id} [${r.type}] ${r.q}`).join("\n") || "  (없음)"}

질문 순서는 실제 면접 흐름처럼 직무 질문을 먼저, 인성 질문을 뒤에 두십시오.`;
  const schema = obj({ questions: { type: "array", items: obj({ type: { type: "string", enum: [...JOB_TYPES, ...PERSON_TYPES] }, q: str, rephrase_of: str }) } });
  return (await ask(company, task, schema, "medium")).questions;
}

/** 꼬리질문 하나 또는 null. */
export async function followUp(company, item) {
  if (demo) return item.answer.length > 80 && item.kind !== "fixed" ? "방금 말씀하신 일에서 지원자 본인이 직접 한 행동을 하나만 더 구체적으로 말씀해 주시겠습니까?" : null;
  const task = `질문: ${item.q}
지원자 답변(음성 인식이라 오타가 있을 수 있음): ${item.answer}

다대다 면접에서 면접관이 이 답변에 꼬리질문을 한 번 할지 정하십시오.
- 답변이 모호하거나, 근거·본인 역할·결과가 빠졌거나, 더 확인할 만한 점이 있을 때만 짧은 꼬리질문 하나를 follow_up에 넣으십시오.
- 충분한 답변이면 follow_up은 빈 문자열입니다.
- 답변에 없는 사실을 전제로 묻지 마십시오.`;
  const out = await ask(company, task, obj({ follow_up: str }), "low");
  return out.follow_up.trim() || null;
}

/** 회차가 끝난 뒤 질문별 평가. */
export async function evaluate(company, items) {
  const answered = items.filter((it) => it.answer.trim());
  if (demo) return demoEvaluate(answered);
  const qa = answered
    .map(
      (it) =>
        `<item id="${it.id}" type="${it.type}" seconds="${it.seconds}">\n질문: ${it.q}\n답변: ${it.answer}` +
        (it.followUp?.answer ? `\n꼬리질문: ${it.followUp.q}\n꼬리 답변(${it.followUp.seconds}초): ${it.followUp.answer}` : "") +
        `\n</item>`,
    )
    .join("\n\n");
  const task = `면접 연습 한 회차가 끝났습니다. 질문별로 평가하십시오. 답변은 음성 인식 결과라 띄어쓰기·오타는 평가하지 않습니다.

${qa}

질문마다:
- fit: 질문에 맞게 답했는지 "좋음" | "보통" | "부족", fit_note에 한 줄 이유
- conclusion_first: 첫 한두 문장에 결론(핵심 답)이 나왔는지, conclusion_note에 한 줄
- stuck_points: 막힌 지점, 같은 말 반복, 말이 끊기거나 흐려진 곳 (없으면 빈 배열)
- fact_issues: 답변의 숫자·기간·역할이 경험 정리와 다른 곳(경험 정리가 "(없음)"이면 이력서·자소서와 대조). said에 답변에서 한 말, source에 자료에 적힌 내용, note에 한 줄. 자료에 아예 없는 내용은 "자료에서 확인 안 됨"이라고만 하고 틀렸다고 단정하지 마십시오. 없으면 빈 배열
- time_note: 답변 시간(seconds)이 이 질문에 적절한지 한 줄
- tip: 다음에 이렇게 답하면 좋겠다는 한두 문장. 자료에 있는 사실만 쓰고 경험을 지어내지 마십시오
- needs_retry: 다시 연습해야 할 만큼 막혔거나 질문에 못 맞췄으면 true

summary: 이번 회차 전체 총평 두세 문장 (가장 약한 점 하나를 분명히).`;
  const schema = obj({
    summary: str,
    items: {
      type: "array",
      items: obj({
        id: str,
        fit: { type: "string", enum: ["좋음", "보통", "부족"] },
        fit_note: str,
        conclusion_first: { type: "boolean" },
        conclusion_note: str,
        stuck_points: { type: "array", items: str },
        fact_issues: { type: "array", items: obj({ said: str, source: str, note: str }) },
        time_note: str,
        tip: str,
        needs_retry: { type: "boolean" },
      }),
    },
  });
  return ask(company, task, schema, "medium");
}

// ---------- 데모 면접관 (키 없을 때) ----------
const BANK = {
  "현장 운영": ["물류센터 하루 출고 물량이 평소의 두 배로 늘었다면 무엇부터 조정하시겠습니까?", "입고 검수에서 수량 차이가 발견되면 어떻게 처리하시겠습니까?"],
  "인력 관리": ["현장 작업자와 의견이 부딪칠 때 어떻게 설득하시겠습니까?", "결원이 생긴 날 작업을 어떻게 배분하시겠습니까?"],
  "문제 해결": ["예상하지 못한 문제를 짧은 시간 안에 해결한 경험을 말씀해 주십시오.", "원인을 데이터로 찾아낸 경험이 있습니까?"],
  협업: ["다른 부서와 일정이 충돌했을 때 어떻게 조율하셨습니까?", "팀 안에서 맡은 역할을 넘어서 도운 경험을 말씀해 주십시오."],
  "안전·품질": ["식품 물류에서 가장 중요한 품질 관리 포인트는 무엇이라고 보십니까?", "안전 수칙을 지키지 않는 동료를 보면 어떻게 하시겠습니까?"],
  "직무 이해": ["센터운영 직무에서 가장 중요한 역량은 무엇이라고 생각하십니까?", "입사 후 1년 동안 무엇을 하고 싶으십니까?"],
  인성: ["본인의 단점은 무엇이고 어떻게 보완하고 있습니까?", "가장 힘들었던 순간과 그것을 버틴 방법을 말씀해 주십시오.", "주변 사람들은 지원자를 어떤 사람이라고 말합니까?"],
};

function demoQuestions(hist, m) {
  const used = new Set(hist.asked);
  const out = hist.retry.slice(0, 2).map((r) => ({ type: r.type, q: `다시 여쭙겠습니다. ${r.q.replace(/^다시 여쭙겠습니다\.\s*/, "")} 결론부터 말씀해 주십시오.`, rephrase_of: r.id }));
  const pick = (types, n) => {
    const order = [...types].sort((a, b) => hist.typeCounts[a] - hist.typeCounts[b]);
    for (let i = 0; n > 0 && i < 50; i++) {
      const t = order[i % order.length];
      const q = BANK[t].find((x) => !used.has(x) && !out.some((o) => o.q === x));
      if (q) {
        out.push({ type: t, q, rephrase_of: "" });
        n--;
      }
    }
  };
  pick(JOB_TYPES, m.job - out.filter((o) => JOB_TYPES.includes(o.type)).length);
  pick(PERSON_TYPES, m.person - out.filter((o) => PERSON_TYPES.includes(o.type)).length);
  // 질문 은행이 바닥나면 번호를 붙여 겹치지 않게
  while (out.length < m.variable) out.push({ type: "문제 해결", q: `최근에 스스로 개선한 일 하나를 말씀해 주십시오. (${hist.asked.length + out.length})`, rephrase_of: "" });
  return out;
}

function demoEvaluate(items) {
  return {
    summary: "데모 평가입니다(AI 키 없음). 길이와 시간만 보고 판단했습니다.",
    items: items.map((it) => {
      const short = it.answer.length < 40 || it.seconds < 15;
      return {
        id: it.id,
        fit: short ? "부족" : "보통",
        fit_note: short ? "답변이 너무 짧습니다." : "길이는 충분합니다.",
        conclusion_first: /^(저는|제|네|결론|핵심)/.test(it.answer.trim()),
        conclusion_note: "첫 문장으로만 판단했습니다.",
        stuck_points: /(그|어|음)\s*(그|어|음)/.test(it.answer) ? ["말이 끊긴 곳이 있습니다."] : [],
        fact_issues: [],
        time_note: `${it.seconds}초`,
        tip: "결론 한 문장 → 근거 경험 → 입사 후 연결 순서로 말해 보십시오.",
        needs_retry: short,
      };
    }),
  };
}
