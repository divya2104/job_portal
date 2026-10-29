-- Live UI (PLAN.md §1): stream run counts and pipeline events. Realtime applies the same RLS select policies,
-- so each subscriber only receives their own rows.
alter publication supabase_realtime add table public.runs, public.events;
