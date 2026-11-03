-- Email login: tap your name, enter your email, enter the code.
-- The code itself is Supabase Auth's email OTP (suite project, Brevo SMTP). These RPCs read the
-- verified address from the caller's JWT, so a member's email can only be bound or used by someone
-- who just proved they own it. Each login adds a device session; older devices keep working.
-- The match key never leaves the phone that joined, so the server still can't read any pairing.

alter table public.santa_members add column if not exists email text;

create table if not exists public.santa_sessions (
  member uuid not null references public.santa_members(id) on delete cascade,
  token_hash text not null,
  created_at timestamptz not null default now(),
  primary key (member, token_hash)
);
alter table public.santa_sessions enable row level security;
revoke all on public.santa_sessions from anon, authenticated;

-- verified email of the caller, or null
create or replace function public.santa_jwt_email()
returns text language sql stable set search_path = public as $$
  select nullif(lower(trim(coalesce(auth.jwt() ->> 'email', ''))), '');
$$;

create or replace function public.santa_member_ok(p_code text, p_member uuid, p_token text)
returns uuid language sql security definer set search_path = public stable as $$
  select g.id from public.santa_members m join public.santa_groups g on g.id = m.group_id
  where g.invite_code = p_code and m.id = p_member and coalesce(p_token, '') <> ''
    and (m.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
      or exists (select 1 from public.santa_sessions s where s.member = m.id
                   and s.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')));
$$;

create or replace function public.santa_wishlist(p_code text, p_member uuid, p_token text, p_wishlist text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.santa_member_ok(p_code, p_member, p_token) is null then raise exception 'not allowed'; end if;
  update public.santa_members set wishlist = left(coalesce(p_wishlist,''), 4000) where id = p_member;
end $$;

-- masked hint so people know which address they used, e.g. n•••@gmail.com
create or replace function public.santa_email_hint(e text)
returns text language sql immutable as $$
  select case when e is null then null
    else left(split_part(e, '@', 1), 1) || '•••@' || split_part(e, '@', 2) end;
$$;

create or replace function public.santa_group(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare g public.santa_groups; out jsonb;
begin
  select * into g from public.santa_groups where invite_code = p_code;
  if g.id is null then raise exception 'unknown group'; end if;
  select jsonb_build_object(
    'id', g.id, 'name', g.name, 'budget', g.budget, 'reveal_at', g.reveal_at, 'exclusions', g.exclusions,
    'members', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'name', m.name, 'wishlist', m.wishlist, 'pubkey', m.pubkey, 'claimed', m.pubkey is not null,
        'email_hint', public.santa_email_hint(m.email))
        order by m.name) from public.santa_members m where m.group_id = g.id), '[]'::jsonb),
    'draw', (select jsonb_build_object('assignments', d.assignments, 'reveal_ct', d.reveal_ct,
        'reveal_round', d.reveal_round, 'created_at', d.created_at) from public.santa_draws d where d.group_id = g.id)
  ) into out;
  return out;
end $$;

-- First join: needs a verified email, which becomes this name's login.
create or replace function public.santa_claim(p_code text, p_member uuid, p_pubkey jsonb, p_backup jsonb, p_token text)
returns void language plpgsql security definer set search_path = public as $$
declare gid uuid; em text := public.santa_jwt_email();
begin
  if em is null then raise exception 'verify your email first'; end if;
  select id into gid from public.santa_groups where invite_code = p_code;
  if gid is null then raise exception 'unknown group'; end if;
  if exists (select 1 from public.santa_draws where group_id = gid) then raise exception 'already drawn'; end if;
  if length(coalesce(p_token,'')) < 32 then raise exception 'bad token'; end if;
  update public.santa_members set pubkey = p_pubkey, key_backup = p_backup, email = em,
    token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex'), claimed_at = now()
  where id = p_member and group_id = gid and pubkey is null;
  if not found then raise exception 'name already claimed'; end if;
end $$;

-- Log back in on any device: verified email must match the one on this name (or binds if none yet).
create or replace function public.santa_login(p_code text, p_member uuid, p_token text)
returns void language plpgsql security definer set search_path = public as $$
declare m public.santa_members; em text := public.santa_jwt_email();
begin
  if em is null then raise exception 'verify your email first'; end if;
  if length(coalesce(p_token,'')) < 32 then raise exception 'bad token'; end if;
  select m2.* into m from public.santa_members m2 join public.santa_groups g on g.id = m2.group_id
  where g.invite_code = p_code and m2.id = p_member;
  if m.id is null then raise exception 'unknown person'; end if;
  -- People who joined before emails existed: the first verified email binds to the name.
  if m.email is null then update public.santa_members set email = em where id = m.id;
  elsif m.email <> em then raise exception 'wrong email'; end if;
  insert into public.santa_sessions (member, token_hash)
  values (m.id, encode(extensions.digest(p_token, 'sha256'), 'hex')) on conflict do nothing;
end $$;

-- Already signed in on this phone: add or change the login email.
create or replace function public.santa_set_email(p_code text, p_member uuid, p_token text)
returns void language plpgsql security definer set search_path = public as $$
declare em text := public.santa_jwt_email();
begin
  if em is null then raise exception 'verify your email first'; end if;
  if public.santa_member_ok(p_code, p_member, p_token) is null then raise exception 'not allowed'; end if;
  update public.santa_members set email = em where id = p_member;
end $$;

revoke all on function public.santa_jwt_email(), public.santa_email_hint(text) from public, anon, authenticated;
revoke all on function public.santa_member_ok(text,uuid,text) from public, anon, authenticated;
revoke all on function public.santa_login(text,uuid,text), public.santa_set_email(text,uuid,text) from public;
grant execute on function public.santa_login(text,uuid,text), public.santa_set_email(text,uuid,text) to anon, authenticated;
grant execute on function public.santa_group(text), public.santa_claim(text,uuid,jsonb,jsonb,text),
  public.santa_wishlist(text,uuid,text,text) to anon, authenticated;

-- Ideas: you can suggest gifts for anyone, yourself included. You see every idea except the ones
-- other people wrote about you (those stay a surprise); your own self-suggestions show.
create or replace function public.santa_ideas_for(p_code text, p_member uuid, p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare gid uuid := public.santa_member_ok(p_code, p_member, p_token);
begin
  if gid is null then raise exception 'not allowed'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'about', i.about, 'body', i.body,
      'mine', i.author = p_member) order by i.created_at)
    from public.santa_ideas i where i.group_id = gid and (i.about <> p_member or i.author = p_member)), '[]'::jsonb);
end $$;

create or replace function public.santa_add_idea(p_code text, p_member uuid, p_token text, p_about uuid, p_body text)
returns void language plpgsql security definer set search_path = public as $$
declare gid uuid := public.santa_member_ok(p_code, p_member, p_token);
begin
  if gid is null then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.santa_members where id = p_about and group_id = gid) then raise exception 'unknown person'; end if;
  if length(trim(coalesce(p_body, ''))) = 0 then raise exception 'empty idea'; end if;
  insert into public.santa_ideas (group_id, about, author, body) values (gid, p_about, p_member, left(trim(p_body), 500));
end $$;
