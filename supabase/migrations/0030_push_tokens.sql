-- Device push tokens, one row per (user, device). Self-only from the
-- client — deliberately no "readable by manager" policy, a push token
-- isn't tour data and no one but the device owner (and, internally,
-- send-notification running as service_role) ever needs it.

create table push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  expo_push_token text not null,
  device_info text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, expo_push_token)
);

alter table push_tokens enable row level security;

create policy "push_tokens readable by self" on push_tokens
  for select using (user_id = auth.uid());
create policy "push_tokens insertable by self" on push_tokens
  for insert with check (user_id = auth.uid());
create policy "push_tokens updatable by self" on push_tokens
  for update using (user_id = auth.uid());
create policy "push_tokens deletable by self" on push_tokens
  for delete using (user_id = auth.uid());

-- Person-scoped, not tour-scoped — no completion-lock trigger, same
-- reasoning as passport_visa_info (0024).
