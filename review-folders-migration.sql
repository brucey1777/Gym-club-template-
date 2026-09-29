create table if not exists review_folders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references review_projects(id) on delete cascade,
  parent_id uuid references review_folders(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create index if not exists review_folders_project_id_idx on review_folders(project_id);
create index if not exists review_folders_parent_id_idx on review_folders(parent_id);

alter table review_videos add column if not exists folder_id uuid references review_folders(id) on delete cascade;
create index if not exists review_videos_folder_id_idx on review_videos(folder_id);

alter table review_folders enable row level security;
