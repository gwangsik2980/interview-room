# GWANG 면접실 (interview-room)

AI 면접관이 질문하고 음성으로 답하며, 회차별 기록으로 약한 부분을 찾는 면접 연습 웹앱. 회장 한 사람 전용.

- 화면: `public/index.html` 한 파일 (자료 / 면접 / 기록 3분할, 폰은 면접만)
- API: `api/app.js` 한 개 (`POST /api/app {action}`), 규칙 `lib/interview.js`, AI `lib/ai.js`, 저장 `lib/store.js`, 로그인 `lib/auth.js`
- 음성: 브라우저 내장 Web Speech API (받아 적기 ko-KR, 읽어 주기). 크롬·엣지 권장
- 개인 자료는 저장소에 넣지 않는다. 자료는 앱의 '자료 설정'에서 붙여넣어 DB에 저장된다

## 환경 변수 (`.env.example`)

| 이름 | 뜻 |
|---|---|
| `APP_PASSWORD` | 로그인 비밀번호. 바꾸면 모든 로그인이 풀린다 |
| `DATABASE_URL` | Neon Postgres. 없으면 `.data/store.json` (로컬 전용) |
| `ANTHROPIC_API_KEY` | 없으면 데모 면접관 |
| `CLAUDE_MODEL` | 기본 `claude-opus-5-5` |

## 명령

- `npm install` → `npm run dev` (http://localhost:3300, `.env` 읽음)
- `npm test` — 회차 규칙(겹침 없음, 막힌 질문 재출제, 로그인) 확인

## 배포

Vercel(Hobby)이 `main`을 배포. 함수 지역 `sin1`(Neon 싱가포르와 맞춤), 함수 최대 300초.
