-- Secret Santa: the server never holds a readable pairing.
-- Tables are closed to anon; everything goes through security-definer RPCs keyed by the invite code.

create table if not exists public.santa_groups (
  id uuid primary key default gen_random_uuid(),
  invite_code text not null unique,
  name text not null,
  budget text,
  reveal_at timestamptz not null,
  exclusions jsonb not null default '[]'::jsonb, -- [["Ben","Rachael"], ...] both ways
  created_at timestamptz not null default now()
);

create table if not exists public.santa_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.santa_groups(id) on delete cascade,
  name text not null,
  wishlist text not null default '',
  pubkey jsonb,          -- ECDH P-256 public JWK, null until claimed
  key_backup jsonb,      -- private key + token, AES-GCM under the member's recovery code
  token_hash text,       -- sha256 of the device token, for wishlist edits
  claimed_at timestamptz,
  unique (group_id, name)
);

create table if not exists public.santa_draws (
  group_id uuid primary key references public.santa_groups(id) on delete cascade,
  assignments jsonb not null,  -- { member_id: {epk, iv, ct} } each sealed to that member's pubkey
  reveal_ct text not null,     -- full list, drand timelock (age armor)
  reveal_round bigint not null,
  created_at timestamptz not null default now()
);

alter table public.santa_groups enable row level security;
alter table public.santa_members enable row level security;
alter table public.santa_draws enable row level security;
revoke all on public.santa_groups, public.santa_members, public.santa_draws from anon, authenticated;

create or replace function public.santa_group(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare g public.santa_groups; out jsonb;
begin
  select * into g from public.santa_groups where invite_code = p_code;
  if g.id is null then raise exception 'unknown group'; end if;
  select jsonb_build_object(
    'id', g.id, 'name', g.name, 'budget', g.budget, 'reveal_at', g.reveal_at, 'exclusions', g.exclusions,
    'members', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'name', m.name, 'wishlist', m.wishlist, 'pubkey', m.pubkey, 'claimed', m.pubkey is not null)
        order by m.name) from public.santa_members m where m.group_id = g.id), '[]'::jsonb),
    'draw', (select jsonb_build_object('assignments', d.assignments, 'reveal_ct', d.reveal_ct,
        'reveal_round', d.reveal_round, 'created_at', d.created_at) from public.santa_draws d where d.group_id = g.id)
  ) into out;
  return out;
end $$;

create or replace function public.santa_claim(p_code text, p_member uuid, p_pubkey jsonb, p_backup jsonb, p_token text)
returns void language plpgsql security definer set search_path = public as $$
declare gid uuid;
begin
  select id into gid from public.santa_groups where invite_code = p_code;
  if gid is null then raise exception 'unknown group'; end if;
  if exists (select 1 from public.santa_draws where group_id = gid) then raise exception 'already drawn'; end if;
  if length(coalesce(p_token,'')) < 32 then raise exception 'bad token'; end if;
  update public.santa_members set pubkey = p_pubkey, key_backup = p_backup,
    token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex'), claimed_at = now()
  where id = p_member and group_id = gid and pubkey is null;
  if not found then raise exception 'name already claimed'; end if;
end $$;

create or replace function public.santa_backup(p_code text, p_member uuid)
returns jsonb language sql security definer set search_path = public as $$
  select m.key_backup from public.santa_members m join public.santa_groups g on g.id = m.group_id
  where g.invite_code = p_code and m.id = p_member;
$$;

create or replace function public.santa_wishlist(p_code text, p_member uuid, p_token text, p_wishlist text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.santa_members m set wishlist = left(coalesce(p_wishlist,''), 4000)
  from public.santa_groups g
  where g.id = m.group_id and g.invite_code = p_code and m.id = p_member
    and m.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  if not found then raise exception 'not allowed'; end if;
end $$;

create or replace function public.santa_draw(p_code text, p_assignments jsonb, p_reveal_ct text, p_reveal_round bigint)
returns void language plpgsql security definer set search_path = public as $$
declare gid uuid; n int; k int;
begin
  select id into gid from public.santa_groups where invite_code = p_code;
  if gid is null then raise exception 'unknown group'; end if;
  if exists (select 1 from public.santa_members where group_id = gid and pubkey is null) then
    raise exception 'not everyone has joined'; end if;
  select count(*) into n from public.santa_members where group_id = gid;
  select count(*) into k from jsonb_object_keys(p_assignments) key
    join public.santa_members m on m.id::text = key and m.group_id = gid;
  if k <> n or (select count(*) from jsonb_object_keys(p_assignments)) <> n then
    raise exception 'assignments must cover every member exactly once'; end if;
  insert into public.santa_draws (group_id, assignments, reveal_ct, reveal_round)
  values (gid, p_assignments, p_reveal_ct, p_reveal_round);
exception when unique_violation then raise exception 'already drawn';
end $$;

revoke all on function public.santa_group(text), public.santa_claim(text,uuid,jsonb,jsonb,text),
  public.santa_backup(text,uuid), public.santa_wishlist(text,uuid,text,text),
  public.santa_draw(text,jsonb,text,bigint) from public;
grant execute on function public.santa_group(text), public.santa_claim(text,uuid,jsonb,jsonb,text),
  public.santa_backup(text,uuid), public.santa_wishlist(text,uuid,text,text),
  public.santa_draw(text,jsonb,text,bigint) to anon, authenticated;
