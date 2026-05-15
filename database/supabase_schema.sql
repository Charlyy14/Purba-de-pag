-- =====================================================
-- EDUCLASS + SUPABASE
-- Base de datos, roles, RLS y Storage
-- Ejecutar en Supabase > SQL Editor > New query > Run
-- =====================================================

create extension if not exists pgcrypto;

-- Correos que serán administradores automáticamente al iniciar sesión por primera vez.
create table if not exists public.admin_seed_emails (
  email text primary key
);

insert into public.admin_seed_emails (email)
values (lower('jg950325@gmail.com'))
on conflict (email) do nothing;

-- Perfil de usuarios registrados por Supabase Auth.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text unique not null,
  role text not null default 'viewer' check (role in ('admin', 'viewer')),
  created_at timestamptz not null default now()
);

-- Función para saber si el usuario actual es administrador.
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

-- Crear perfil automáticamente cuando alguien inicia sesión.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, role)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'name',
      split_part(new.email, '@', 1)
    ),
    lower(new.email),
    case
      when exists (
        select 1
        from public.admin_seed_emails
        where lower(email) = lower(new.email)
      ) then 'admin'
      else 'viewer'
    end
  )
  on conflict (id) do update
  set
    email = excluded.email,
    full_name = coalesce(public.profiles.full_name, excluded.full_name);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- Carreras.
create table if not exists public.careers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  semesters_count int not null default 10 check (semesters_count between 1 and 12),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Cursos.
create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  career_id uuid not null references public.careers(id) on delete cascade,
  semester int not null check (semester between 1 and 12),
  name text not null,
  code text,
  teacher text,
  course_year int,
  description text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.courses add column if not exists description text;

-- Relación muchos-a-muchos para que un curso pertenezca a varias carreras.
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


-- Materiales de cada sección.
create table if not exists public.materials (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  section text not null check (section in ('programa', 'examenes', 'actividades', 'contenido')),
  title text not null,
  material_type text not null default 'texto' check (material_type in ('texto', 'archivo', 'imagen', 'pdf', 'word', 'enlace')),
  text_content text,
  external_url text,
  file_path text,
  file_name text,
  file_mime text,
  file_size bigint,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Bucket público para ver archivos, con escritura solo para admins por RLS.
insert into storage.buckets (id, name, public)
values ('materials', 'materials', true)
on conflict (id) do update set public = true;

-- Refresca el cache de PostgREST para que reconozca cambios de columnas/políticas.
notify pgrst, 'reload schema';

-- =====================================================
-- SEGURIDAD RLS
-- =====================================================

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
create policy "Admins actualizan roles"
on public.profiles
for update
to authenticated
using (public.is_admin())
with check (role in ('admin', 'viewer'));

-- Carreras visibles para todos. Solo admins modifican.
drop policy if exists "Todos ven carreras" on public.careers;
create policy "Todos ven carreras"
on public.careers
for select
to anon, authenticated
using (true);

drop policy if exists "Admins gestionan carreras" on public.careers;
create policy "Admins gestionan carreras"
on public.careers
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Cursos visibles para todos. Solo admins modifican.
drop policy if exists "Todos ven cursos" on public.courses;
create policy "Todos ven cursos"
on public.courses
for select
to anon, authenticated
using (true);

drop policy if exists "Admins gestionan cursos" on public.courses;
create policy "Admins gestionan cursos"
on public.courses
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Relaciones curso-carrera visibles para todos. Solo admins modifican.
drop policy if exists "Todos ven relaciones curso carrera" on public.course_careers;
create policy "Todos ven relaciones curso carrera"
on public.course_careers
for select
to anon, authenticated
using (true);

drop policy if exists "Admins gestionan relaciones curso carrera" on public.course_careers;
create policy "Admins gestionan relaciones curso carrera"
on public.course_careers
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Materiales visibles para todos. Solo admins modifican.
drop policy if exists "Todos ven materiales" on public.materials;
create policy "Todos ven materiales"
on public.materials
for select
to anon, authenticated
using (true);

drop policy if exists "Admins gestionan materiales" on public.materials;
create policy "Admins gestionan materiales"
on public.materials
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Storage: todos leen, admins suben/editan/eliminan.
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


-- =====================================================
-- PATCH EDUCLASS BUGFIX ROLES + LECTURA PUBLICA
-- Ejecutar en Supabase > SQL Editor > New query > Run
-- =====================================================

-- Asegurar columna usada por el formulario de cursos.
alter table public.courses add column if not exists description text;

-- Relación muchos-a-muchos para que un curso pertenezca a varias carreras.
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


-- Asegurar admin principal.
insert into public.admin_seed_emails (email)
values (lower('jg950325@gmail.com'))
on conflict (email) do nothing;

update public.profiles
set role = 'admin'
where lower(email) = lower('jg950325@gmail.com');

-- Admin normal: puede crear/editar contenidos.
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

-- Admin principal: solo este correo puede dar/quitar roles.
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

-- Bucket público para que visitantes puedan abrir archivos.
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

-- Perfiles: usuarios ven su perfil, admins ven usuarios, solo super admin cambia roles.
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

-- Lectura pública de datos.
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

drop policy if exists "Todos ven materiales" on public.materials;
create policy "Todos ven materiales"
on public.materials
for select
to anon, authenticated
using (true);

-- Escritura solo para admins.
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
