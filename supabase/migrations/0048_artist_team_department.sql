-- artist_team_members already had a free-text `role` column meant for a
-- specific job title ("FOH Engineer", "Tour Manager" — see its own
-- comment in 0027_artist_privacy.sql), but the UI never collected it,
-- and there was no way to group an artist's own crew by department the
-- way the tour-wide roster already is (DirectoryScreen). Reuses the
-- existing tour_department enum rather than inventing a parallel one —
-- an artist's own production team is still "production," just scoped to
-- that artist instead of the whole tour.
alter table artist_team_members
  add column department tour_department;
