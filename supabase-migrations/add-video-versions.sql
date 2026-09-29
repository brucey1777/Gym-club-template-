-- Run this once in the Supabase SQL editor

ALTER TABLE review_videos ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS review_video_versions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id    UUID        NOT NULL REFERENCES review_videos(id) ON DELETE CASCADE,
  version     INTEGER     NOT NULL,
  storage_path TEXT       NOT NULL,
  thumbnail_path TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS review_video_versions_video_id ON review_video_versions(video_id);
