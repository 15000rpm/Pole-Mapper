# 로그인 기능 추가 구현 계획

## 1. 사전 준비 (Supabase 대시보드)

- Authentication → Providers → **Email 활성화**
- (선택) 휴대전화 인증 추가 (Twilio 연동 필요)

---

## 2. DB 스키마 변경 (`supabase-schema.sql`)

```sql
-- profiles 테이블
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'user' check (role in ('admin', 'user')),
  phone text,
  created_at timestamptz not null default now()
);

-- poles RLS
alter table poles enable row level security;

create policy "인증된 사용자 poles 조회"
  on poles for select
  to authenticated
  using (true);

create policy "인증된 사용자 poles 추가"
  on poles for insert
  to authenticated
  with check (true);

create policy "본인 poles 삭제 또는 admin"
  on poles for delete
  to authenticated
  using (
    auth.uid() = (select user_id from profiles where id = poles.id)
    or (select role from profiles where id = auth.uid()) = 'admin'
  );

-- gus/dongs RLS (인증된 사용자 SELECT만 허용)
alter table gus enable row level security;
alter table dongs enable row level security;

create policy "인증된 사용자 gus 조회"
  on gus for select
  to authenticated
  using (true);

create policy "인증된 사용자 dongs 조회"
  on dongs for select
  to authenticated
  using (true);

-- 신규 회원가입 시 profiles 자동 생성 트리거
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, role)
  values (new.id, 'user');
  return new;
end;
$$ language plpgsql security definer;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

---

## 3. 환경 변수 (`.env`, `server/.env`, `.env.example`)

| 변수 | 용도 |
|------|------|
| `VITE_SUPABASE_URL` | 프론트엔드 Supabase URL |
| `VITE_SUPABASE_ANON_KEY` | 프론트엔드 Supabase anon key |
| `SUPABASE_ANON_KEY` | 서버 JWT 검증용 anon key |

> anon key는 RLS를 따르므로 클라이언트 노출이 안전합니다.

---

## 4. 서버 측 변경

### `server/auth.js` (신규)

- anon key 기반 Supabase 클라이언트 생성
- `requireAuth` 미들웨어 — `Authorization: Bearer <token>` 토큰 검증 → `req.user` 주입
- `requireRole(role)` 미들웨어 — 역할 확인

### `server/db.js` 변경

- `createProfile(userId, role, phone)`
- `getProfile(userId)`
- `updateProfileRole(userId, role)`
- `getAllProfiles()`

### `server/index.js` 변경

**신규 API 라우트:**
| 메서드 | 경로 | 설명 | 권한 |
|--------|------|------|------|
| POST | `/api/auth/signup` | 회원가입 (email, password, phone?) | 공개 |
| POST | `/api/auth/login` | 로그인 → JWT 토큰 반환 | 공개 |
| GET | `/api/auth/me` | 현재 사용자 정보 | 인증 |
| GET | `/api/auth/users` | 사용자 목록 | admin |
| PATCH | `/api/auth/users/:id/role` | 역할 변경 | admin |

**기존 라우트 미들웨어 적용:**
| 라우트 | 권한 |
|--------|------|
| GET/POST `/api/poles` | `requireAuth` |
| DELETE `/api/poles/:id` | `requireAuth` + 본인 데이터 또는 admin |
| GET `/api/gus` | `requireAuth` |
| GET `/api/dongs` | `requireAuth` |
| GET `/api/reverse-geocode` | `requireAuth` |
| GET `/api/all-dongs` | `requireAuth` |

---

## 5. 프론트엔드 변경

### `src/lib/supabase.js` (신규)

```js
import { createClient } from '@supabase/supabase-js';
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);
```

### `src/App.jsx` 변경

**인증 상태 관리:**
- `user` state — Supabase auth 사용자 객체
- `profile` state — profiles 테이블에서 가져온 역할 정보
- `useEffect` → `supabase.auth.onAuthStateChange()` 리스닝
- 컴포넌트 마운트 시 `supabase.auth.getSession()`으로 기존 세션 복원

**조건부 렌더링:**
- `user === null` → LoginForm / RegisterForm 표시
- `user !== null` → 기존 지도 앱 + 상단 UserMenu

**LoginForm:**
- 이메일 + 비밀번호 입력
- `supabase.auth.signInWithPassword({ email, password })`

**RegisterForm:**
- 이메일 + 비밀번호 + (선택) 전화번호 입력
- `supabase.auth.signUp({ email, password, options: { data: { phone } } })`

**UserMenu (상단):**
- 사용자 이메일/역할 표시
- 로그아웃 버튼 (`supabase.auth.signOut()`)
- admin → 사용자관리 링크

**UserManagement (admin 전용 패널):**
- 사용자 목록 조회 (`GET /api/auth/users`)
- 역할 드롭다운으로 변경 (`PATCH /api/auth/users/:id/role`)

**API 호출 수정 (모든 fetch):**
```js
const { data: { session } } = await supabase.auth.getSession();
fetch('/api/poles', {
  headers: { Authorization: `Bearer ${session?.access_token}` }
});
```

---

## 6. 파일 변경 요약

| 파일 | 작업 |
|------|------|
| `supabase-schema.sql` | profiles 테이블 + RLS + 트리거 추가 |
| `.env` / `server/.env` / `.env.example` | 환경 변수 3개 추가 |
| `server/auth.js` | **신규** — anon 클라이언트 + JWT 미들웨어 |
| `server/db.js` | profiles CRUD 함수 추가 |
| `server/index.js` | auth 라우트 + 기존 라우트에 미들웨어 적용 |
| `src/lib/supabase.js` | **신규** — 클라이언트 Supabase 인스턴스 |
| `src/App.jsx` | 인증 UI + 상태 관리 + API 토큰 헤더 추가 |

---

## 7. 구현 순서

1. **Supabase 대시보드**에서 Email auth 활성화
2. **SQL 스키마** 업데이트 (profiles + RLS + 트리거)
3. **환경 변수** 추가
4. **`server/auth.js`** 생성
5. **`server/db.js`**에 profiles 함수 추가
6. **`server/index.js`**에 auth 라우트 + 미들웨어 적용
7. **`src/lib/supabase.js`** 생성
8. **`src/App.jsx`**에 인증 UI + 토큰 헤더 추가
9. **테스트** — 회원가입, 로그인, API 접근, 권한 확인
