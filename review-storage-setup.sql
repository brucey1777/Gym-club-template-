-- Run this AFTER review-schema.sql, also in the SQL Editor.
-- Creates a private storage bucket for video files. No public policies are
-- added — all uploads/downloads go through signed URLs minted by our
-- Netlify functions using the service-role key.

insert into storage.buckets (id, name, public)
values ('videos', 'videos', false)
on conflict (id) do nothing;
