EduClass - Fix de sesión Google/Supabase

Esta versión cambia el flujo de autenticación para sitios estáticos en Netlify y evita el error:
"PKCE code verifier not found in storage".

Pasos:
1. Abrir js/supabase-config.js
2. Pegar tu Publishable key en publishableKey.
3. Subir esta carpeta/ZIP a Netlify.
4. En Supabase > Authentication > URL Configuration agrega tu URL de Netlify:
   https://TU-SITIO.netlify.app
   https://TU-SITIO.netlify.app/**
   https://TU-SITIO.netlify.app/index.html
   https://TU-SITIO.netlify.app/section.html
5. En Google Cloud > Cliente OAuth > Authorized JavaScript origins agrega:
   https://TU-SITIO.netlify.app

Notas:
- No pegues Secret key, service_role ni Google Client Secret en el código.
- Si probaste versiones anteriores, borra cookies/datos del sitio una vez y prueba de nuevo.
- El admin principal protegido es jg950325@gmail.com.
