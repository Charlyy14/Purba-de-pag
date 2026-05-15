(function () {
  'use strict';

  const cfg = window.EDUCLASS_SUPABASE_CONFIG || {};
  const placeholders = new Set(['', 'PEGA_AQUI_TU_PUBLISHABLE_KEY', 'AQUI_PEGAS_TU_PUBLISHABLE_KEY', 'TU_PUBLISHABLE_KEY']);
  const ROOT_ADMIN_EMAIL = normalizeEmail(cfg.rootAdminEmail || 'jg950325@gmail.com');
  const STORAGE_KEY = 'educlass-auth-stable-v4';
  const SESSION_BACKUP_KEY = 'educlass-session-backup-stable-v4';
  const ACTIVITY_KEY = 'educlass-last-activity-stable-v4';
  const PROFILE_CACHE_KEY = 'educlass-profile-cache-stable-v6';
  const SESSION_SIGNAL_KEY = 'educlass-session-signal-stable-v6';
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const page = document.body.dataset.page || 'dashboard';

  const SECTION_LABELS = {
    programa: { title: 'Programa del curso', icon: 'uil-clipboard-notes' },
    examenes: { title: 'Exámenes', icon: 'uil-file-check-alt' },
    actividades: { title: 'Actividades', icon: 'uil-edit-alt' },
    contenido: { title: 'Contenido', icon: 'uil-book-reader' }
  };

  const state = {
    client: null,
    session: null,
    user: null,
    profile: null,
    careers: [],
    courses: [],
    links: [],
    materials: [],
    profiles: [],
    loading: false,
    authChannel: null
  };

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    injectSharedUi();
    bindSharedUi();
    setupActivityTracking();
    setupCrossTabAuth();
    setupNavigationSessionPersistence();

    if (!isConfigured()) {
      renderAuth();
      renderConfigNotice('Pega tu Publishable key en js/supabase-config.js.');
      return;
    }

    state.client = window.supabase.createClient(cfg.url, cfg.publishableKey, {
      auth: {
        storageKey: STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        flowType: 'implicit',
        storage: window.localStorage
      },
      global: {
        headers: { 'x-application-name': 'educlass-ing3nieria' }
      }
    });

    try {
      await processAuthReturn();
      await loadSession();
      state.client.auth.onAuthStateChange(async (event, session) => {
        if (session) rememberSession(session);
        if (event === 'SIGNED_OUT') {
          forgetSession();
          state.session = null;
          state.user = null;
          state.profile = null;
          await renderPage();
          return;
        }
        // En Vercel/navegadores con BFCache, INITIAL_SESSION puede llegar tarde o vacío.
        // Siempre intentamos recuperar el respaldo local antes de pintar la interfaz.
        await loadSession(true);
        await renderPage();
      });
      await renderPage();
    } catch (error) {
      console.error(error);
      toast(error.message || 'No se pudo iniciar EduClass.');
      await renderPage();
    }
  }

  function isConfigured() {
    return Boolean(cfg.url && cfg.publishableKey && !placeholders.has(String(cfg.publishableKey).trim()) && window.supabase);
  }

  async function processAuthReturn() {
    const url = new URL(window.location.href);
    const hash = new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''));
    const code = url.searchParams.get('code');
    const accessToken = hash.get('access_token');
    const refreshToken = hash.get('refresh_token');
    const error = url.searchParams.get('error') || hash.get('error');
    const errorDescription = url.searchParams.get('error_description') || hash.get('error_description');

    if (error) {
      cleanAuthUrl(true);
      throw new Error(errorDescription || error);
    }

    // Flujo recomendado para este sitio estático: implicit flow.
    // Supabase devuelve access_token y refresh_token en el hash, los guardamos una sola vez.
    if (accessToken && refreshToken) {
      const { data, error: sessionError } = await state.client.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken
      });
      if (sessionError) throw sessionError;
      if (data && data.session) rememberSession(data.session);
      cleanAuthUrl(true);
      return;
    }

    // Compatibilidad: si quedó un retorno viejo tipo PKCE (?code=...), lo intentamos,
    // pero ignoramos el error de code verifier si la sesión ya quedó guardada por Supabase.
    if (code) {
      const { data: before } = await state.client.auth.getSession();
      if (before && before.session) {
        rememberSession(before.session);
        cleanAuthUrl(true);
        return;
      }
      const { data, error: exchangeError } = await state.client.auth.exchangeCodeForSession(code);
      if (exchangeError) {
        const msg = String(exchangeError.message || '');
        const { data: after } = await state.client.auth.getSession();
        if (after && after.session) {
          rememberSession(after.session);
          cleanAuthUrl(true);
          return;
        }
        if (msg.toLowerCase().includes('code verifier')) {
          cleanAuthUrl(true);
          toast('El retorno de Google quedó incompleto. Presiona Iniciar sesión otra vez.');
          return;
        }
        throw exchangeError;
      }
      if (data && data.session) rememberSession(data.session);
      cleanAuthUrl(true);
    }
  }

  function cleanAuthUrl(cleanHash) {
    const url = new URL(window.location.href);
    ['code', 'state', 'error', 'error_description'].forEach(key => url.searchParams.delete(key));
    const next = url.searchParams.get('next');
    if (next) url.searchParams.delete('next');
    const target = `${url.pathname}${url.search}${cleanHash ? '' : url.hash}` || '/';
    window.history.replaceState({}, document.title, target);
  }

  async function loadSession(tryBackup = true) {
    // Supabase puede tardar unos milisegundos en hidratar localStorage cuando se abre otra pestaña.
    // Por eso intentamos varias veces antes de decidir que no hay sesión.
    let session = null;
    let lastError = null;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { data, error } = await state.client.auth.getSession();
      if (error) lastError = error;
      session = data && data.session ? data.session : null;
      if (session) break;
      await wait(attempt === 0 ? 120 : 240);
    }

    if (lastError) console.warn(lastError.message);

    if (!session && tryBackup) {
      session = await restoreSessionBackup();
    }

    if (!session && tryBackup) {
      session = await restoreSessionFromAnyLocalToken();
    }

    // Si la página volvió desde la flecha Atrás del navegador, puede reaparecer desde
    // BFCache con state.session válido aunque Supabase todavía no haya hidratado localStorage.
    // No lo borramos de golpe: lo conservamos y volvemos a sincronizar.
    if (!session && state.session && !isIdleExpired()) {
      session = state.session;
      rememberSession(session);
    }

    if (session && isIdleExpired()) {
      await state.client.auth.signOut({ scope: 'local' }).catch(() => null);
      forgetSession(true);
      session = null;
      toast('La sesión se cerró por inactividad.');
    }

    state.session = session;
    state.user = session ? session.user : null;
    state.profile = state.user ? await getProfile() : null;
    if (state.profile) rememberProfile(state.profile);
    renderAuth();
  }


  function setupCrossTabAuth() {
    try {
      if ('BroadcastChannel' in window) {
        state.authChannel = new BroadcastChannel('educlass-auth-sync');
        state.authChannel.onmessage = async event => {
          const msg = event.data || {};
          if (msg.type === 'SESSION_UPDATED' && msg.session && !state.user) {
            await tryApplySession(msg.session);
            await loadSession(false);
            await renderPage();
          }
          if (msg.type === 'SIGNED_OUT') {
            forgetSession();
            state.session = null;
            state.user = null;
            state.profile = null;
            await renderPage();
          }
        };
      }
    } catch (_) {}

    window.addEventListener('storage', async event => {
      if (event.key === SESSION_SIGNAL_KEY && event.newValue) {
        if (!state.user) {
          await restoreSessionFromAnyLocalToken();
          await loadSession(false);
          await renderPage();
        }
      }
      if (event.key === SESSION_BACKUP_KEY && event.newValue && !state.user) {
        await restoreSessionBackup();
        await loadSession(false);
        await renderPage();
      }
    });

    document.addEventListener('visibilitychange', async () => {
      if (!document.hidden && state.client) {
        const wasLogged = Boolean(state.user);
        await loadSession(true);
        if (Boolean(state.user) !== wasLogged) await renderPage();
      }
    });
  }


  function setupNavigationSessionPersistence() {
    const sync = () => snapshotSessionForNavigation();
    window.addEventListener('pagehide', sync);
    window.addEventListener('beforeunload', sync);

    // Cuando se usa la flecha Atrás/Adelante, muchos navegadores restauran la página
    // desde BFCache sin disparar DOMContentLoaded. Este evento revalida permisos de admin
    // antes de que el usuario abra Programa, Exámenes, Actividades o Contenido otra vez.
    window.addEventListener('pageshow', async () => {
      if (!state.client) return;
      await loadSession(true);
      await renderPage();
    });

    window.addEventListener('focus', async () => {
      if (!state.client) return;
      const wasAdmin = isAdmin();
      await loadSession(true);
      if (wasAdmin !== isAdmin()) await renderPage();
    });
  }

  function snapshotSessionForNavigation() {
    try {
      if (state.session) rememberSession(state.session);
      if (state.profile) rememberProfile(state.profile);
      localStorage.setItem(SESSION_SIGNAL_KEY, String(Date.now()));
      if (state.authChannel && state.session) {
        state.authChannel.postMessage({
          type: 'SESSION_UPDATED',
          session: {
            access_token: state.session.access_token,
            refresh_token: state.session.refresh_token,
            expires_at: state.session.expires_at || null,
            user: state.session.user || null,
            saved_at: Date.now()
          }
        });
      }
    } catch (_) {}
  }

  async function restoreSessionFromAnyLocalToken() {
    const candidates = [];
    try {
      Object.keys(localStorage).forEach(key => {
        if (key === STORAGE_KEY || key === SESSION_BACKUP_KEY || key.startsWith('sb-') || key.includes('supabase')) {
          const session = extractSessionFromStorage(localStorage.getItem(key));
          if (session) candidates.push(session);
        }
      });
    } catch (_) {}

    for (const session of candidates) {
      const applied = await tryApplySession(session);
      if (applied) return applied;
    }
    return null;
  }

  function extractSessionFromStorage(raw) {
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      if (value && value.access_token && value.refresh_token) return value;
      if (value && value.currentSession && value.currentSession.access_token && value.currentSession.refresh_token) return value.currentSession;
      if (value && value.session && value.session.access_token && value.session.refresh_token) return value.session;
    } catch (_) {}
    return null;
  }

  async function tryApplySession(session) {
    if (!session || !session.access_token || !session.refresh_token) return null;
    const { data, error } = await state.client.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token
    });
    if (error) {
      console.warn('No se pudo aplicar sesión compartida:', error.message || error);
      return null;
    }
    if (data && data.session) {
      rememberSession(data.session);
      return data.session;
    }
    return null;
  }

  async function restoreSessionBackup() {
    try {
      const raw = localStorage.getItem(SESSION_BACKUP_KEY);
      if (!raw) return null;
      const backup = JSON.parse(raw);
      if (!backup || !backup.access_token || !backup.refresh_token) return null;
      const { data, error } = await state.client.auth.setSession({
        access_token: backup.access_token,
        refresh_token: backup.refresh_token
      });
      if (error) {
        console.warn('No se pudo restaurar respaldo de sesión:', error.message);
        return null;
      }
      if (data && data.session) {
        rememberSession(data.session);
        return data.session;
      }
      return null;
    } catch (error) {
      console.warn('Respaldo de sesión inválido:', error.message);
      return null;
    }
  }

  function rememberSession(session) {
    if (!session || !session.access_token || !session.refresh_token) return;
    try {
      const snapshot = {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at || null,
        user: session.user || null,
        saved_at: Date.now()
      };
      localStorage.setItem(SESSION_BACKUP_KEY, JSON.stringify(snapshot));
      localStorage.setItem(SESSION_SIGNAL_KEY, String(Date.now()));
      if (state.authChannel) state.authChannel.postMessage({ type: 'SESSION_UPDATED', session: snapshot });
      touchActivity();
    } catch (_) {}
  }

  function forgetSession(broadcast = false) {
    try {
      localStorage.removeItem(SESSION_BACKUP_KEY);
      localStorage.removeItem(PROFILE_CACHE_KEY);
      localStorage.removeItem(ACTIVITY_KEY);
      if (broadcast) {
        localStorage.setItem(SESSION_SIGNAL_KEY, `signed-out-${Date.now()}`);
        if (state.authChannel) state.authChannel.postMessage({ type: 'SIGNED_OUT' });
      }
    } catch (_) {}
  }

  function touchActivity() {
    try { localStorage.setItem(ACTIVITY_KEY, String(Date.now())); } catch (_) {}
  }

  function isIdleExpired() {
    const value = Number(localStorage.getItem(ACTIVITY_KEY) || 0);
    if (!value) return false;
    return Date.now() - value > TWO_HOURS;
  }

  function setupActivityTracking() {
    let last = 0;
    const touch = () => {
      const now = Date.now();
      if (now - last < 30000) return;
      last = now;
      if (state.user) touchActivity();
    };
    ['click', 'keydown', 'scroll', 'mousemove', 'touchstart'].forEach(evt => window.addEventListener(evt, touch, { passive: true }));
    setInterval(async () => {
      if (state.user && isIdleExpired()) {
        await state.client.auth.signOut();
        forgetSession(true);
        state.session = null;
        state.user = null;
        state.profile = null;
        await renderPage();
        toast('La sesión se cerró por inactividad.');
      }
    }, 60000);
  }

  async function getProfile() {
    const fallback = () => ({
      id: state.user.id,
      full_name: state.user.user_metadata?.full_name || state.user.user_metadata?.name || state.user.email,
      email: state.user.email,
      role: normalizeEmail(state.user.email) === ROOT_ADMIN_EMAIL ? 'admin' : 'viewer'
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { data, error } = await state.client
        .from('profiles')
        .select('id, full_name, email, role, created_at')
        .eq('id', state.user.id)
        .maybeSingle();

      if (data) {
        if (normalizeEmail(data.email || state.user.email) === ROOT_ADMIN_EMAIL) {
          return { ...data, role: 'admin', email: data.email || state.user.email };
        }
        return data;
      }

      if (error) {
        console.warn('Perfil no disponible:', error.message);
        break;
      }

      // Al volver de Google el trigger de Supabase puede tardar un instante en crear profiles.
      await wait(350);
    }

    const cached = cachedProfileForCurrentUser();
    if (cached) return cached;
    return fallback();
  }


  function rememberProfile(profile) {
    if (!profile || !profile.email) return;
    try {
      localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify({
        id: profile.id,
        full_name: profile.full_name || '',
        email: profile.email,
        role: profile.role || 'viewer',
        saved_at: Date.now()
      }));
    } catch (_) {}
  }

  function cachedProfileForCurrentUser() {
    try {
      const raw = localStorage.getItem(PROFILE_CACHE_KEY);
      if (!raw || !state.user) return null;
      const cached = JSON.parse(raw);
      if (!cached || normalizeEmail(cached.email) !== normalizeEmail(state.user.email)) return null;
      // Cache corto para no depender permanentemente de UI local. RLS sigue protegiendo la BD.
      if (Date.now() - Number(cached.saved_at || 0) > TWO_HOURS) return null;
      return cached;
    } catch (_) {
      return null;
    }
  }

  function isLoggedIn() { return Boolean(state.user); }
  function isAdmin() { return state.profile && state.profile.role === 'admin'; }
  function isSuperAdmin() { return isAdmin() && normalizeEmail(state.profile.email || state.user.email) === ROOT_ADMIN_EMAIL; }

  async function renderPage() {
    renderAuth();
    if (page === 'dashboard') await dashboard();
    if (page === 'section') await sectionPage();
  }

  function injectSharedUi() {
    if (!document.getElementById('authModal')) {
      document.body.insertAdjacentHTML('beforeend', `
        <div class="auth-modal-backdrop" id="authModal" aria-hidden="true">
          <div class="auth-modal" role="dialog" aria-modal="true">
            <button class="auth-close" id="closeAuthModal" type="button" aria-label="Cerrar">&times;</button>
            <h2>Iniciar sesión</h2>
            <div class="auth-current-user d-none" id="authCurrentUser"></div>
            <button class="btn custom-btn custom-btn-bg w-100" id="googleLoginButton" type="button"><i class='uil uil-google'></i> Iniciar sesión con Google</button>
            <button class="btn custom-btn danger-btn mt-3 w-100 d-none" id="logoutButton" type="button"><i class='uil uil-signout'></i> Cerrar sesión</button>
          </div>
        </div>
        <div class="confirm-backdrop" id="confirmDialog" aria-hidden="true">
          <div class="confirm-card" role="dialog" aria-modal="true">
            <div class="confirm-icon danger"><i class='uil uil-exclamation-triangle'></i></div>
            <h3 id="confirmTitle">Confirmar acción</h3>
            <p id="confirmMessage">¿Deseas continuar?</p>
            <div class="confirm-actions"><button class="btn custom-btn" id="confirmCancel" type="button">Cancelar</button><button class="btn custom-btn danger-btn" id="confirmOk" type="button">Confirmar</button></div>
          </div>
        </div>`);
    }
  }

  function bindSharedUi() {
    on('#loginButton', 'click', openAuthModal);
    on('#closeAuthModal', 'click', closeAuthModal);
    on('#googleLoginButton', 'click', signIn);
    on('#logoutButton', 'click', signOut);
    const modal = $('#authModal');
    if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeAuthModal(); });
  }

  async function signIn() {
    try {
      const redirectUrl = cleanRedirectUrl(window.location.href);
      const { error } = await state.client.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: redirectUrl,
          queryParams: { access_type: 'offline', prompt: 'select_account' }
        }
      });
      if (error) throw error;
    } catch (error) {
      toast(error.message || 'No se pudo iniciar sesión.');
    }
  }

  function cleanRedirectUrl(rawUrl) {
    const url = new URL(rawUrl);
    ['code', 'state', 'error', 'error_description'].forEach(k => url.searchParams.delete(k));
    url.hash = '';
    return url.toString();
  }

  async function signOut() {
    if (!state.client) return;
    const btn = $('#logoutButton');
    const old = btn ? btn.innerHTML : '';
    try {
      if (btn) { btn.disabled = true; btn.innerHTML = `<i class='uil uil-sync'></i> Cerrando...`; }
      // En sitios estáticos, signOut global puede tardar por red. Cerramos local primero
      // para que la interfaz responda al instante y limpiamos cualquier respaldo propio.
      await withTimeout(state.client.auth.signOut({ scope: 'local' }), 'No se pudo cerrar la sesión desde Supabase a tiempo.', 6000)
        .catch(err => console.warn('Cierre local con aviso:', err.message || err));
      forgetSession(true);
      clearSupabaseLocalStorage();
      state.session = null;
      state.user = null;
      state.profile = null;
      closeAuthModal();
      await renderPage();
      toast('Sesión cerrada.');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = old; }
    }
  }

  function clearSupabaseLocalStorage() {
    try {
      Object.keys(localStorage).forEach(key => {
        if (key === STORAGE_KEY || key === SESSION_BACKUP_KEY || key === ACTIVITY_KEY || key.startsWith('sb-') || key.includes('supabase')) {
          localStorage.removeItem(key);
        }
      });
      sessionStorage.clear();
    } catch (_) {}
  }

  function renderAuth() {
    $all('.admin-only').forEach(el => {
      if (isAdmin()) {
        el.style.display = adminDisplayFor(el);
        el.setAttribute('data-admin-visible', 'true');
      } else {
        el.style.display = 'none';
        el.removeAttribute('data-admin-visible');
      }
    });
    const text = $('#loginButtonText');
    if (text) text.textContent = isLoggedIn() ? 'Mi sesión' : 'Iniciar sesión';
    const btn = $('#loginButton');
    if (btn) btn.classList.toggle('admin-session', isAdmin());
    const current = $('#authCurrentUser');
    const google = $('#googleLoginButton');
    const logout = $('#logoutButton');
    if (current) {
      if (isLoggedIn()) {
        const name = state.profile?.full_name || state.user.user_metadata?.full_name || state.user.user_metadata?.name || state.user.email;
        current.classList.remove('d-none');
        current.innerHTML = `<div class="user-avatar"><i class='uil uil-user-circle'></i></div><div><strong>${esc(name)}</strong><span>${esc(state.profile?.email || state.user.email)} · ${isAdmin() ? 'Administrador' : 'Visualizador'}</span></div>`;
      } else {
        current.classList.add('d-none');
        current.innerHTML = '';
      }
    }
    if (google) google.classList.toggle('d-none', isLoggedIn());
    if (logout) logout.classList.toggle('d-none', !isLoggedIn());
  }

  function openAuthModal() { $('#authModal')?.classList.add('show'); renderAuth(); }
  function closeAuthModal() { $('#authModal')?.classList.remove('show'); }

  function adminDisplayFor(el) {
    if (!el) return '';
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'li') return 'list-item';
    if (tag === 'a' || tag === 'button') return 'inline-flex';
    if (el.classList.contains('row')) return 'flex';
    if (el.className && String(el.className).includes('col-')) return 'block';
    return 'block';
  }

  async function dashboard() {
    bindDashboard();
    await loadDashboardData();
    renderDashboard();
  }

  function bindDashboard() {
    bindOnce('#careerForm', 'submit', saveCareer);
    bindOnce('#courseForm', 'submit', saveCourse);
    bindOnce('#cancelCareerEdit', 'click', resetCareerForm);
    bindOnce('#cancelCourseEdit', 'click', resetCourseForm);
    bindOnce('#courseCareers', 'change', () => fillSemesterSelect());
    bindOnce('#careerFilter', 'change', () => { fillSemesterFilter(); renderCourses(); });
    bindOnce('#semesterFilter', 'change', renderCourses);
    bindOnce('#searchCourse', 'input', renderCourses);
    bindOnce('#clearFilters', 'click', () => { $('#careerFilter').value = 'all'; $('#semesterFilter').value = 'all'; $('#searchCourse').value = ''; fillSemesterFilter(); renderCourses(); });
    if ($('#courseYear')) $('#courseYear').value = $('#courseYear').value || new Date().getFullYear();
  }

  async function loadDashboardData() {
    const [careers, courses, links, materials] = await Promise.all([
      readRows('careers', q => q.select('*').order('created_at', { ascending: true }), 'educlass_public_careers'),
      readRows('courses', q => q.select('*').order('semester', { ascending: true }).order('name', { ascending: true }), 'educlass_public_courses'),
      readRows('course_careers', q => q.select('course_id, career_id'), 'educlass_public_course_careers').catch(() => []),
      readRows('materials', q => q.select('*').order('created_at', { ascending: false }), 'educlass_public_materials', { p_course_id: null, p_section: null })
    ]);
    state.careers = (careers || []).map(mapCareer);
    state.links = links || [];
    const linkMap = {};
    state.links.forEach(l => { if (!linkMap[l.course_id]) linkMap[l.course_id] = []; if (l.career_id) linkMap[l.course_id].push(l.career_id); });
    state.courses = (courses || []).map(c => mapCourse(c, linkMap[c.id]));
    state.materials = (materials || []).map(mapMaterial);
    if (isSuperAdmin()) await loadProfiles();
  }

  async function readRows(table, builder, rpc, rpcArgs) {
    const query = builder(state.client.from(table));
    const result = await withTimeout(query, `La consulta de ${table} tardó demasiado.`, 20000);
    if (!result.error) return result.data || [];
    console.warn(`Select ${table} falló, usando RPC público:`, result.error.message);
    if (!rpc) throw result.error;
    const fallback = await withTimeout(state.client.rpc(rpc, rpcArgs || {}), `La consulta pública de ${table} tardó demasiado.`, 20000);
    if (fallback.error) throw fallback.error;
    return fallback.data || [];
  }

  async function loadProfiles() {
    const { data, error } = await state.client.from('profiles').select('id, full_name, email, role, created_at').order('created_at', { ascending: false });
    if (!error) {
      state.profiles = data || [];
      return;
    }
    console.warn('Select profiles falló, intentando RPC:', error.message);
    const fallback = await state.client.rpc('educlass_admin_profiles').catch(err => ({ data: null, error: err }));
    if (fallback.error) {
      console.warn('RPC profiles falló:', fallback.error.message || fallback.error);
      state.profiles = state.user ? [{
        id: state.user.id,
        full_name: state.profile?.full_name || state.user.user_metadata?.full_name || state.user.user_metadata?.name || state.user.email,
        email: state.user.email,
        role: isAdmin() ? 'admin' : 'viewer',
        created_at: new Date().toISOString()
      }] : [];
      return;
    }
    state.profiles = fallback.data || [];
  }

  function renderDashboard() {
    renderAuth();
    setText('careerCount', state.careers.length);
    setText('courseCount', state.courses.length);
    setText('materialCount', state.materials.length);
    setText('semesterCount', state.careers.length ? Math.max(...state.careers.map(c => c.semesters)) : 0);
    fillCareerControls();
    fillSemesterFilter();
    renderCareers();
    renderCourses();
    renderRoleControl();
  }

  function fillCareerControls(selectedIds) {
    const courseCareers = $('#courseCareers');
    const careerFilter = $('#careerFilter');
    if (courseCareers) {
      const current = selectedIds || selectedOptions(courseCareers);
      courseCareers.innerHTML = state.careers.length ? state.careers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('') : '<option value="">Crea una carrera primero</option>';
      const valid = current.filter(id => state.careers.some(c => c.id === id));
      if (valid.length) setSelectedOptions(courseCareers, valid); else if (state.careers[0]) setSelectedOptions(courseCareers, [state.careers[0].id]);
      fillSemesterSelect();
    }
    if (careerFilter) {
      const previous = careerFilter.value || 'all';
      careerFilter.innerHTML = '<option value="all">Todas las carreras</option>' + state.careers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
      if (previous === 'all' || state.careers.some(c => c.id === previous)) careerFilter.value = previous;
    }
  }

  function fillSemesterSelect() {
    const sel = $('#courseSemester');
    if (!sel) return;
    const ids = selectedOptions($('#courseCareers'));
    const max = getMaxSemesters(ids);
    const old = Number(sel.value);
    sel.innerHTML = max ? Array.from({ length: max }, (_, i) => `<option value="${i + 1}">Semestre ${i + 1}</option>`).join('') : '<option value="">Sin semestres</option>';
    if (old >= 1 && old <= max) sel.value = old;
  }

  function fillSemesterFilter() {
    const sel = $('#semesterFilter');
    const filter = $('#careerFilter');
    if (!sel) return;
    const old = sel.value || 'all';
    let max = 12;
    if (filter && filter.value !== 'all') max = getCareer(filter.value)?.semesters || 12;
    else if (state.careers.length) max = Math.max(...state.careers.map(c => c.semesters));
    sel.innerHTML = '<option value="all">Todos los semestres</option>' + Array.from({ length: max }, (_, i) => `<option value="${i + 1}">Semestre ${i + 1}</option>`).join('');
    if ([...sel.options].some(o => o.value === old)) sel.value = old;
  }

  function renderCareers() {
    const grid = $('#careerGrid');
    if (!grid) return;
    if (!state.careers.length) {
      grid.innerHTML = `<div class="col-12"><div class="empty-state"><i class='uil uil-building'></i><h3>No hay carreras creadas</h3><p>Aún no hay carreras publicadas.</p></div></div>`;
      return;
    }
    grid.innerHTML = state.careers.map(c => {
      const count = state.courses.filter(course => course.careerIds.includes(c.id)).length;
      return `<div class="col-lg-4 col-md-6 col-12 mb-4"><article class="career-card"><span class="card-icon"><i class='uil uil-university'></i></span><h3>${esc(c.name)}</h3><div class="career-meta"><span class="badge-soft"><i class='uil uil-layer-group'></i> ${c.semesters} semestres</span><span class="badge-soft"><i class='uil uil-books'></i> ${count} cursos</span></div><p>Bloque académico para organizar cursos y materiales.</p><div class="career-actions"><button class="icon-btn filter-career" type="button" data-id="${c.id}">Ver cursos</button>${isAdmin() ? `<button class="icon-btn edit-career" type="button" data-id="${c.id}">Editar</button><button class="icon-btn danger-btn delete-career" type="button" data-id="${c.id}">Borrar</button>` : ''}</div></article></div>`;
    }).join('');
    grid.querySelectorAll('.filter-career').forEach(b => b.addEventListener('click', () => { $('#careerFilter').value = b.dataset.id; fillSemesterFilter(); renderCourses(); $('#cursos')?.scrollIntoView({ behavior: 'smooth' }); }));
    grid.querySelectorAll('.edit-career').forEach(b => b.addEventListener('click', () => editCareer(b.dataset.id)));
    grid.querySelectorAll('.delete-career').forEach(b => b.addEventListener('click', () => deleteCareer(b.dataset.id, b)));
  }

  function renderCourses() {
    const grid = $('#courseGrid');
    const empty = $('#emptyCourses');
    if (!grid) return;
    const careerFilter = $('#careerFilter')?.value || 'all';
    const semesterFilter = $('#semesterFilter')?.value || 'all';
    const term = normalizeText($('#searchCourse')?.value || '');
    const filtered = state.courses.filter(c => {
      const matchesCareer = careerFilter === 'all' || c.careerIds.includes(careerFilter);
      const matchesSemester = semesterFilter === 'all' || Number(c.semester) === Number(semesterFilter);
      const hay = normalizeText(`${c.name} ${c.code || ''} ${c.teacher || ''} ${c.description || ''}`);
      return matchesCareer && matchesSemester && (!term || hay.includes(term));
    });
    if (empty) empty.classList.toggle('d-none', filtered.length > 0);
    grid.innerHTML = filtered.map(c => courseCard(c)).join('');
    grid.querySelectorAll('.edit-course').forEach(b => b.addEventListener('click', () => editCourse(b.dataset.id)));
    grid.querySelectorAll('.delete-course').forEach(b => b.addEventListener('click', () => deleteCourse(b.dataset.id, b)));
    grid.querySelectorAll('.section-links a').forEach(a => {
      a.addEventListener('pointerdown', snapshotSessionForNavigation);
      a.addEventListener('mousedown', snapshotSessionForNavigation);
      a.addEventListener('click', async () => {
        snapshotSessionForNavigation();
        if (!state.client) return;
        const { data } = await state.client.auth.getSession().catch(() => ({ data: null }));
        if (data && data.session) rememberSession(data.session);
        if (state.profile) rememberProfile(state.profile);
      });
    });
  }

  function courseCard(c) {
    const materialCount = state.materials.filter(m => m.courseId === c.id).length;
    const careerNames = c.careerIds.map(id => getCareer(id)?.name).filter(Boolean).join(', ') || 'Sin carrera';
    return `<div class="col-lg-6 col-12 mb-4"><article class="course-card"><div class="course-header"><div><span class="badge-soft">${esc(c.code || 'Sin código')}</span><h3>${esc(c.name)}</h3></div><span class="semester-pill">Semestre ${esc(c.semester)}</span></div><p>${esc(c.description || 'Curso disponible para consulta de materiales.')}</p><div class="course-details"><span><i class='uil uil-user'></i> ${esc(c.teacher || 'Docente pendiente')}</span><span><i class='uil uil-calendar-alt'></i> ${esc(c.year || '')}</span><span><i class='uil uil-university'></i> ${esc(careerNames)}</span><span><i class='uil uil-folder'></i> ${materialCount} materiales</span></div><div class="section-links">${Object.entries(SECTION_LABELS).map(([key, info]) => `<a href="section.html?course=${encodeURIComponent(c.id)}&section=${key}" target="_blank" rel="noopener"><i class='uil ${info.icon}'></i> ${info.title}</a>`).join('')}</div>${isAdmin() ? `<div class="course-actions"><button class="icon-btn edit-course" type="button" data-id="${c.id}">Editar</button><button class="icon-btn danger-btn delete-course" type="button" data-id="${c.id}">Borrar</button></div>` : ''}</article></div>`;
  }

  async function saveCareer(e) {
    e.preventDefault();
    if (!isAdmin()) return toast('Solo un administrador puede crear carreras.');
    await buttonTask('#saveCareerBtn', async () => {
      const id = $('#editingCareerId').value;
      const payload = { name: $('#careerName').value.trim(), semesters_count: Number($('#careerSemesters').value || 10), updated_at: new Date().toISOString() };
      if (!payload.name) throw new Error('Escribe el nombre de la carrera.');
      if (payload.semesters_count < 1 || payload.semesters_count > 12) throw new Error('La carrera debe tener entre 1 y 12 semestres.');
      const query = id
        ? state.client.from('careers').update(payload).eq('id', id).select('*').maybeSingle()
        : state.client.from('careers').insert({ ...payload, created_by: state.user.id }).select('*').maybeSingle();
      const result = await withTimeout(query, 'Guardar carrera tardó demasiado.', 12000);
      if (result.error) throw result.error;
      const saved = mapCareer(result.data);
      if (id) state.careers = state.careers.map(c => c.id === saved.id ? saved : c);
      else state.careers.push(saved);
      resetCareerForm();
      renderDashboard();
      toast(id ? 'Carrera actualizada.' : 'Carrera creada.');
      loadDashboardData().then(renderDashboard).catch(console.warn);
    }, 'Guardando...');
  }

  async function saveCourse(e) {
    e.preventDefault();
    if (!isAdmin()) return toast('Solo un administrador puede crear cursos.');
    await buttonTask('#saveCourseBtn', async () => {
      const id = $('#editingCourseId').value;
      const careerIds = selectedOptions($('#courseCareers'));
      if (!careerIds.length) throw new Error('Selecciona al menos una carrera.');
      const year = Number($('#courseYear').value || new Date().getFullYear());
      const payload = {
        career_id: careerIds[0],
        semester: Number($('#courseSemester').value),
        name: $('#courseName').value.trim(),
        code: $('#courseCode').value.trim(),
        teacher: $('#courseTeacher').value.trim(),
        course_year: Number.isFinite(year) ? year : null,
        description: $('#courseDescription').value.trim(),
        updated_at: new Date().toISOString()
      };
      if (!payload.name) throw new Error('Escribe el nombre del curso.');
      const query = id
        ? state.client.from('courses').update(payload).eq('id', id).select('*').maybeSingle()
        : state.client.from('courses').insert({ ...payload, created_by: state.user.id }).select('*').maybeSingle();
      const result = await withTimeout(query, 'Guardar curso tardó demasiado.', 12000);
      if (result.error) throw result.error;
      const courseId = result.data?.id || id;
      await replaceCourseCareers(courseId, careerIds);
      const saved = mapCourse(result.data, careerIds);
      if (id) state.courses = state.courses.map(c => c.id === saved.id ? saved : c);
      else state.courses.push(saved);
      state.links = state.links.filter(l => l.course_id !== courseId).concat(careerIds.map(career_id => ({ course_id: courseId, career_id })));
      resetCourseForm();
      renderDashboard();
      toast(id ? 'Curso actualizado.' : 'Curso creado.');
      loadDashboardData().then(renderDashboard).catch(console.warn);
    }, 'Guardando...');
  }

  async function replaceCourseCareers(courseId, careerIds) {
    const rpc = await withTimeout(
      state.client.rpc('educlass_set_course_careers', { p_course_id: courseId, p_career_ids: careerIds }),
      'Asignar carreras tardó demasiado.',
      12000
    ).catch(error => ({ error }));
    if (!rpc.error) return;
    console.warn('RPC educlass_set_course_careers falló, usando fallback:', rpc.error.message || rpc.error);
    const del = await withTimeout(state.client.from('course_careers').delete().eq('course_id', courseId), 'Limpiar carreras tardó demasiado.', 12000);
    if (del.error) throw del.error;
    const rows = careerIds.map(career_id => ({ course_id: courseId, career_id }));
    const ins = await withTimeout(state.client.from('course_careers').insert(rows), 'Guardar carreras tardó demasiado.', 12000);
    if (ins.error) throw ins.error;
  }

  function editCareer(id) {
    const c = getCareer(id); if (!c) return;
    $('#editingCareerId').value = c.id; $('#careerName').value = c.name; $('#careerSemesters').value = c.semesters;
    $('#saveCareerBtn').innerHTML = `<i class='uil uil-save'></i> Actualizar carrera`;
    $('#cancelCareerEdit').classList.remove('d-none'); $('#administracion')?.scrollIntoView({ behavior: 'smooth' });
  }

  function editCourse(id) {
    const c = state.courses.find(x => x.id === id); if (!c) return;
    $('#editingCourseId').value = c.id; fillCareerControls(c.careerIds); fillSemesterSelect(); $('#courseSemester').value = c.semester;
    $('#courseName').value = c.name; $('#courseCode').value = c.code || ''; $('#courseTeacher').value = c.teacher || ''; $('#courseYear').value = c.year || new Date().getFullYear(); $('#courseDescription').value = c.description || '';
    $('#saveCourseBtn').innerHTML = `<i class='uil uil-save'></i> Actualizar curso`;
    $('#cancelCourseEdit').classList.remove('d-none'); $('#administracion')?.scrollIntoView({ behavior: 'smooth' });
  }

  function resetCareerForm() { $('#careerForm')?.reset(); $('#editingCareerId').value = ''; $('#careerSemesters').value = 10; $('#saveCareerBtn').innerHTML = `<i class='uil uil-save'></i> Guardar carrera`; $('#cancelCareerEdit').classList.add('d-none'); }
  function resetCourseForm() { $('#courseForm')?.reset(); $('#editingCourseId').value = ''; $('#courseYear').value = new Date().getFullYear(); $('#saveCourseBtn').innerHTML = `<i class='uil uil-save'></i> Guardar curso`; $('#cancelCourseEdit').classList.add('d-none'); fillCareerControls(); }

  async function deleteCourse(id, btn) {
    if (!isAdmin()) return;
    const c = state.courses.find(x => x.id === id); if (!c) return;
    if (!(await confirmDialog('Borrar curso', `¿Deseas borrar el curso "${c.name}"?`, 'Sí, borrar'))) return;
    await buttonTask(btn, async () => {
      const rpc = await withTimeout(state.client.rpc('educlass_delete_course', { p_course_id: id }), 'Borrar curso tardó demasiado.', 12000).catch(error => ({ error }));
      if (rpc.error) {
        console.warn('RPC educlass_delete_course falló, usando fallback:', rpc.error.message || rpc.error);
        const result = await withTimeout(state.client.from('courses').delete().eq('id', id), 'Borrar curso tardó demasiado.', 12000);
        if (result.error) throw result.error;
      }
      state.courses = state.courses.filter(x => x.id !== id); state.materials = state.materials.filter(m => m.courseId !== id); state.links = state.links.filter(l => l.course_id !== id);
      renderDashboard();
      toast('Curso borrado.');
      loadDashboardData().then(renderDashboard).catch(console.warn);
    }, 'Borrando...');
  }

  async function deleteCareer(id, btn) {
    if (!isAdmin()) return;
    const c = getCareer(id); if (!c) return;
    if (!(await confirmDialog('Borrar carrera', `¿Deseas borrar la carrera "${c.name}"? Los cursos únicos de esta carrera también se eliminarán.`, 'Sí, borrar'))) return;
    await buttonTask(btn, async () => {
      const rpc = await withTimeout(state.client.rpc('educlass_delete_career', { p_career_id: id }), 'Borrar carrera tardó demasiado.', 15000).catch(error => ({ error }));
      if (rpc.error) {
        console.warn('RPC educlass_delete_career falló, usando fallback:', rpc.error.message || rpc.error);
        const affected = state.courses.filter(course => course.careerIds.includes(id));
        for (const course of affected) {
          if (course.careerIds.length <= 1) {
            const res = await withTimeout(state.client.from('courses').delete().eq('id', course.id), 'Borrar curso relacionado tardó demasiado.', 10000); if (res.error) throw res.error;
          } else {
            const del = await withTimeout(state.client.from('course_careers').delete().eq('course_id', course.id).eq('career_id', id), 'Quitar relación tardó demasiado.', 10000); if (del.error) throw del.error;
            if (course.careerId === id) {
              const newPrimary = course.careerIds.find(cid => cid !== id);
              const upd = await withTimeout(state.client.from('courses').update({ career_id: newPrimary }).eq('id', course.id), 'Actualizar curso tardó demasiado.', 10000); if (upd.error) throw upd.error;
            }
          }
        }
        const result = await withTimeout(state.client.from('careers').delete().eq('id', id), 'Borrar carrera tardó demasiado.', 10000); if (result.error) throw result.error;
      }
      state.careers = state.careers.filter(x => x.id !== id);
      state.links = state.links.filter(l => l.career_id !== id);
      state.courses = state.courses
        .map(course => ({ ...course, careerIds: course.careerIds.filter(cid => cid !== id) }))
        .filter(course => course.careerIds.length > 0);
      renderDashboard();
      toast('Carrera borrada.');
      loadDashboardData().then(renderDashboard).catch(console.warn);
    }, 'Borrando...');
  }

  function renderRoleControl() {
    const holder = $('#roleControlHolder'); if (!holder) return;
    if (!isSuperAdmin()) { holder.innerHTML = ''; return; }
    const rows = state.profiles.map(p => `<tr><td>${esc(p.full_name || p.email)}</td><td>${esc(p.email)}</td><td><span class="badge-soft">${p.role === 'admin' ? 'Administrador' : 'Visualizador'}</span></td><td>${normalizeEmail(p.email) === ROOT_ADMIN_EMAIL ? '<strong>Protegido</strong>' : `<button class="btn btn-sm custom-btn role-toggle" data-id="${p.id}" data-role="${p.role === 'admin' ? 'viewer' : 'admin'}">${p.role === 'admin' ? 'Quitar admin' : 'Hacer admin'}</button>`}</td></tr>`).join('');
    holder.innerHTML = `<div class="admin-card mt-4"><h3><i class='uil uil-user-check'></i> Control de roles</h3><p class="hint-text">Solo el administrador principal puede cambiar roles.</p><div class="table-responsive"><table class="table role-table"><thead><tr><th>Usuario</th><th>Correo</th><th>Rol</th><th>Acción</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No hay usuarios registrados.</td></tr>'}</tbody></table></div></div>`;
    holder.querySelectorAll('.role-toggle').forEach(b => b.addEventListener('click', () => updateRole(b.dataset.id, b.dataset.role, b)));
  }

  async function updateRole(id, role, btn) {
    if (!isSuperAdmin()) return toast('Solo el administrador principal puede cambiar roles.');
    const profile = state.profiles.find(p => p.id === id);
    if (!profile || normalizeEmail(profile.email) === ROOT_ADMIN_EMAIL) return toast('Este usuario está protegido.');
    await buttonTask(btn, async () => {
      const rpc = await withTimeout(
        state.client.rpc('educlass_set_profile_role', { p_user_id: id, p_role: role }),
        'Actualizar rol tardó demasiado.',
        10000
      ).catch(error => ({ error }));
      if (rpc.error) {
        console.warn('RPC educlass_set_profile_role falló, usando fallback:', rpc.error.message || rpc.error);
        const direct = await withTimeout(state.client.from('profiles').update({ role }).eq('id', id), 'Actualizar rol tardó demasiado.', 10000);
        if (direct.error) throw direct.error;
      }
      state.profiles = state.profiles.map(p => p.id === id ? { ...p, role } : p);
      renderRoleControl();
      toast('Rol actualizado.');
      loadProfiles().then(renderRoleControl).catch(console.warn);
    }, 'Guardando...');
  }

  async function sectionPage() {
    bindOnce('#materialForm', 'submit', saveMaterial);
    bindOnce('#materialSearch', 'input', renderMaterials);
    // Las secciones se abren en pestañas nuevas. Revalidamos la sesión justo aquí para
    // mantener permisos de admin aunque el navegador haya tardado en hidratar localStorage.
    await loadSession(true);
    snapshotSessionForNavigation();
    await loadSectionData();
    renderSection();
  }

  function sectionParams() {
    const p = new URLSearchParams(window.location.search);
    return { courseId: p.get('course'), section: p.get('section') || 'contenido' };
  }

  async function loadSectionData() {
    const { courseId, section } = sectionParams();
    if (!courseId) return;
    const [courses, links, materials] = await Promise.all([
      readRows('courses', q => q.select('*').eq('id', courseId), 'educlass_public_courses', { p_course_id: courseId }),
      readRows('course_careers', q => q.select('course_id, career_id').eq('course_id', courseId), 'educlass_public_course_careers').catch(() => []),
      readRows('materials', q => q.select('*').eq('course_id', courseId).eq('section', section).order('created_at', { ascending: false }), 'educlass_public_materials', { p_course_id: courseId, p_section: section })
    ]);
    const ids = (links || []).map(l => l.career_id).filter(Boolean);
    state.courses = (courses || []).map(c => mapCourse(c, ids));
    state.materials = (materials || []).map(mapMaterial);
  }

  function renderSection() {
    renderAuth();
    const { courseId, section } = sectionParams();
    const course = state.courses.find(c => c.id === courseId);
    const info = SECTION_LABELS[section] || SECTION_LABELS.contenido;
    setText('sectionTitle', info.title);
    $('#sectionBadge') && ($('#sectionBadge').innerHTML = `<i class='uil ${info.icon}'></i>`);
    if (course) {
      setText('sectionCourseCode', `${course.code || 'Curso'} · ${course.name}`);
      setText('sectionSubtitle', `${course.teacher || 'Docente pendiente'} · Semestre ${course.semester}`);
    } else {
      setText('sectionSubtitle', 'No se encontró el curso solicitado.');
    }
    renderMaterials();
  }

  function renderMaterials() {
    const list = $('#materialList');
    const empty = $('#emptyMaterials');
    if (!list) return;
    const term = normalizeText($('#materialSearch')?.value || '');
    const items = state.materials.filter(m => !term || normalizeText(`${m.title} ${m.text || ''} ${m.fileName || ''}`).includes(term));
    if (empty) empty.classList.toggle('d-none', items.length > 0);
    list.innerHTML = items.map(materialCard).join('');
    list.querySelectorAll('.delete-material').forEach(b => b.addEventListener('click', () => deleteMaterial(b.dataset.id, b)));
  }

  function materialCard(m) {
    const url = m.filePath ? publicUrl(m.filePath) : '';
    return `<article class="material-card"><div><span class="badge-soft">${esc(m.type || 'texto')}</span><h3>${esc(m.title)}</h3>${m.text ? `<p>${esc(m.text)}</p>` : ''}${m.fileName ? `<p><i class='uil uil-paperclip'></i> ${esc(m.fileName)}</p>` : ''}</div><div class="material-actions">${url ? `<a class="icon-btn" href="${esc(url)}" target="_blank" rel="noopener"><i class='uil uil-external-link-alt'></i> Abrir</a>` : ''}${isAdmin() ? `<button class="icon-btn danger-btn delete-material" type="button" data-id="${m.id}">Borrar</button>` : ''}</div></article>`;
  }

  async function saveMaterial(e) {
    e.preventDefault();
    if (!isAdmin()) return toast('Solo un administrador puede subir materiales.');
    const { courseId, section } = sectionParams();
    await buttonTask('#saveMaterialBtn', async () => {
      const title = $('#materialTitle').value.trim();
      const text = $('#materialText').value.trim();
      const file = $('#materialFile').files[0] || null;
      if (!title) throw new Error('Escribe el título del material.');
      let fileData = {};
      if (file) {
        const path = `${courseId}/${section}/${Date.now()}-${safeFileName(file.name)}`;
        const uploaded = await state.client.storage.from(cfg.storageBucket || 'materials').upload(path, file, { upsert: false });
        if (uploaded.error) throw uploaded.error;
        fileData = { file_path: path, file_name: file.name, file_mime: file.type || null, file_size: file.size || null, material_type: materialType(file) };
      }
      const { data, error } = await state.client.from('materials').insert({
        course_id: courseId,
        section,
        title,
        text_content: text || null,
        material_type: fileData.material_type || 'texto',
        file_path: fileData.file_path || null,
        file_name: fileData.file_name || null,
        file_mime: fileData.file_mime || null,
        file_size: fileData.file_size || null,
        created_by: state.user.id
      }).select('*').maybeSingle();
      if (error) throw error;
      state.materials.unshift(mapMaterial(data));
      $('#materialForm').reset();
      renderMaterials();
      toast('Material guardado.');
    }, 'Guardando...');
  }

  async function deleteMaterial(id, btn) {
    if (!isAdmin()) return;
    const m = state.materials.find(x => x.id === id); if (!m) return;
    if (!(await confirmDialog('Borrar material', `¿Deseas borrar "${m.title}"?`, 'Sí, borrar'))) return;
    await buttonTask(btn, async () => {
      if (m.filePath) await state.client.storage.from(cfg.storageBucket || 'materials').remove([m.filePath]).catch(() => null);
      const { error } = await state.client.from('materials').delete().eq('id', id); if (error) throw error;
      state.materials = state.materials.filter(x => x.id !== id); renderMaterials(); toast('Material borrado.');
    }, 'Borrando...');
  }

  function mapCareer(r) { return { id: r.id, name: r.name || 'Sin nombre', semesters: Number(r.semesters_count || r.semesters || 10), createdAt: r.created_at }; }
  function mapCourse(r, ids) { const careerIds = (ids && ids.length ? ids : [r.career_id].filter(Boolean)).map(String); return { id: r.id, careerId: r.career_id, careerIds, semester: Number(r.semester || 1), name: r.name || 'Sin nombre', code: r.code || '', teacher: r.teacher || '', year: r.course_year || '', description: r.description || '' }; }
  function mapMaterial(r) { return { id: r.id, courseId: r.course_id, section: r.section, title: r.title || 'Material', type: r.material_type || 'texto', text: r.text_content || '', filePath: r.file_path || '', fileName: r.file_name || '', createdAt: r.created_at }; }

  function getCareer(id) { return state.careers.find(c => c.id === id); }
  function getMaxSemesters(ids) { const careers = (ids || []).map(getCareer).filter(Boolean); return careers.length ? Math.max(...careers.map(c => c.semesters)) : (state.careers[0]?.semesters || 0); }
  function selectedOptions(select) { return select ? Array.from(select.selectedOptions || []).map(o => o.value).filter(Boolean) : []; }
  function setSelectedOptions(select, ids) { if (!select) return; const set = new Set(ids.map(String)); Array.from(select.options).forEach(o => { o.selected = set.has(o.value); }); }
  function materialType(file) { const t = String(file.type || '').toLowerCase(); const n = String(file.name || '').toLowerCase(); if (t.includes('image') || /\.(png|jpe?g|webp|gif)$/.test(n)) return 'imagen'; if (t.includes('pdf') || n.endsWith('.pdf')) return 'pdf'; if (t.includes('word') || /\.(doc|docx)$/.test(n)) return 'word'; return 'archivo'; }
  function publicUrl(path) { const { data } = state.client.storage.from(cfg.storageBucket || 'materials').getPublicUrl(path); return data?.publicUrl || ''; }
  function safeFileName(name) { return String(name || 'archivo').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase(); }

  async function buttonTask(target, fn, loadingText) {
    const btn = typeof target === 'string' ? $(target) : target;
    const old = btn ? btn.innerHTML : '';
    try {
      if (btn) { btn.disabled = true; btn.innerHTML = `<i class='uil uil-sync'></i> ${loadingText || 'Procesando...'}`; }
      await withTimeout(fn(), 'La operación tardó demasiado. Recarga la página e inténtalo otra vez.', 25000);
    } catch (error) {
      console.error(error);
      toast(error.message || 'No se pudo completar la operación.');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = old; }
    }
  }

  function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  function withTimeout(promise, message, ms) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
  }

  function confirmDialog(title, message, okText) {
    const modal = $('#confirmDialog'); if (!modal) return Promise.resolve(window.confirm(message));
    setText('confirmTitle', title); setText('confirmMessage', message); setText('confirmOk', okText || 'Confirmar');
    modal.classList.add('show');
    return new Promise(resolve => {
      const ok = $('#confirmOk'); const cancel = $('#confirmCancel');
      const done = value => { modal.classList.remove('show'); ok.removeEventListener('click', okFn); cancel.removeEventListener('click', cancelFn); resolve(value); };
      const okFn = () => done(true); const cancelFn = () => done(false);
      ok.addEventListener('click', okFn); cancel.addEventListener('click', cancelFn);
    });
  }

  function renderConfigNotice(msg) {
    ['careerGrid', 'courseGrid', 'materialList'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = `<div class="col-12"><div class="empty-state setup-state"><i class='uil uil-setting'></i><h3>Falta conectar Supabase</h3><p>${esc(msg)}</p></div></div>`; });
  }

  function toast(msg) { const el = $('#toastMessage'); if (!el) return; el.textContent = msg; el.classList.add('show'); clearTimeout(toast._timer); toast._timer = setTimeout(() => el.classList.remove('show'), 4200); }
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.from(document.querySelectorAll(sel)); }
  function on(sel, evt, fn) { const el = $(sel); if (el) el.addEventListener(evt, fn); }
  function bindOnce(sel, evt, fn) { const el = $(sel); if (!el || el.dataset[`bound${evt}`]) return; el.dataset[`bound${evt}`] = '1'; el.addEventListener(evt, fn); }
  function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
  function esc(v) { return String(v ?? '').replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch])); }
  function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }
  function normalizeText(text) { return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
})();
