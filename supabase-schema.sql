-- Pole Mapper Supabase 스키마
-- Supabase 대시보드 > SQL Editor에서 실행

create table if not exists gus (
  code text primary key,
  name text not null unique,
  updated_at timestamptz not null
);

create table if not exists dongs (
  gu_name text not null,
  dong text not null,
  updated_at timestamptz not null,
  primary key (gu_name, dong)
);
create index if not exists idx_dongs_gu on dongs(gu_name);

create table if not exists poles (
  id text primary key,
  lat double precision not null,
  lng double precision not null,
  gu text not null default '',
  dong text not null default '',
  timestamp text not null,
  level text not null default '',
  photo_path text
);
create index if not exists idx_poles_gu_dong on poles(gu, dong);
create index if not exists idx_poles_timestamp on poles(timestamp);
