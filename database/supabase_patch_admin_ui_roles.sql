-- =====================================================
-- PATCH EDUCLASS: ADMIN PRINCIPAL, CONTROL DE ROLES Y SECCIONES
-- Ejecutar en Supabase > SQL Editor > New query > Run
-- Este parche refuerza que jg950325@gmail.com sea admin principal,
-- pueda ver/cambiar roles, y los admins puedan subir materiales.
-- =====================================================

insert into public.admin_seed_emails (email)
values (lower('jg950325@gmail.com'))
on conflict (email) do nothing;

update public.profiles
set role = 'admin'
where lower(email) = lower('jg950325@gmail.com');

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
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.full_name, p.email, p.role, p.created_at
  from public.profiles p
  where lower(coalesce(auth.jwt()->>'email', '')) = lower('jg950325@gmail.com')
  order by p.created_at desc;
$$;

grant execute on function public.educlass_admin_profiles() to authenticated;

create or replace function public.educlass_set_profile_role(p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(coalesce(auth.jwt()->>'email', '')) <> lower('jg950325@gmail.com') then
    raise exception 'Solo el administrador principal puede cambiar roles.';
  end if;

  if p_role not in ('admin', 'viewer') then
    raise exception 'Rol inválido.';
  end if;

  update public.profiles
  set role = p_role
  where id = p_user_id
    and lower(email) <> lower('jg950325@gmail.com');
end;
$$;

grant execute on function public.educlass_set_profile_role(uuid, text) to authenticated;

-- Lectura pública para visitantes.
alter table public.careers enable row level security;
alter table public.courses enable row level security;
alter table public.materials enable row level security;
alter table public.course_careers enable row level security;

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

-- Escritura de contenido solo para administradores.
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

-- Perfiles: el admin principal puede administrar roles.
alter table public.profiles enable row level security;

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

-- Storage: lectura pública, escritura solo admins.
insert into storage.buckets (id, name, public)
values ('materials', 'materials', true)
on conflict (id) do update set public = true;

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
