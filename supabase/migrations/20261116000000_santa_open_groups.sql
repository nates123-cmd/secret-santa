-- Open groups: a hosted Secret Santa where the organizer is not playing and may know every match.
-- Nothing is sealed. The pairing is stored readable on the server, each member is handed only their
-- own match after logging in, and the host (holder of host_code) can see and run everything.
-- Sealed groups (the default) are unchanged: their matches still never reach the server readable.

alter table public.santa_groups add column if not exists mode text not null default 'sealed';
alter table public.santa_groups add column if not exists host_code text;
do $$ begin
  alter table public.santa_groups add constraint santa_groups_mode_check check (mode in ('sealed', 'open'));
exception when duplicate_object then null; end $$;

create table if not exists public.santa_open_draws (
  group_id uuid primary key references public.santa_groups(id) on delete cascade,
  pairs jsonb not null,  -- { giver member id: receiver member id }
  created_at timestamptz not null default now()
);
alter table public.santa_open_draws enable row level security;
revoke all on public.santa_open_draws from anon, authenticated;

-- Group overview. Open groups: "claimed" means the name has a login email, the draw carries no
-- pairing, and the full list is included only once reveal_at has passed.
create or replace function public.santa_group(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare g public.santa_groups; out jsonb;
begin
  select * into g from public.santa_groups where invite_code = p_code;
  if g.id is null then raise exception 'unknown group'; end if;
  select jsonb_build_object(
    'id', g.id, 'name', g.name, 'budget', g.budget, 'reveal_at', g.reveal_at, 'exclusions', g.exclusions,
    'mode', g.mode,
    'members', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'name', m.name, 'wishlist', m.wishlist, 'pubkey', m.pubkey,
        'claimed', case when g.mode = 'open' then m.email is not null else m.pubkey is not null end,
        'email_hint', public.santa_email_hint(m.email))
        order by m.name) from public.santa_members m where m.group_id = g.id), '[]'::jsonb),
    'draw', case when g.mode = 'open'
      then (select jsonb_build_object('created_at', d.created_at) from public.santa_open_draws d where d.group_id = g.id)
      else (select jsonb_build_object('assignments', d.assignments, 'reveal_ct', d.reveal_ct,
        'reveal_round', d.reveal_round, 'created_at', d.created_at) from public.santa_draws d where d.group_id = g.id) end,
    'pairs', case when g.mode = 'open' and now() >= g.reveal_at then public.santa_open_pairs(g.id) end
  ) into out;
  return out;
end $$;

-- [{from, to}] by name for an open group, or null before the draw. Internal only.
create or replace function public.santa_open_pairs(p_group uuid)
returns jsonb language sql security definer set search_path = public stable as $$
  select jsonb_agg(jsonb_build_object('from', a.name, 'to', b.name) order by a.name)
  from public.santa_open_draws d
  cross join lateral jsonb_each_text(d.pairs) p
  join public.santa_members a on a.id::text = p.key
  join public.santa_members b on b.id::text = p.value
  where d.group_id = p_group;
$$;

-- The logged-in member's own match: {to, name}, or null before the draw.
create or replace function public.santa_my_match(p_code text, p_member uuid, p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare gid uuid := public.santa_member_ok(p_code, p_member, p_token);
begin
  if gid is null then raise exception 'not allowed'; end if;
  return (select jsonb_build_object('to', m.id, 'name', m.name)
    from public.santa_open_draws d
    join public.santa_members m on m.id::text = d.pairs ->> p_member::text and m.group_id = gid
    where d.group_id = gid);
end $$;

-- Host check: the open group this invite code + host code belong to, or null.
create or replace function public.santa_host_ok(p_code text, p_host text)
returns uuid language sql security definer set search_path = public stable as $$
  select g.id from public.santa_groups g
  where g.invite_code = p_code and g.mode = 'open'
    and length(coalesce(g.host_code, '')) >= 16 and g.host_code = p_host;
$$;

-- Everything the host sees: who has logged in (with their email) and the full pairing.
create or replace function public.santa_host(p_code text, p_host text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare gid uuid := public.santa_host_ok(p_code, p_host);
begin
  if gid is null then raise exception 'not allowed'; end if;
  return (select jsonb_build_object(
    'id', g.id, 'name', g.name, 'budget', g.budget, 'reveal_at', g.reveal_at, 'exclusions', g.exclusions,
    'members', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'name', m.name, 'email', m.email, 'has_wishlist', length(trim(m.wishlist)) > 0)
        order by m.name) from public.santa_members m where m.group_id = g.id), '[]'::jsonb),
    'drawn_at', (select d.created_at from public.santa_open_draws d where d.group_id = g.id),
    'pairs', public.santa_open_pairs(g.id))
  from public.santa_groups g where g.id = gid);
end $$;

-- The host's browser picks the pairing; the server checks it before storing it: everyone gives once,
-- everyone receives once, nobody has themselves, and no excluded pair is matched.
create or replace function public.santa_host_draw(p_code text, p_host text, p_pairs jsonb, p_redo boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare gid uuid := public.santa_host_ok(p_code, p_host); n int; ex jsonb;
begin
  if gid is null then raise exception 'not allowed'; end if;
  if jsonb_typeof(p_pairs) is distinct from 'object' then raise exception 'bad draw'; end if;
  select count(*) into n from public.santa_members where group_id = gid;
  if n < 2 then raise exception 'need at least two people'; end if;
  if (select count(*) from jsonb_object_keys(p_pairs)) <> n
    or (select count(*) from jsonb_each_text(p_pairs) p
          join public.santa_members a on a.id::text = p.key and a.group_id = gid) <> n
    or (select count(distinct b.id) from jsonb_each_text(p_pairs) p
          join public.santa_members b on b.id::text = p.value and b.group_id = gid) <> n
    or exists (select 1 from jsonb_each_text(p_pairs) p where p.key = p.value) then
    raise exception 'the draw must give every person exactly one other person'; end if;
  select exclusions into ex from public.santa_groups where id = gid;
  if exists (
    select 1 from jsonb_each_text(p_pairs) p
    join public.santa_members a on a.id::text = p.key
    join public.santa_members b on b.id::text = p.value
    join jsonb_array_elements(ex) e on
      (lower(e ->> 0) = lower(a.name) and lower(e ->> 1) = lower(b.name))
      or (lower(e ->> 1) = lower(a.name) and lower(e ->> 0) = lower(b.name))) then
    raise exception 'the draw matches two people who cannot draw each other'; end if;
  if exists (select 1 from public.santa_open_draws where group_id = gid) then
    if not coalesce(p_redo, false) then raise exception 'already drawn'; end if;
    update public.santa_open_draws set pairs = p_pairs, created_at = now() where group_id = gid;
  else
    insert into public.santa_open_draws (group_id, pairs) values (gid, p_pairs);
  end if;
end $$;

-- The wrong person took a name: clear its email and sign its devices out so the right one can log in.
create or replace function public.santa_host_reset(p_code text, p_host text, p_member uuid)
returns void language plpgsql security definer set search_path = public as $$
declare gid uuid := public.santa_host_ok(p_code, p_host);
begin
  if gid is null then raise exception 'not allowed'; end if;
  update public.santa_members set email = null, token_hash = null where id = p_member and group_id = gid;
  if not found then raise exception 'unknown person'; end if;
  delete from public.santa_sessions where member = p_member;
end $$;

revoke all on function public.santa_open_pairs(uuid), public.santa_host_ok(text,text) from public, anon, authenticated;
revoke all on function public.santa_my_match(text,uuid,text), public.santa_host(text,text),
  public.santa_host_draw(text,text,jsonb,boolean), public.santa_host_reset(text,text,uuid) from public;
grant execute on function public.santa_group(text), public.santa_my_match(text,uuid,text), public.santa_host(text,text),
  public.santa_host_draw(text,text,jsonb,boolean), public.santa_host_reset(text,text,uuid) to anon, authenticated;
