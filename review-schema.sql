-- Run this once in Supabase SQL Editor (https://supabase.com/dashboard -> your project -> SQL Editor)

create extension if not exists "pgcrypto";

create table if not exists review_projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists review_videos (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references review_projects(id) on delete cascade,
  filename text not null,
  storage_path text not null,
  share_token text unique not null default encode(gen_random_bytes(16), 'hex'),
  created_at timestamptz not null default now()
);

create table if not exists review_comments (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references review_videos(id) on delete cascade,
  timestamp_seconds numeric not null default 0,
  body text not null,
  author_name text not null default 'Reviewer',
  status text not null default 'open' check (status in ('open', 'done')),
  created_at timestamptz not null default now()
);

create index if not exists review_videos_project_id_idx on review_videos(project_id);
create index if not exists review_comments_video_id_idx on review_comments(video_id);

-- All access goes through Netlify functions using the service-role key, which
-- bypasses RLS. We still enable RLS with no policies so the tables are not
-- reachable directly via the public REST API with the publishable key.
alter table review_projects enable row level security;
alter table review_videos enable row level security;
alter table review_comments enable row level security;
