-- In-app chat: one group conversation per tour (every effective tour
-- member, auto-resolved — no membership rows to keep in sync as roles
-- change) plus 1:1 direct messages between two people who share at
-- least one tour. Mirrors Master Tour/WhatsApp's two shapes rather than
-- inventing a channel system.
--
-- Deliberately NOT attached to the completion-lock trigger
-- (0005_tour_completion_lock.sql) — chat is conversation, not tour
-- data; people should still be able to discuss a wrapped tour (settling
-- up, a debrief) the same way audit_log stays append-only/unlocked.
create type conversation_type as enum ('tour_group', 'direct');

create table conversations (
  id uuid primary key default gen_random_uuid(),
  type conversation_type not null,
  tour_id uuid references tours (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint tour_group_has_tour check (type != 'tour_group' or tour_id is not null),
  constraint direct_has_no_tour check (type != 'direct' or tour_id is null)
);

-- One group conversation per tour, ever — get_or_create_tour_conversation
-- below relies on this to be idempotent.
create unique index conversations_tour_group_unique on conversations (tour_id) where type = 'tour_group';

-- Dual purpose, direct conversations only need it for real: (1) WHO is in
-- a direct conversation (tour_group access is computed via is_tour_member,
-- never via rows here) and (2) every participant's own last_read_at, used
-- by both conversation types for unread counts — a tour_group chat gets
-- a row here lazily, the first time each member actually opens it.
create table conversation_participants (
  conversation_id uuid not null references conversations (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id) on delete cascade,
  sender_id uuid not null references profiles (id),
  body text not null,
  created_at timestamptz not null default now()
);

create index messages_conversation_id_idx on messages (conversation_id, created_at);

-- ============================================================================
-- HELPERS (security-definer, same reasoning as every other cross-table
-- RLS check in this schema — see effective_tour_role/is_tour_member,
-- 0001_init.sql — a plain correlated subquery inlined directly into a
-- policy is the classic way to trigger RLS recursion; a stable function
-- sidesteps that entirely).
-- ============================================================================

-- A tour_group conversation is accessible to any effective tour member
-- (crew included — chat was never a manager-tier feature); a direct
-- conversation is accessible only to its two seeded participants.
create or replace function can_access_conversation(p_conversation_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case c.type
    when 'tour_group' then is_tour_member(c.tour_id, p_user_id)
    else exists (
      select 1 from conversation_participants cp
      where cp.conversation_id = c.id and cp.user_id = p_user_id
    )
  end
  from conversations c
  where c.id = p_conversation_id;
$$;

-- Any tour where both users are effective members (org-inherited role or
-- a tour_members override — same fallback effective_tour_role itself
-- does) — used both to authorize starting a DM and to pick a tourId for
-- send-notification's own "already on this tour together" check.
create or replace function shared_tour_id(p_user_a uuid, p_user_b uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select t.id from tours t
  where effective_tour_role(t.id, p_user_a) is not null
    and effective_tour_role(t.id, p_user_b) is not null
  limit 1;
$$;

-- Idempotent: returns the existing group conversation for this tour, or
-- creates it on first access. Raises if the caller isn't actually a
-- member — same "fail loud, don't silently return nothing" convention
-- as the rest of this schema's security-definer RPCs.
create or replace function get_or_create_tour_conversation(p_tour_id uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_conv_id uuid;
begin
  if not is_tour_member(p_tour_id, auth.uid()) then
    raise exception 'Not a member of this tour.' using errcode = '42501';
  end if;

  select id into v_conv_id from conversations where type = 'tour_group' and tour_id = p_tour_id;
  if v_conv_id is not null then
    return v_conv_id;
  end if;

  insert into conversations (type, tour_id) values ('tour_group', p_tour_id)
  on conflict (tour_id) where type = 'tour_group' do nothing
  returning id into v_conv_id;

  if v_conv_id is null then
    -- Lost a race with a concurrent first-open — the row now exists,
    -- just not from this call.
    select id into v_conv_id from conversations where type = 'tour_group' and tour_id = p_tour_id;
  end if;

  return v_conv_id;
end;
$$;

-- Idempotent: returns the existing direct conversation between the
-- caller and p_other_user_id, or creates it. Requires the two to share
-- at least one tour — same bound send-notification already enforces,
-- kept consistent rather than allowing a DM relationship push
-- notifications can't then authorize.
create or replace function get_or_create_direct_conversation(p_other_user_id uuid)
returns table (conversation_id uuid, tour_id uuid)
language plpgsql security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_conv_id uuid;
  v_shared_tour uuid;
begin
  if v_me is null or p_other_user_id is null or v_me = p_other_user_id then
    raise exception 'Invalid participants.' using errcode = '22023';
  end if;

  v_shared_tour := shared_tour_id(v_me, p_other_user_id);
  if v_shared_tour is null then
    raise exception 'You do not share a tour with this person.' using errcode = '42501';
  end if;

  select cp1.conversation_id into v_conv_id
  from conversation_participants cp1
  join conversation_participants cp2 on cp2.conversation_id = cp1.conversation_id
  join conversations c on c.id = cp1.conversation_id
  where c.type = 'direct' and cp1.user_id = v_me and cp2.user_id = p_other_user_id
  limit 1;

  if v_conv_id is null then
    insert into conversations (type) values ('direct') returning id into v_conv_id;
    insert into conversation_participants (conversation_id, user_id) values (v_conv_id, v_me), (v_conv_id, p_other_user_id);
  end if;

  return query select v_conv_id, v_shared_tour;
end;
$$;

-- ============================================================================
-- RLS
-- ============================================================================
alter table conversations enable row level security;
alter table conversation_participants enable row level security;
alter table messages enable row level security;

create policy "conversations readable by participants" on conversations
  for select using (can_access_conversation(id, auth.uid()));

create policy "conversation_participants readable by fellow participants" on conversation_participants
  for select using (can_access_conversation(conversation_id, auth.uid()));

-- Only ever used by a participant upserting their OWN last_read_at (a
-- tour_group member's first-open row included) — direct conversations'
-- initial two rows are inserted by get_or_create_direct_conversation
-- under security definer, bypassing this entirely.
create policy "conversation_participants upsertable by self" on conversation_participants
  for insert with check (user_id = auth.uid() and can_access_conversation(conversation_id, auth.uid()));
create policy "conversation_participants updatable by self" on conversation_participants
  for update using (user_id = auth.uid());

create policy "messages readable by participants" on messages
  for select using (can_access_conversation(conversation_id, auth.uid()));
create policy "messages insertable by participants" on messages
  for insert with check (sender_id = auth.uid() and can_access_conversation(conversation_id, auth.uid()));

grant all on table public.conversations, public.conversation_participants, public.messages to anon, authenticated, service_role;

-- Realtime: new messages push to an open thread without polling. Not
-- added for conversations/conversation_participants — nothing in this
-- app's chat UI needs to react live to those, only to new messages.
alter publication supabase_realtime add table messages;
