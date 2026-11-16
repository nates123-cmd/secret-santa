-- Open groups no longer reveal the full list: players tell each other. Only the host ever sees it.
-- santa_group stops returning `pairs` at all (sealed groups never had it; their list is the timelock).
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
        'reveal_round', d.reveal_round, 'created_at', d.created_at) from public.santa_draws d where d.group_id = g.id) end
  ) into out;
  return out;
end $$;
