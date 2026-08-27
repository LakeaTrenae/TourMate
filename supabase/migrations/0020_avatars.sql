-- Profile picture storage. Unlike documents/receipts, avatars are public:
-- anyone who shares a tour with you already sees your name/role/contact
-- info in the People directory, and a profile picture carries no
-- sensitive content — so this bucket is public (fast, cacheable image
-- URLs, no signed-URL round trip needed every time an avatar renders)
-- while writes stay locked to the owning user.
--
-- Path convention: `<user_id>/avatar` (no extension needed — contentType
-- is stored with the object and served correctly regardless).

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "avatars are publicly readable" on storage.objects
  for select using (bucket_id = 'avatars');

create policy "users can upload their own avatar" on storage.objects
  for insert with check (
    bucket_id = 'avatars' and (string_to_array(name, '/'))[1] = auth.uid()::text
  );

create policy "users can update their own avatar" on storage.objects
  for update using (
    bucket_id = 'avatars' and (string_to_array(name, '/'))[1] = auth.uid()::text
  );

create policy "users can delete their own avatar" on storage.objects
  for delete using (
    bucket_id = 'avatars' and (string_to_array(name, '/'))[1] = auth.uid()::text
  );