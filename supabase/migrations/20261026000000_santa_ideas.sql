-- Gift ideas: anyone can suggest ideas for anyone else; the subject never receives ideas about themselves.
-- Authors are stored only so people can delete their own; they are never returned.

create table if not exists public.santa_ideas (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.santa_groups(id) on delete cascade,
  about uuid not null references public.santa_members(id) on delete cascade,
  author uuid not null references public.santa_members(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

alter table public.santa_ideas enable row level security;
revoke all on public.santa_ideas from anon, authenticated;

create or replace function public.santa_member_ok(p_code text, p_member uuid, p_token text)
returns uuid language sql security definer set search_path = public stable as $$
  select g.id from public.santa_members m join public.santa_groups g on g.id = m.group_id
  where g.invite_code = p_code and m.id = p_member
    and m.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;

create or replace function public.santa_ideas_for(p_code text, p_member uuid, p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare gid uuid := public.santa_member_ok(p_code, p_member, p_token);
begin
  if gid is null then raise exception 'not allowed'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'about', i.about, 'body', i.body,
      'mine', i.author = p_member) order by i.created_at)
    from public.santa_ideas i where i.group_id = gid and i.about <> p_member), '[]'::jsonb);
end $$;

create or replace function public.santa_add_idea(p_code text, p_member uuid, p_token text, p_about uuid, p_body text)
returns void language plpgsql security definer set search_path = public as $$
declare gid uuid := public.santa_member_ok(p_code, p_member, p_token);
begin
  if gid is null then raise exception 'not allowed'; end if;
  if p_about = p_member then raise exception 'no ideas for yourself'; end if;
  if not exists (select 1 from public.santa_members where id = p_about and group_id = gid) then raise exception 'unknown person'; end if;
  if length(trim(coalesce(p_body, ''))) = 0 then raise exception 'empty idea'; end if;
  insert into public.santa_ideas (group_id, about, author, body) values (gid, p_about, p_member, left(trim(p_body), 500));
end $$;

create or replace function public.santa_delete_idea(p_code text, p_member uuid, p_token text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare gid uuid := public.santa_member_ok(p_code, p_member, p_token);
begin
  if gid is null then raise exception 'not allowed'; end if;
  delete from public.santa_ideas where id = p_id and group_id = gid and author = p_member;
  if not found then raise exception 'not allowed'; end if;
end $$;

revoke all on function public.santa_member_ok(text,uuid,text) from public, anon, authenticated;
revoke all on function public.santa_ideas_for(text,uuid,text), public.santa_add_idea(text,uuid,text,uuid,text),
  public.santa_delete_idea(text,uuid,text,uuid) from public;
grant execute on function public.santa_ideas_for(text,uuid,text), public.santa_add_idea(text,uuid,text,uuid,text),
  public.santa_delete_idea(text,uuid,text,uuid) to anon, authenticated;
