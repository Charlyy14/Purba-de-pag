# EduClass Fix Admin y Secciones

Esta versión corrige:

- El panel de administrador no aparecía aunque la sesión estuviera iniciada.
- Las secciones Programa, Exámenes, Actividades y Contenido no mostraban el formulario para subir materiales al admin.
- El control de roles no aparecía para el admin principal.
- Se refuerza que `jg950325@gmail.com` sea siempre el admin principal protegido.

## Antes de subir a Netlify

1. Abre `js/supabase-config.js`.
2. Pega tu Publishable key donde dice `PEGA_AQUI_TU_PUBLISHABLE_KEY`.
3. Sube el proyecto completo a Netlify.

## SQL recomendado

En Supabase > SQL Editor > New query, ejecuta el archivo:

`database/supabase_patch_admin_ui_section_roles.sql`

Ese parche refuerza políticas, roles, lectura pública y permisos para subir materiales.
