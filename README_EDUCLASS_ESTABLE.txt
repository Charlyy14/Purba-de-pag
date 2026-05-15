EDUCLASS ESTABLE PARA NETLIFY + SUPABASE
=======================================

Esta versión reemplaza el flujo anterior por una versión estática más estable para Netlify.
No necesita npm start ni servidor local para funcionar en Netlify.

ANTES DE SUBIR A NETLIFY
------------------------
1. Abre js/supabase-config.js.
2. Pega tu Publishable key en:
   publishableKey: 'PEGA_AQUI_TU_PUBLISHABLE_KEY'
3. No pegues Secret key, service_role ni Client Secret de Google.

SQL NECESARIO
-------------
Ejecuta en Supabase > SQL Editor > New query > Run el archivo:

database/supabase_patch_stable_public_multicarrera.sql

Ese parche deja:
- lectura pública para visitantes sin sesión,
- permisos de escritura solo para admins,
- curso en varias carreras mediante course_careers,
- admin principal protegido: jg950325@gmail.com,
- solo admin principal puede dar/quitar roles.

CONFIGURACIÓN EN SUPABASE PARA NETLIFY
--------------------------------------
En Supabase > Authentication > Configuración de URL:

URL del sitio:
https://TU-SITIO.netlify.app

URLs de redirección:
https://TU-SITIO.netlify.app/**
https://TU-SITIO.netlify.app/index.html
https://TU-SITIO.netlify.app/section.html
https://TU-SITIO.netlify.app/auth-callback.html

Puedes dejar también:
http://localhost:3000/**

CONFIGURACIÓN EN GOOGLE CLOUD
-----------------------------
En tu cliente OAuth agrega en Authorized JavaScript origins:
https://TU-SITIO.netlify.app

En Authorized redirect URIs deja la callback de Supabase:
https://TU-PROYECTO.supabase.co/auth/v1/callback

CAMBIOS IMPORTANTES
-------------------
- La sesión usa storageKey estable: educlass-auth-v3.
- Ya no se sobrescribe la clave interna de Supabase en localStorage.
- La sesión debe permanecer al refrescar página y abrir secciones.
- Los visitantes sin cuenta pueden ver carreras, cursos y materiales.
- Solo administradores ven formularios de crear/editar/subir.
- Un curso puede pertenecer a varias carreras.
