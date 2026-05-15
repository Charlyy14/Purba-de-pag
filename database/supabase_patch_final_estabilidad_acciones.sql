-- =====================================================
-- PATCH EDUCLASS FINAL: cierre de sesión, roles rápidos y borrado estable
-- Ejecutar en Supabase > SQL Editor > New query > Run
-- =====================================================

create extension if not exists pgcrypto;

insert into public.admin_seed_emails (email)
values (lower('jg950325@gmail.com'))
on conflict (email) do nothing;

update public.profiles
set role = 'admin'
where lower(email) = lower('jg950325@gmail.com');

alter table public.courses add column if not exists description text;
alter table public.courses alter column career_id drop not null;

create table if not exists public.course_careers (
  course_id uuid not null references public.courses(id) on delete cascade,
  career_id uuid not null references public.careers(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (course_id, career_id)
);

insert into public.course_careers (course_id, career_id)
select id, career_id
from public.courses
where career_id is not null
on conflict (course_id, career_id) do nothing;

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
  );
$$;

create or replace function public.is_super_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
      and lower(email) = lower('jg950325@gmail.com')
  );
$$;

create or replace function public.educlass_admin_profiles()
returns table (
  id uuid,
  full_name text,
  email text,
  role text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'Solo el administrador principal puede ver todos los perfiles.';
  end if;

  return query
  select p.id, p.full_name, p.email, p.role, p.created_at
  from public.profiles p
  order by p.created_at desc;
end;
$$;

grant execute on function public.educlass_admin_profiles() to authenticated;

create or replace function public.educlass_set_profile_role(p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_email text;
begin
  if not public.is_super_admin() then
    raise exception 'Solo el administrador principal puede cambiar roles.';
  end if;

  if p_role not in ('admin', 'viewer') then
    raise exception 'Rol inválido.';
  end if;

  select lower(email) into target_email
  from public.profiles
  where id = p_user_id;

  if target_email is null then
    raise exception 'Usuario no encontrado.';
  end if;

  if target_email = lower('jg950325@gmail.com') and p_role <> 'admin' then
    raise exception 'El administrador principal está protegido.';
  end if;

  update public.profiles
  set role = p_role
  where id = p_user_id;
end;
$$;

grant execute on function public.educlass_set_profile_role(uuid, text) to authenticated;

create or replace function public.educlass_set_course_careers(p_course_id uuid, p_career_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cid uuid;
  first_career uuid;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador puede modificar cursos.';
  end if;

  if p_course_id is null or p_career_ids is null or array_length(p_career_ids, 1) is null then
    raise exception 'Selecciona al menos una carrera.';
  end if;

  first_career := p_career_ids[1];

  delete from public.course_careers
  where course_id = p_course_id;

  foreach cid in array p_career_ids loop
    insert into public.course_careers (course_id, career_id)
    values (p_course_id, cid)
    on conflict (course_id, career_id) do nothing;
  end loop;

  update public.courses
  set career_id = first_career,
      updated_at = now()
  where id = p_course_id;
end;
$$;

grant execute on function public.educlass_set_course_careers(uuid, uuid[]) to authenticated;

create or replace function public.educlass_delete_course(p_course_id uuid)
returns void
language plpgsql
security definer
set search_path = public, storage
as $$
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador puede borrar cursos.';
  end if;

  delete from storage.objects
  where bucket_id = 'materials'
    and name in (
      select file_path
      from public.materials
      where course_id = p_course_id
        and file_path is not null
    );

  delete from public.materials where course_id = p_course_id;
  delete from public.course_careers where course_id = p_course_id;
  delete from public.courses where id = p_course_id;
end;
$$;

grant execute on function public.educlass_delete_course(uuid) to authenticated;

create or replace function public.educlass_delete_career(p_career_id uuid)
returns void
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  rec record;
  rel_count int;
  new_primary uuid;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador puede borrar carreras.';
  end if;

  for rec in
    select distinct course_id
    from public.course_careers
    where career_id = p_career_id
  loop
    select count(*) into rel_count
    from public.course_careers
    where course_id = rec.course_id;

    if rel_count <= 1 then
      perform public.educlass_delete_course(rec.course_id);
    else
      delete from public.course_careers
      where course_id = rec.course_id
        and career_id = p_career_id;

      select career_id into new_primary
      from public.course_careers
      where course_id = rec.course_id
      limit 1;

      update public.courses
      set career_id = new_primary,
          updated_at = now()
      where id = rec.course_id
        and career_id = p_career_id;
    end if;
  end loop;

  -- Compatibilidad con cursos viejos que no tengan relación en course_careers.
  for rec in
    select id as course_id
    from public.courses c
    where c.career_id = p_career_id
      and not exists (
        select 1 from public.course_careers cc where cc.course_id = c.id
      )
  loop
    perform public.educlass_delete_course(rec.course_id);
  end loop;

  delete from public.careers where id = p_career_id;
end;
$$;

grant execute on function public.educlass_delete_career(uuid) to authenticated;

-- Reforzar políticas necesarias si ya existen de versiones anteriores.
alter table public.profiles enable row level security;
alter table public.careers enable row level security;
alter table public.courses enable row level security;
alter table public.course_careers enable row level security;
alter table public.materials enable row level security;

grant usage on schema public to anon, authenticated;
grant select on public.careers to anon, authenticated;
grant select on public.courses to anon, authenticated;
grant select on public.course_careers to anon, authenticated;
grant select on public.materials to anon, authenticated;
grant select on public.profiles to authenticated;
grant insert, update, delete on public.careers to authenticated;
grant insert, update, delete on public.courses to authenticated;
grant insert, update, delete on public.course_careers to authenticated;
grant insert, update, delete on public.materials to authenticated;

revoke update on public.profiles from authenticated;
grant update (role) on public.profiles to authenticated;

insert into storage.buckets (id, name, public)
values ('materials', 'materials', true)
on conflict (id) do update set public = true;

-- Funciones públicas de lectura por si el visitante no tiene sesión.
create or replace function public.educlass_public_careers()
returns setof public.careers
language sql
stable
security definer
set search_path = public
as $$
  select * from public.careers order by created_at asc;
$$;

create or replace function public.educlass_public_courses(p_course_id uuid default null)
returns setof public.courses
language sql
stable
security definer
set search_path = public
as $$
  select * from public.courses
  where p_course_id is null or id = p_course_id
  order by semester asc, name asc;
$$;

create or replace function public.educlass_public_course_careers()
returns setof public.course_careers
language sql
stable
security definer
set search_path = public
as $$
  select * from public.course_careers;
$$;

create or replace function public.educlass_public_materials(p_course_id uuid default null, p_section text default null)
returns setof public.materials
language sql
stable
security definer
set search_path = public
as $$
  select * from public.materials
  where (p_course_id is null or course_id = p_course_id)
    and (p_section is null or section = p_section)
  order by created_at desc;
$$;

grant execute on function public.educlass_public_careers() to anon, authenticated;
grant execute on function public.educlass_public_courses(uuid) to anon, authenticated;
grant execute on function public.educlass_public_course_careers() to anon, authenticated;
grant execute on function public.educlass_public_materials(uuid, text) to anon, authenticated;

notify pgrst, 'reload schema';
