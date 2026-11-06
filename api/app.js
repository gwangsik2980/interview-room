// API 하나로 모든 동작을 받는다: POST /api/app  { action, ...값 }
import * as store from "../lib/store.js";
import * as ai from "../lib/ai.js";
import { isAuthed, logIn, logOutCookie, httpError } from "../lib/auth.js";
import { DEFAULT_SETTINGS, applyEvaluation, buildRound, history, mix, newId, roundStats } from "../lib/interview.js";

const DOC_KEYS = ["resume", "cover", "jd"];
const MAX_DOC = 80_000; // 글자. 문서 하나가 이보다 길면 거절
const MAX_ANSWER = 8_000;

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw httpError(400, "요청 형식이 올바르지 않아요.");
  }
}

const companiesKey = "companies";
const companyKey = (id) => `company:${id}`;
const roundsKey = (id) => `rounds:${id}`;

async function loadCompany(id) {
  const c = await store.get(companyKey(String(id)));
  if (!c) throw httpError(404, "회사를 찾지 못했어요. 자료 설정에서 다시 골라 주세요.");
  return c;
}

async function loadRounds(companyId) {
  return (await store.get(roundsKey(companyId))) || [];
}

function findItem(rounds, roundId, itemId) {
  const round = rounds.find((r) => r.id === roundId);
  const item = round?.items.find((it) => it.id === itemId);
  if (!item) throw httpError(404, "질문을 찾지 못했어요. 새로고침해 주세요.");
  return { round, item };
}

const withStats = (rounds) => rounds.map((r) => ({ ...r, stats: roundStats(r) }));
const text = (v, max) => String(v ?? "").slice(0, max);
const seconds = (v) => Math.min(3600, Math.max(0, Math.round(Number(v) || 0)));

const actions = {
  async me() {
    return { ok: true, demo: ai.demo };
  },

  async companies() {
    return { companies: (await store.get(companiesKey)) || [] };
  },

  async getCompany({ id }) {
    return { company: await loadCompany(id), rounds: withStats(await loadRounds(id)) };
  },

  async saveCompany({ id, name, docs = {}, settings = {} }) {
    name = text(name, 60).trim();
    if (!name) throw httpError(400, "회사 이름을 적어 주세요.");
    const clean = {};
    for (const k of DOC_KEYS) {
      if (String(docs[k] ?? "").length > MAX_DOC) throw httpError(400, `문서 하나는 ${MAX_DOC.toLocaleString()}자까지 넣을 수 있어요.`);
      clean[k] = String(docs[k] ?? "");
    }
    const m = mix({ ...DEFAULT_SETTINGS, ...settings });
    const company = {
      id: id || newId(),
      name,
      docs: clean,
      settings: { variable: m.variable, jobPercent: Math.min(100, Math.max(0, Math.round(Number(settings.jobPercent ?? DEFAULT_SETTINGS.jobPercent)))) },
      updatedAt: new Date().toISOString(),
    };
    if (id) await loadCompany(id); // 없는 id로 덮어쓰지 않게
    await store.set(companyKey(company.id), company);
    const list = ((await store.get(companiesKey)) || []).filter((c) => c.id !== company.id);
    await store.set(companiesKey, [...list, { id: company.id, name }]);
    return { company };
  },

  async startRound({ companyId }) {
    const company = await loadCompany(companyId);
    const rounds = await loadRounds(company.id);
    const active = rounds.find((r) => r.status === "active");
    if (active) return { round: active };
    const done = rounds.filter((r) => r.status === "done");
    const generated = await ai.generateQuestions(company, history(done), mix(company.settings));
    const round = buildRound(done, company, generated);
    rounds.push(round);
    await store.set(roundsKey(company.id), rounds);
    return { round };
  },

  /** 답변 자동 저장. part가 "followUp"이면 꼬리질문 답변. */
  async saveAnswer({ companyId, roundId, itemId, part, answer, seconds: secs }) {
    const rounds = await loadRounds(String(companyId));
    const { round, item } = findItem(rounds, roundId, itemId);
    if (round.status !== "active") throw httpError(409, "이미 끝난 회차예요.");
    const target = part === "followUp" ? item.followUp : item;
    if (!target) throw httpError(409, "꼬리질문이 없어요.");
    target.answer = text(answer, MAX_ANSWER);
    target.seconds = seconds(secs);
    await store.set(roundsKey(String(companyId)), rounds);
    return { item };
  },

  /** 꼬리질문은 질문당 한 번만 정한다. 이미 정했으면 그대로 돌려준다. */
  async followUp({ companyId, roundId, itemId }) {
    const company = await loadCompany(companyId);
    const rounds = await loadRounds(company.id);
    const { item } = findItem(rounds, roundId, itemId);
    if (item.followUp !== null || !item.answer.trim()) return { item };
    const q = await ai.followUp(company, item);
    item.followUp = q ? { q, answer: "", seconds: 0 } : false;
    await store.set(roundsKey(company.id), rounds);
    return { item };
  },

  /** 끝내기: 답한 질문만 평가해서 저장. 하나도 안 답했으면 회차를 지운다. */
  async finishRound({ companyId, roundId }) {
    const company = await loadCompany(companyId);
    const rounds = await loadRounds(company.id);
    const round = rounds.find((r) => r.id === roundId);
    if (!round) throw httpError(404, "회차를 찾지 못했어요.");
    if (round.status === "done") return { round, rounds: withStats(rounds) };
    if (!round.items.some((it) => it.answer.trim())) {
      const rest = rounds.filter((r) => r.id !== roundId);
      await store.set(roundsKey(company.id), rest);
      return { round: null, rounds: withStats(rest) };
    }
    round.items = round.items.filter((it) => it.answer.trim()); // 안 한 질문은 다음 회차에 다시 나올 수 있게 뺀다
    applyEvaluation(rounds, round, await ai.evaluate(company, round.items));
    await store.set(roundsKey(company.id), rounds);
    return { round, rounds: withStats(rounds) };
  },

  async setRetry({ companyId, roundId, itemId, retry }) {
    const rounds = await loadRounds(String(companyId));
    findItem(rounds, roundId, itemId).item.retry = Boolean(retry);
    await store.set(roundsKey(String(companyId)), rounds);
    return { rounds: withStats(rounds) };
  },
};

export default async function handler(req, res) {
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method !== "POST") return send(405, { error: "POST만 받아요." });
    const body = await readBody(req);
    if (body.action === "login") return send(200, { ok: true }, { "Set-Cookie": await logIn(req, body.password) });
    if (body.action === "logout") return send(200, { ok: true }, { "Set-Cookie": logOutCookie(req) });
    if (!isAuthed(req)) return send(401, { error: "로그인이 필요해요." });
    const fn = Object.hasOwn(actions, body.action) ? actions[body.action] : null;
    if (!fn) return send(400, { error: "모르는 요청이에요." });
    return send(200, await fn(body));
  } catch (err) {
    if (err.status) return send(err.status, { error: err.message });
    console.error("[api]", err);
    return send(500, { error: "서버 오류가 났어요. 잠시 뒤 다시 시도해 주세요." });
  }
}
