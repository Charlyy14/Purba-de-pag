-- =====================================================
-- PATCH EDUCLASS: ESTABILIDAD DE SESION, LECTURA PUBLICA Y MULTICARRERA
-- Ejecutar en Supabase > SQL Editor > New query > Run
-- =====================================================

create extension if not exists pgcrypto;

-- Columnas necesarias del formulario actual.
alter table public.courses add column if not exists description text;

-- Relación muchos-a-muchos: un curso puede estar en varias carreras.
create table if not exists public.course_careers (
  course_id uuid not null references public.courses(id) on delete cascade,
  career_id uuid not null references public.careers(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (course_id, career_id)
);

-- Migra relaciones desde la columna vieja career_id.
insert into public.course_careers (course_id, career_id)
select id, career_id
from public.courses
where career_id is not null
on conflict (course_id, career_id) do nothing;

-- Admin principal protegido.
insert into public.admin_seed_emails (email)
values (lower('jg950325@gmail.com'))
on conflict (email) do nothing;

update public.profiles
set role = 'admin'
where lower(email) = lower('jg950325@gmail.com');

-- Admin normal: puede gestionar contenido.
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

-- Solo el admin principal puede gestionar roles.
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

-- Funciones públicas de lectura como fallback para visitantes.
-- Se usan para que cualquier persona con el enlace pueda ver carreras, cursos y materiales.
create or replace function public.educlass_public_careers()
returns setof public.careers
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.careers
  order by created_at asc;
$$;

create or replace function public.educlass_public_courses(p_course_id uuid default null)
returns setof public.courses
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.courses
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
  select *
  from public.course_careers;
$$;

create or replace function public.educlass_public_materials(p_course_id uuid default null, p_section text default null)
returns setof public.materials
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.materials
  where (p_course_id is null or course_id = p_course_id)
    and (p_section is null or section = p_section)
  order by created_at desc;
$$;

grant execute on function public.educlass_public_careers() to anon, authenticated;
grant execute on function public.educlass_public_courses(uuid) to anon, authenticated;
grant execute on function public.educlass_public_course_careers() to anon, authenticated;
grant execute on function public.educlass_public_materials(uuid, text) to anon, authenticated;

-- Bucket público para abrir archivos sin sesión.
insert into storage.buckets (id, name, public)
values ('materials', 'materials', true)
on conflict (id) do update set public = true;

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

-- Perfiles.
drop policy if exists "Usuarios ven su propio perfil" on public.profiles;
create policy "Usuarios ven su propio perfil"
on public.profiles
for select
to authenticated
using (id = auth.uid());

drop policy if exists "Admins ven todos los perfiles" on public.profiles;
create policy "Admins ven todos los perfiles"
on public.profiles
for select
to authenticated
using (public.is_admin());

drop policy if exists "Admins actualizan roles" on public.profiles;
drop policy if exists "Super admin actualiza roles" on public.profiles;
create policy "Super admin actualiza roles"
on public.profiles
for update
to authenticated
using (public.is_super_admin())
with check (
  role in ('admin', 'viewer')
  and (lower(email) <> lower('jg950325@gmail.com') or role = 'admin')
);

-- Lectura pública.
drop policy if exists "Todos ven carreras" on public.careers;
create policy "Todos ven carreras"
on public.careers
for select
to anon, authenticated
using (true);

drop policy if exists "Todos ven cursos" on public.courses;
create policy "Todos ven cursos"
on public.courses
for select
to anon, authenticated
using (true);

drop policy if exists "Todos ven relaciones curso carrera" on public.course_careers;
create policy "Todos ven relaciones curso carrera"
on public.course_careers
for select
to anon, authenticated
using (true);

drop policy if exists "Todos ven materiales" on public.materials;
create policy "Todos ven materiales"
on public.materials
for select
to anon, authenticated
using (true);

-- Escritura solo admins.
drop policy if exists "Admins gestionan carreras" on public.careers;
create policy "Admins gestionan carreras"
on public.careers
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins gestionan cursos" on public.courses;
create policy "Admins gestionan cursos"
on public.courses
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins gestionan relaciones curso carrera" on public.course_careers;
create policy "Admins gestionan relaciones curso carrera"
on public.course_careers
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins gestionan materiales" on public.materials;
create policy "Admins gestionan materiales"
on public.materials
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Storage: lectura pública, escritura solo admins.
drop policy if exists "Todos leen archivos de materiales" on storage.objects;
create policy "Todos leen archivos de materiales"
on storage.objects
for select
to anon, authenticated
using (bucket_id = 'materials');

drop policy if exists "Admins suben archivos de materiales" on storage.objects;
create policy "Admins suben archivos de materiales"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'materials' and public.is_admin());

drop policy if exists "Admins actualizan archivos de materiales" on storage.objects;
create policy "Admins actualizan archivos de materiales"
on storage.objects
for update
to authenticated
using (bucket_id = 'materials' and public.is_admin())
with check (bucket_id = 'materials' and public.is_admin());

drop policy if exists "Admins eliminan archivos de materiales" on storage.objects;
create policy "Admins eliminan archivos de materiales"
on storage.objects
for delete
to authenticated
using (bucket_id = 'materials' and public.is_admin());

notify pgrst, 'reload schema';
