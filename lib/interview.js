// 회차 규칙: 질문 구성, 겹침 막기, 다시 연습 표시. AI 없이도 돌아가는 순수 함수만 둔다.
import { randomUUID } from "node:crypto";

export const JOB_TYPES = ["현장 운영", "인력 관리", "문제 해결", "협업", "안전·품질", "직무 이해"];
export const PERSON_TYPES = ["인성"];
export const FIXED_TYPES = ["자기소개", "지원동기"];

export const DEFAULT_SETTINGS = { variable: 7, jobPercent: 70 };

export const newId = () => randomUUID().slice(0, 8);

export function fixedItems(companyName) {
  return [
    { kind: "fixed", type: "자기소개", q: "1분 동안 자기소개를 해 주십시오." },
    { kind: "fixed", type: "지원동기", q: `${companyName}에 지원하신 동기를 말씀해 주십시오.` },
  ];
}

/** 변동 질문 수를 직무/인성으로 나눈다. 기본 7개 → 직무 5, 인성 2 (70:30). */
export function mix(settings = {}) {
  const variable = clamp(Math.round(settings.variable ?? DEFAULT_SETTINGS.variable), 6, 8);
  const jobPercent = clamp(Math.round(settings.jobPercent ?? DEFAULT_SETTINGS.jobPercent), 0, 100);
  const job = Math.round((variable * jobPercent) / 100);
  return { variable, job, person: variable - job };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
const norm = (s) => String(s).replace(/[\s.,?!·'"“”‘’~]/g, "");

/** 지난 회차까지 나온 질문, 유형별 출제 수, 다시 연습할 질문. */
export function history(rounds) {
  const asked = [];
  const typeCounts = Object.fromEntries([...JOB_TYPES, ...PERSON_TYPES].map((t) => [t, 0]));
  const retry = [];
  for (const r of rounds) {
    for (const it of r.items) {
      if (it.kind === "fixed") continue;
      asked.push(it.q);
      if (it.type in typeCounts) typeCounts[it.type] += 1;
      if (it.retry) retry.push({ id: it.id, roundNo: r.no, type: it.type, q: it.q });
    }
  }
  return { asked, typeCounts, retry };
}

/**
 * AI(또는 데모)가 낸 변동 질문을 검사해 회차를 만든다.
 * 지난 질문과 글자가 같은 질문, 모르는 유형, 다시 연습 대상이 아닌 rephraseOf는 버린다.
 */
export function buildRound(rounds, company, generated) {
  const hist = history(rounds);
  const seen = new Set(hist.asked.map(norm));
  const retryIds = new Set(hist.retry.map((r) => r.id));
  const { variable } = mix(company.settings);
  const items = [];
  for (const g of generated) {
    const q = String(g.q || "").trim();
    if (!q || seen.has(norm(q))) continue;
    if (![...JOB_TYPES, ...PERSON_TYPES].includes(g.type)) continue;
    const rephraseOf = retryIds.has(g.rephrase_of) ? g.rephrase_of : null;
    if (rephraseOf) retryIds.delete(rephraseOf);
    seen.add(norm(q));
    items.push({ kind: PERSON_TYPES.includes(g.type) ? "person" : "job", type: g.type, q, rephraseOf });
    if (items.length === variable) break;
  }
  if (items.length < 6) throw Object.assign(new Error("질문을 충분히 만들지 못했어요. 다시 시작해 주세요."), { status: 502 });
  return {
    id: newId(),
    no: (rounds.at(-1)?.no ?? 0) + 1,
    date: new Date().toISOString(),
    status: "active",
    items: [...fixedItems(company.name), ...items].map((it) => ({
      id: newId(),
      ...it,
      answer: "",
      seconds: 0,
      followUp: null,
      evaluation: null,
      retry: false,
    })),
    summary: null,
  };
}

/** 답변 시간 기준(초). 자기소개는 1분 안팎, 나머지는 30초~1분 30초. */
export function timeLabel(item) {
  const s = item.seconds + (item.followUp?.seconds || 0);
  if (!s) return "기록 없음";
  const [lo, hi] = item.type === "자기소개" ? [45, 80] : item.type === "지원동기" ? [30, 80] : [25, 90];
  return s < lo ? "짧음" : s > hi ? "김" : "적당";
}

/**
 * 평가 결과를 회차에 넣고, 표현을 바꿔 다시 낸 질문은 원래 질문의 '다시 연습' 표시를 내린다
 * (다시 막혔으면 새 질문 쪽에 표시가 남는다).
 */
export function applyEvaluation(rounds, round, evaluation) {
  const byId = new Map(evaluation.items.map((e) => [e.id, e]));
  for (const it of round.items) {
    const e = byId.get(it.id);
    const answered = Boolean(it.answer.trim());
    it.evaluation = answered && e ? { ...e, time: timeLabel(it) } : null;
    it.retry = answered ? Boolean(e?.needs_retry) : false;
    if (answered && it.rephraseOf) {
      for (const r of rounds) for (const old of r.items) if (old.id === it.rephraseOf) old.retry = false;
    }
  }
  round.summary = evaluation.summary;
  round.status = "done";
}

/** 회차 비교용 숫자: 평균 답변 시간, 다시 연습 수, 결론 먼저 비율. */
export function roundStats(round) {
  const answered = round.items.filter((it) => it.answer.trim());
  const secs = answered.map((it) => it.seconds + (it.followUp?.seconds || 0)).filter(Boolean);
  const evals = answered.map((it) => it.evaluation).filter(Boolean);
  return {
    answered: answered.length,
    total: round.items.length,
    avgSeconds: secs.length ? Math.round(secs.reduce((a, b) => a + b, 0) / secs.length) : 0,
    retry: round.items.filter((it) => it.retry).length,
    conclusionFirst: evals.length ? Math.round((evals.filter((e) => e.conclusion_first).length / evals.length) * 100) : null,
  };
}
