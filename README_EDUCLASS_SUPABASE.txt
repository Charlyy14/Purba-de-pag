EduClass / Ing3nieria 2026 - Versión Supabase + Netlify
========================================================

Esta versión está pensada para publicarse como sitio estático en Netlify.
Netlify muestra la página y Supabase guarda los datos, archivos, usuarios y roles.

IMPORTANTE
---------
1. Abre js/supabase-config.js.
2. Pega tu Publishable key en publishableKey.
3. No pegues Secret key, service_role key ni Client Secret de Google.

PARCHE NECESARIO EN SUPABASE
----------------------------
Antes de probar esta versión, ejecuta este archivo en Supabase:

database/supabase_patch_public_session_multicarrera.sql

No pegues el nombre del archivo en SQL Editor. Abre el archivo, copia TODO su contenido y pégalo en:

Supabase > SQL Editor > New query > Run

Este parche hace lo siguiente:
- Permite que visitantes sin sesión vean carreras, cursos y materiales.
- Crea la tabla course_careers para que un curso pueda pertenecer a varias carreras.
- Mantiene protegido el correo jg950325@gmail.com como administrador principal.
- Solo el administrador principal puede dar/quitar roles admin.
- Los administradores normales pueden crear, editar, subir y borrar contenido, pero no manejar roles.
- Asegura que los archivos del bucket materials puedan ser leídos públicamente.

PUBLICACIÓN EN NETLIFY
----------------------
Puedes subir la carpeta completa a Netlify mediante Deploy manual o conectarla a Git.
No necesitas ejecutar npm start en Netlify para guardar datos.

Después de que Netlify te dé la URL, por ejemplo:
https://tu-pagina.netlify.app

Configura Supabase:
Authentication > Configuración de URL

URL del sitio:
https://tu-pagina.netlify.app

URLs de redirección:
https://tu-pagina.netlify.app/**
https://tu-pagina.netlify.app/auth-callback.html

Puedes dejar también las URLs locales si seguirás probando en tu PC:
http://localhost:3000/**
http://localhost:3000/auth-callback.html

Configura Google Cloud:
OAuth Client > Authorized JavaScript origins

Agrega:
https://tu-pagina.netlify.app

La Authorized redirect URI de Google normalmente se queda como la callback de Supabase:
https://TU-PROYECTO.supabase.co/auth/v1/callback

CAMBIOS PRINCIPALES
-------------------
- La sesión se conserva al refrescar o al entrar a secciones.
- La sesión solo se cierra por inactividad mientras la página esté abierta durante aproximadamente 2 horas.
- Visitantes sin iniciar sesión pueden ver contenido publicado.
- Visitantes no ven el panel de crear carrera/curso.
- Los cursos pueden pertenecer a varias carreras.
- Footer: Ing3nieria 2026.
