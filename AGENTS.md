# Pole Mapper

전신주 위치 등록용 웹앱. React + Vite(프론트) + Express + Supabase(백엔드), OpenLayers 지도, VWorld API 기반.

## 명령어

- `npm run dev` — 클라이언트(vite) + 서버(`node --watch server/index.js`) 동시 실행
- `npm run dev:client` — 프론트만
- `npm run dev:server` — 백엔드만
- `npm run build` — 프로덕션 빌드
- `npm run lint` — oxlint

## 구조

- `src/App.jsx` — 전체 UI + 지도 로직이 한 파일에 있음 (지도, GPS, 사진 등록, 목록). 서버 `/api/poles` API 호출
- `server/index.js` — Express REST API (`/api/gus`, `/api/dongs`, `/api/poles` CRUD, `/uploads` 정적 서빙)
- `server/db.js` — @supabase/supabase-js 클라이언트 (gus/dongs/poles 테이블, 전부 async)
- `server/vworld.js` — VWorld `GetFeature` 조회, 페이지네이션(최대 20페이지)
- `supabase-schema.sql` — Supabase SQL Editor에서 실행할 스키마
- `vite.config.js` — HTTPS 필수 (`~/.vite-key.pem`, `~/.vite-cert.pem` 요구), `/api`, `/uploads` 프록시 → :4000

## 환경 설정 (.env)

`VWORLD_API_KEY`, `VWORLD_DOMAIN=localhost`, `PORT=4000`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (서버용 `.env`)

## 현재 상태 (진행 중인 작업)

- 데이터베이스는 Supabase (Postgres) 사용. 기존 better-sqlite3는 제거됨.
  - 스키마는 `supabase-schema.sql`을 SQL Editor에서 실행해야 함
  - 서버에서 `SUPABASE_SERVICE_ROLE_KEY`를 사용 (서버가 곧 신뢰 경계)
- 클라이언트는 `/api/poles` API로 CRUD (사진은 multer로 `server/uploads/`에 저장, base64/loccalStorage 제거됨)
- `src/App.jsx:16`에 VWorld API 키가 하드코딩됨 → `import.meta.env.VITE_VWORLD_API_KEY`로 교체 필요 (키는 커밋하지 말 것)
- 위치 결정 우선순위: EXIF GPS → 브라우저 GPS → 마지막 알려진 위치
- dev용 VWorld 키는 `VITE_VWORLD_API_KEY`로도 넘길 수 있음 (`server/vworld.js`에서 서버 키에 대해 폴백)

## 주의사항

- geolocation/카메라 때문에 dev 서버는 HTTPS가 반드시 필요함
- `/api/poles` POST는 multer(`photo` 필드)로 사진을 `server/uploads/`에 저장
- 구/동 데이터는 VWorld에서 24시간 TTL 캐시 (Supabase gus/dongs 테이블의 updated_at으로 판단)
- Supabase 테이블에 RLS가 기본 활성화되어 있으면 서비스 롤 키는 통과하지만, anon 키로 직접 접근은 RLS 정책 필요
- Git 저장소 아님
