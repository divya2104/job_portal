-- Job portal schema (PLAN.md §2). Every user-owned table has RLS.

-- ───────────── settings & access ─────────────

create table app_settings (
  id boolean primary key default true check (id),            -- singleton
  max_sources_per_run int not null default 25,
  max_runs_per_day int not null default 3,
  max_evals_per_run int not null default 30,
  firecrawl_monthly_credit_budget int not null default 1000,
  llm_monthly_budget_usd numeric(10,2) not null default 20,
  throttle_ms_per_domain int not null default 2000,
  firecrawl_max_pages int not null default 50,
  max_users int not null default 1
);
insert into app_settings default values;

create table allowed_emails (
  email text primary key check (email = lower(email)),
  added_at timestamptz not null default now()
);

-- ───────────── profiles ─────────────

create table profiles (
  user_id uuid primary key references auth.users on delete cascade,
  email text not null,
  is_admin boolean not null default false,
  onboarded_at timestamptz,
  onboarding_step int not null default 1,
  target_titles text[] not null default '{}' check (cardinality(target_titles) <= 3),
  title_keywords jsonb not null default '{"positive":[],"negative":[]}',
  cities text[] not null default '{}',
  accepts_remote boolean not null default false,
  accepts_hybrid boolean not null default true,
  exp_min int,
  exp_max int,
  pay_currency text,
  pay_min_annual numeric,
  authorized_in text[] not null default '{}',
  needs_sponsorship boolean not null default false,
  profile_version int not null default 1,
  created_at timestamptz not null default now()
);

create function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from profiles where user_id = auth.uid()), false)
$$;

-- profile row is created with the auth user
create function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (user_id, email) values (new.id, new.email);
  insert into user_limits (user_id) values (new.id);
  return new;
end $$;

-- ───────────── user-owned tables ─────────────

create table cvs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  storage_path text not null,
  file_name text not null,
  parsed jsonb not null,
  text text not null,
  confirmed_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index cvs_one_active on cvs (user_id) where is_active;

create table answer_bank (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  question_key text not null,
  question_label text not null,
  answer text not null,
  source text not null check (source in ('onboarding','form','settings')),
  updated_at timestamptz not null default now(),
  unique (user_id, question_key)
);

create table user_limits (
  user_id uuid primary key references auth.users on delete cascade,
  max_sources_per_run int,      -- null = use app_settings default
  max_runs_per_day int,
  max_evals_per_run int
);

-- ───────────── shared posting data ─────────────

create table sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  careers_url text not null unique,
  provider text not null check (provider in ('greenhouse','lever','ashby','smartrecruiters','workday','firecrawl')),
  provider_ref text,
  is_starter boolean not null default false,
  max_pages int not null default 50,
  blocked_until timestamptz
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  url_key text not null unique,
  apply_url text not null,
  source_url text,
  source_id uuid references sources on delete set null,
  external_id text,
  requisition_id text,
  company text,
  title text not null,
  title_norm text,
  location text,
  work_mode text,
  exp_min int,
  exp_max int,
  exp_quote text,
  salary jsonb,
  posted_at timestamptz,
  jd_text text,
  ats_questions jsonb,
  liveness text check (liveness in ('live','expired','uncertain')),
  liveness_checked_at timestamptz,
  fetched_at timestamptz,
  fetch_batch_id uuid
);

create table source_fetches (
  source_id uuid not null references sources on delete cascade,
  batch_id uuid not null,
  fetched_at timestamptz not null default now(),
  status text not null,
  job_ids uuid[] not null default '{}',
  credits_used int not null default 0,
  primary key (source_id, batch_id)
);

create table saved_companies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  source_id uuid not null references sources on delete cascade,
  active boolean not null default true,
  unique (user_id, source_id)
);

-- ───────────── runs & results (written by the worker) ─────────────

create table runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  batch_id uuid,
  trigger text not null check (trigger in ('schedule','adhoc','rescore')),
  adhoc_url text,
  status text not null default 'queued'
    check (status in ('queued','running','completed','completed_with_errors','failed')),
  counts jsonb not null default '{}',
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create table run_sources (
  run_id uuid not null references runs on delete cascade,
  source_id uuid not null references sources on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  status text not null check (status in ('ok','failed','blocked','skipped_quota','skipped_robots')),
  error text,
  jobs_found int not null default 0,
  primary key (run_id, source_id)
);

create table user_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  job_id uuid not null references jobs on delete cascade,
  first_run_id uuid references runs on delete set null,
  last_run_id uuid references runs on delete set null,
  status text not null check (status in (
    'discovered','extracted','extract_failed','live','expired','liveness_uncertain','unreachable',
    'duplicate','filtered_out','eval_pending','eval_failed','scored',
    'apply','review','discarded','needs_input','ready_to_submit','submitted')),
  reason_code text,
  reason_text text,
  evidence text,
  eval jsonb,
  total numeric(3,2),
  profile_version int,
  stale boolean not null default false,
  tailored_cv_path text,
  updated_at timestamptz not null default now(),
  unique (user_id, job_id)
);

create table applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  user_job_id uuid not null references user_jobs on delete cascade,
  form_snapshot jsonb not null default '[]',
  missing_fields text[] not null default '{}',
  opened_at timestamptz,
  submitted_at timestamptz
);

create table events (
  id bigserial primary key,
  user_id uuid not null references auth.users on delete cascade,
  run_id uuid references runs on delete cascade,
  user_job_id uuid references user_jobs on delete cascade,
  stage text not null,
  kind text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index events_run on events (run_id, id);

create table usage_ledger (
  id bigserial primary key,
  user_id uuid not null references auth.users on delete cascade,
  run_id uuid references runs on delete set null,
  kind text not null check (kind in ('firecrawl_credits','llm_input_tokens','llm_output_tokens')),
  model text,
  units bigint not null,
  cost_usd numeric(12,6) not null default 0,
  created_at timestamptz not null default now()
);

create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- Called after a role / CV / location / pay change: bump version, mark scores stale.
create function bump_profile_version() returns void
language sql security definer set search_path = public as $$
  update profiles set profile_version = profile_version + 1 where user_id = auth.uid();
  update user_jobs set stale = true
   where user_id = auth.uid()
     and (status in ('apply','review','needs_input','ready_to_submit')
          or (status = 'filtered_out' and reason_code in
              ('title_mismatch','location_mismatch','exp_above_range','exp_below_range')));
$$;

-- ───────────── RLS ─────────────

alter table app_settings   enable row level security;
alter table allowed_emails enable row level security;
alter table profiles       enable row level security;
alter table cvs            enable row level security;
alter table answer_bank    enable row level security;
alter table user_limits    enable row level security;
alter table sources        enable row level security;
alter table jobs           enable row level security;
alter table source_fetches enable row level security;
alter table saved_companies enable row level security;
alter table runs           enable row level security;
alter table run_sources    enable row level security;
alter table user_jobs      enable row level security;
alter table applications   enable row level security;
alter table events         enable row level security;
alter table usage_ledger   enable row level security;

create policy read on app_settings for select to authenticated using (true);
create policy admin_write on app_settings for update to authenticated using (is_admin()) with check (is_admin());

create policy admin_all on allowed_emails for all to authenticated using (is_admin()) with check (is_admin());

-- profiles: own row (admin may read for the users list); is_admin is not user-writable
create policy own_select on profiles for select to authenticated using (user_id = auth.uid() or is_admin());
create policy own_update on profiles for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke update on profiles from authenticated;
grant update (onboarded_at, onboarding_step, target_titles, title_keywords, cities, accepts_remote,
              accepts_hybrid, exp_min, exp_max, pay_currency, pay_min_annual, authorized_in,
              needs_sponsorship) on profiles to authenticated;

-- CV content and answers: owner only, no admin read
create policy own_all on cvs for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_all on answer_bank for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_all on saved_companies for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_all on applications for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy own_select on user_limits for select to authenticated using (user_id = auth.uid() or is_admin());
create policy admin_update on user_limits for update to authenticated using (is_admin()) with check (is_admin());

-- worker-written tables: read own, never write
create policy own_select on runs        for select to authenticated using (user_id = auth.uid() or is_admin());
create policy own_select on run_sources for select to authenticated using (user_id = auth.uid());
create policy own_select on user_jobs   for select to authenticated using (user_id = auth.uid());
create policy own_select on events      for select to authenticated using (user_id = auth.uid());
create policy own_select on usage_ledger for select to authenticated using (user_id = auth.uid() or is_admin());

-- shared
create policy read on sources for select to authenticated using (true);
create policy read_tracked on jobs for select to authenticated
  using (exists (select 1 from user_jobs uj where uj.job_id = jobs.id and uj.user_id = auth.uid()));
-- source_fetches: no policies → service role only

-- ───────────── storage ─────────────

insert into storage.buckets (id, name, public) values ('cvs', 'cvs', false), ('tailored', 'tailored', false);

create policy cvs_own on storage.objects for all to authenticated
  using (bucket_id = 'cvs' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'cvs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy tailored_own_read on storage.objects for select to authenticated
  using (bucket_id = 'tailored' and (storage.foldername(name))[1] = auth.uid()::text);

-- ───────────── starter companies (BACKEND_BLUEPRINT.md §3) ─────────────

insert into sources (name, careers_url, provider, provider_ref, is_starter) values
  ('Razorpay',   'https://job-boards.greenhouse.io/razorpaysoftwareprivatelimited', 'greenhouse', 'razorpaysoftwareprivatelimited', true),
  ('Groww',      'https://job-boards.greenhouse.io/groww',      'greenhouse', 'groww', true),
  ('Databricks', 'https://job-boards.greenhouse.io/databricks', 'greenhouse', 'databricks', true),
  ('Stripe',     'https://job-boards.greenhouse.io/stripe',     'greenhouse', 'stripe', true),
  ('Coinbase',   'https://job-boards.greenhouse.io/coinbase',   'greenhouse', 'coinbase', true),
  ('Druva',      'https://job-boards.greenhouse.io/druva',      'greenhouse', 'druva', true),
  ('CRED',       'https://jobs.lever.co/cred',   'lever', 'cred', true),
  ('Zeta',       'https://jobs.lever.co/zeta',   'lever', 'zeta', true),
  ('Paytm',      'https://jobs.lever.co/paytm',  'lever', 'paytm', true),
  ('Meesho',     'https://jobs.lever.co/meesho', 'lever', 'meesho', true),
  ('Swiggy',     'https://careers.smartrecruiters.com/swiggy',     'smartrecruiters', 'swiggy', true),
  ('Freshworks', 'https://careers.smartrecruiters.com/Freshworks', 'smartrecruiters', 'Freshworks', true),
  ('Sarvam',     'https://jobs.ashbyhq.com/sarvam', 'ashby', 'sarvam', true),
  ('Atlan',      'https://jobs.ashbyhq.com/atlan',  'ashby', 'atlan', true),
  ('Target',     'https://target.wd5.myworkdayjobs.com/targetcareers',             'workday', 'target/wd5/targetcareers', true),
  ('PwC',        'https://pwc.wd3.myworkdayjobs.com/Global_Experienced_Careers',   'workday', 'pwc/wd3/Global_Experienced_Careers', true),
  ('Accenture',  'https://accenture.wd103.myworkdayjobs.com/AccentureCareers',     'workday', 'accenture/wd103/AccentureCareers', true);
