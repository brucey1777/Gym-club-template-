alter table review_folders
  add column if not exists share_token text unique default encode(gen_random_bytes(16), 'hex');
