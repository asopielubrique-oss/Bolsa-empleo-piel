// ============================================================
// PORTAL DE EMPLEO · PIEL DE UBRIQUE
// Cloudflare Worker único — API + assets
// Cuenta: asopielubrique
// ============================================================

// ── Categorías de oficio ────────────────────────────────────
const CATEGORIAS_FABRICACION = [
  'Encargado de fabricación',
  'Encargado de sección / Jefe de taller',
  'Modelista / Patronista',
  'Jefe de grupo / Jefe de línea (≥50 trabajadores)',
  'Jefe de grupo / Jefe de línea (<50 trabajadores)',
  'Oficial de primera',
  'Oficial de segunda',
  'Oficial de tercera',
  'Especialista',
  'Peón',
  'Ayudante',
  'Aspirante',
];

const OFICIOS_FABRICACION = [
  'Montador',
  'Cortador',
  'Rebaje y dividido (chiflador)',
  'Pintura',
  'Costura',
  'Grabado',
  'Timbrado',
  'Empaste',
  'Retroquelado',
  'Arrematado',
];

const CATEGORIAS_OFICINA = [
  'Jefatura de almacén',
  'Jefatura de compras y ventas',
  'Jefatura de negociado',
  'Jefatura de sección',
  'Oficial 1º Administrativo',
  'Oficial 2º Administrativo',
  'Analista programador',
  'Secretario/a',
  'Personal técnico de informática',
  'Controlador',
  'Recepción de almacén',
  'Auxiliar de administración',
  'Recepción / Telefonía',
  'Auxiliar de patrones',
  'Auxiliar de control',
  'Conductor',
  'Técnico de mantenimiento',
  'Auxiliar de almacén',
  'Vigilancia',
  'Personal de limpieza',
  'Auxiliar de mantenimiento',
  'Ordenanza',
  'Operario de servicios varios',
];

// ── Helpers ─────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function generateId() {
  return crypto.randomUUID().replace(/-/g, '').substring(0, 12);
}

function generatePassword(len = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pw = '';
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  for (const b of arr) pw += chars[b % chars.length];
  return pw;
}

async function hashPassword(pw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Portal Empleo <oficina@asopiel.com>', to, subject, html }),
  });
}

// ── Auth middleware ──────────────────────────────────────────
async function authenticate(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const [userId] = token.split(':');
  if (!userId) return null;
  const user = await env.BOLSA_KV.get(`user:${userId}`, 'json');
  if (!user) return null;
  const expectedToken = `${userId}:${user.password}`;
  if (token !== expectedToken) return null;
  return user;
}

// ── KV structure ─────────────────────────────────────────────
// user:{id}           → { id, email, password(hash), role, nombre, status, createdAt }
// empresa:{id}        → { id, userId, nombre, cif, contacto, telefono, email, status, createdAt }
// trabajador:{id}     → { id, userId, nombre, apellidos, dni, telefono, email, direccion, localidad, status, createdAt }
// empleo:{id}         → { id, trabajadorId, empresa, cif, sector(fabricacion|oficina), categoria, oficio, fechaInicio, fechaFin, enActivo, tareas, certificadoUrl, certificadoValidado, createdAt }
// oferta:{id}         → { id, empresaId, titulo, descripcion, categoria, oficio, sector, publica, status(pendiente|activa|cerrada), perfilesDesbloqueados[], createdAt }
// cert:{id}           → { id, empleoId, trabajadorId, url, validado, validadoAt, createdAt }
// idx:empresas        → [id, ...]
// idx:trabajadores    → [id, ...]
// idx:ofertas         → [id, ...]
// idx:users           → [id, ...]

async function getIndex(env, key) {
  return (await env.BOLSA_KV.get(key, 'json')) || [];
}
async function addToIndex(env, key, id) {
  const idx = await getIndex(env, key);
  if (!idx.includes(id)) { idx.push(id); await env.BOLSA_KV.put(key, JSON.stringify(idx)); }
}

// ── Router ───────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      if (method === 'OPTIONS') {
        return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' } });
      }

      // ── Reset passwords de usuarios de ejemplo ─────────────
      if (path === '/reset-sample' && method === 'POST') {
        const resets = [
          { userId: 'trab_046ba152adea', password: 'Trabaja123!' },
          { userId: 'trab_f1046c16bf11', password: 'Trabaja123!' },
          { userId: 'emp_2f35c9176471',  password: 'Empresa123!' },
          { userId: 'emp_b88966f7d64b',  password: 'Empresa123!' },
        ];
        const results = [];
        for (const { userId, password } of resets) {
          const u = await env.BOLSA_KV.get(`user:${userId}`, 'json');
          if (!u) { results.push({ userId, error: 'no encontrado' }); continue; }
          u.password = await hashPassword(password);
          await env.BOLSA_KV.put(`user:${userId}`, JSON.stringify(u));
          results.push({ userId, ok: true });
        }
        return json({ ok: true, results });
      }

      // ── Seed admin ─────────────────────────────────────────
      if (path === '/seed' && method === 'POST') {
        const existing = await env.BOLSA_KV.get('user:admin');
        if (existing) return json({ error: 'Ya inicializado' }, 400);
        const pw = 'asopiel2024';
        const hash = await hashPassword(pw);
        const adminUser = { id: 'admin', email: 'admin@asopiel.es', password: hash, role: 'admin', nombre: 'Administrador Asopiel', status: 'activo', createdAt: new Date().toISOString() };
        await env.BOLSA_KV.put('user:admin', JSON.stringify(adminUser));
        await addToIndex(env, 'idx:users', 'admin');
        return json({ ok: true, message: 'Admin creado. Credenciales: admin@asopiel.es / asopiel2024' });
      }

      // ── Login ──────────────────────────────────────────────
      if (path === '/login' && method === 'POST') {
        const { email, password } = await request.json();
        const ids = await getIndex(env, 'idx:users');
        for (const id of ids) {
          const u = await env.BOLSA_KV.get(`user:${id}`, 'json');
          if (u && u.email === email) {
            const hash = await hashPassword(password);
            if (hash !== u.password) return json({ error: 'Credenciales incorrectas' }, 401);
            if (u.status !== 'activo') return json({ error: 'Cuenta pendiente de aprobación' }, 403);
            const token = `${u.id}:${u.password}`;
            return json({ token, role: u.role, nombre: u.nombre, id: u.id });
          }
        }
        return json({ error: 'Credenciales incorrectas' }, 401);
      }

      // ── Categorías ─────────────────────────────────────────
      if (path === '/categorias' && method === 'GET') {
        return json({ fabricacion: CATEGORIAS_FABRICACION, oficios: OFICIOS_FABRICACION, oficina: CATEGORIAS_OFICINA });
      }

      // ── Registro empresa ───────────────────────────────────
      if (path === '/empresas/registro' && method === 'POST') {
        const body = await request.json();
        const { nombre, cif, contacto, telefono, email } = body;
        if (!nombre || !cif || !email) return json({ error: 'Faltan campos obligatorios' }, 400);
        // Verificar email duplicado
        const usersIdx = await getIndex(env, 'idx:users');
        for (const uid of usersIdx) { const u = await env.BOLSA_KV.get(`user:${uid}`, 'json'); if (u && u.email === email) return json({ error: 'Ya existe una cuenta con ese email' }, 409); }
        const id = generateId();
        const userId = `emp_${id}`;
        const pw = generatePassword();
        const hash = await hashPassword(pw);
        const user = { id: userId, email, password: hash, role: 'empresa', nombre, status: 'pendiente', createdAt: new Date().toISOString() };
        const empresa = { id, userId, nombre, cif, contacto, telefono, email, status: 'pendiente', createdAt: new Date().toISOString() };
        await env.BOLSA_KV.put(`user:${userId}`, JSON.stringify(user));
        await env.BOLSA_KV.put(`empresa:${id}`, JSON.stringify(empresa));
        await addToIndex(env, 'idx:users', userId);
        await addToIndex(env, 'idx:empresas', id);
        return json({ ok: true, message: 'Solicitud enviada. Asopiel revisará su registro en breve.' });
      }

      // ── Registro trabajador ────────────────────────────────
      if (path === '/trabajadores/registro' && method === 'POST') {
        const body = await request.json();
        const { nombre, apellidos, dni, telefono, email, direccion, localidad } = body;
        if (!nombre || !apellidos || !dni || !email) return json({ error: 'Faltan campos obligatorios' }, 400);
        // Verificar email duplicado
        const usersIdx2 = await getIndex(env, 'idx:users');
        for (const uid of usersIdx2) { const u = await env.BOLSA_KV.get(`user:${uid}`, 'json'); if (u && u.email === email) return json({ error: 'Ya existe una cuenta con ese email' }, 409); }
        const id = generateId();
        const userId = `trab_${id}`;
        const pw = generatePassword();
        const hash = await hashPassword(pw);
        const user = { id: userId, email, password: hash, role: 'trabajador', nombre: `${nombre} ${apellidos}`, status: 'pendiente', createdAt: new Date().toISOString() };
        const trabajador = { id, userId, nombre, apellidos, dni, telefono, email, direccion: direccion||'', localidad, status: 'pendiente', createdAt: new Date().toISOString() };
        await env.BOLSA_KV.put(`user:${userId}`, JSON.stringify(user));
        await env.BOLSA_KV.put(`trabajador:${id}`, JSON.stringify(trabajador));
        await addToIndex(env, 'idx:users', userId);
        await addToIndex(env, 'idx:trabajadores', id);
        return json({ ok: true, message: 'Solicitud enviada. Asopiel revisará su registro en breve.' });
      }

      // ── Autenticación requerida a partir de aquí ───────────
      const user = await authenticate(request, env);

      // ── Admin: listar pendientes ───────────────────────────
      if (path === '/admin/pendientes' && method === 'GET') {
        if (!user || user.role !== 'admin') return json({ error: 'No autorizado' }, 403);
        const empresaIds = await getIndex(env, 'idx:empresas');
        const trabajadorIds = await getIndex(env, 'idx:trabajadores');
        const empresas = (await Promise.all(empresaIds.map(id => env.BOLSA_KV.get(`empresa:${id}`, 'json')))).filter(e => e?.status === 'pendiente');
        const trabajadores = (await Promise.all(trabajadorIds.map(id => env.BOLSA_KV.get(`trabajador:${id}`, 'json')))).filter(t => t?.status === 'pendiente');
        return json({ empresas, trabajadores });
      }

      // ── Admin: aprobar empresa ─────────────────────────────
      if (path.match(/^\/admin\/empresas\/([^/]+)\/aprobar$/) && method === 'POST') {
        if (!user || user.role !== 'admin') return json({ error: 'No autorizado' }, 403);
        const id = path.split('/')[3];
        const empresa = await env.BOLSA_KV.get(`empresa:${id}`, 'json');
        if (!empresa) return json({ error: 'No encontrada' }, 404);
        empresa.status = 'activo';
        await env.BOLSA_KV.put(`empresa:${id}`, JSON.stringify(empresa));
        const u = await env.BOLSA_KV.get(`user:${empresa.userId}`, 'json');
        if (u) {
          u.status = 'activo';
          await env.BOLSA_KV.put(`user:${empresa.userId}`, JSON.stringify(u));
          const pw = generatePassword();
          const hash = await hashPassword(pw);
          u.password = hash;
          await env.BOLSA_KV.put(`user:${empresa.userId}`, JSON.stringify(u));
          await sendEmail(env, empresa.email, 'Acceso al Portal de Empleo · Piel de Ubrique',
            `<p>Hola ${empresa.nombre},</p><p>Su registro ha sido aprobado.</p><p><strong>Email:</strong> ${empresa.email}<br><strong>Contraseña:</strong> ${pw}</p><p>Acceda en: <a href="https://portalmarroquineria.asopiel.com">portalmarroquineria.asopiel.com</a></p>`);
        }
        return json({ ok: true });
      }

      // ── Admin: aprobar trabajador ──────────────────────────
      if (path.match(/^\/admin\/trabajadores\/([^/]+)\/aprobar$/) && method === 'POST') {
        if (!user || user.role !== 'admin') return json({ error: 'No autorizado' }, 403);
        const id = path.split('/')[3];
        const trabajador = await env.BOLSA_KV.get(`trabajador:${id}`, 'json');
        if (!trabajador) return json({ error: 'No encontrado' }, 404);
        trabajador.status = 'activo';
        await env.BOLSA_KV.put(`trabajador:${id}`, JSON.stringify(trabajador));
        const u = await env.BOLSA_KV.get(`user:${trabajador.userId}`, 'json');
        if (u) {
          u.status = 'activo';
          const pw = generatePassword();
          const hash = await hashPassword(pw);
          u.password = hash;
          await env.BOLSA_KV.put(`user:${trabajador.userId}`, JSON.stringify(u));
          await sendEmail(env, trabajador.email, 'Acceso al Portal de Empleo · Piel de Ubrique',
            `<p>Hola ${trabajador.nombre} ${trabajador.apellidos},</p><p>Su registro ha sido aprobado.</p><p><strong>Email:</strong> ${trabajador.email}<br><strong>Contraseña:</strong> ${pw}</p><p>Acceda en: <a href="https://portalmarroquineria.asopiel.com">portalmarroquineria.asopiel.com</a></p>`);
        }
        return json({ ok: true });
      }

      // ── Admin: rechazar registro ───────────────────────────
      if (path.match(/^\/admin\/(empresas|trabajadores)\/([^/]+)\/rechazar$/) && method === 'POST') {
        if (!user || user.role !== 'admin') return json({ error: 'No autorizado' }, 403);
        const parts = path.split('/');
        const tipo = parts[2];
        const id = parts[3];
        const key = tipo === 'empresas' ? `empresa:${id}` : `trabajador:${id}`;
        const entity = await env.BOLSA_KV.get(key, 'json');
        if (!entity) return json({ error: 'No encontrado' }, 404);
        entity.status = 'rechazado';
        await env.BOLSA_KV.put(key, JSON.stringify(entity));
        return json({ ok: true });
      }

      // ── Admin: listar todos los trabajadores ───────────────
      if (path === '/admin/trabajadores' && method === 'GET') {
        if (!user || user.role !== 'admin') return json({ error: 'No autorizado' }, 403);
        const ids = await getIndex(env, 'idx:trabajadores');
        const todos = (await Promise.all(ids.map(id => env.BOLSA_KV.get(`trabajador:${id}`, 'json')))).filter(Boolean);
        // Enriquecer con sectores del historial laboral
        for (const t of todos) {
          const empleoIds = await getIndex(env, `idx:empleos:${t.id}`);
          const empleos = (await Promise.all(empleoIds.map(eid => env.BOLSA_KV.get(`empleo:${eid}`, 'json')))).filter(Boolean);
          t.sectores = [...new Set(empleos.map(e => e.sector).filter(Boolean))];
        }
        return json(todos);
      }

      // ── Admin: listar todas las empresas ──────────────────
      if (path === '/admin/empresas' && method === 'GET') {
        if (!user || user.role !== 'admin') return json({ error: 'No autorizado' }, 403);
        const ids = await getIndex(env, 'idx:empresas');
        const todas = await Promise.all(ids.map(id => env.BOLSA_KV.get(`empresa:${id}`, 'json')));
        return json(todas.filter(Boolean));
      }

      // ── Admin: listar todas las ofertas ───────────────────
      if (path === '/admin/ofertas' && method === 'GET') {
        if (!user || user.role !== 'admin') return json({ error: 'No autorizado' }, 403);
        const ids = await getIndex(env, 'idx:ofertas');
        const todas = (await Promise.all(ids.map(id => env.BOLSA_KV.get(`oferta:${id}`, 'json')))).filter(Boolean);
        const empresaIds = await getIndex(env, 'idx:empresas');
        const empresasMap = {};
        for (const eid of empresaIds) {
          const e = await env.BOLSA_KV.get(`empresa:${eid}`, 'json');
          if (e) empresasMap[e.id] = e.nombre;
        }
        return json(todas.map(o => ({ ...o, nombreEmpresa: empresasMap[o.empresaId] || '' })));
      }

      // ── Admin: ver sugerencias de formación ───────────────
      if (path === '/admin/sugerencias' && method === 'GET') {
        if (!user || user.role !== 'admin') return json({ error: 'No autorizado' }, 403);
        const ids = await getIndex(env, 'idx:sugerencias');
        const todas = (await Promise.all(ids.map(id => env.BOLSA_KV.get(`sugerencia:${id}`, 'json')))).filter(Boolean);
        todas.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return json(todas);
      }

      // ── Admin: marcar sugerencia como leída ───────────────
      if (path.match(/^\/admin\/sugerencias\/([^/]+)\/leer$/) && method === 'POST') {
        if (!user || user.role !== 'admin') return json({ error: 'No autorizado' }, 403);
        const id = path.split('/')[3];
        const s = await env.BOLSA_KV.get(`sugerencia:${id}`, 'json');
        if (!s) return json({ error: 'No encontrada' }, 404);
        s.leida = true;
        s.leidaAt = new Date().toISOString();
        await env.BOLSA_KV.put(`sugerencia:${id}`, JSON.stringify(s));
        return json({ ok: true });
      }

      // ── Admin: activar oferta + desbloquear perfiles ───────
      if (path.match(/^\/admin\/ofertas\/([^/]+)\/desbloquear$/) && method === 'POST') {
        if (!user || user.role !== 'admin') return json({ error: 'No autorizado' }, 403);
        const id = path.split('/')[3];
        const oferta = await env.BOLSA_KV.get(`oferta:${id}`, 'json');
        if (!oferta) return json({ error: 'No encontrada' }, 404);
        const { perfiles } = await request.json(); // array de trabajadorIds
        oferta.perfilesDesbloqueados = perfiles || [];
        oferta.status = 'activa';
        await env.BOLSA_KV.put(`oferta:${id}`, JSON.stringify(oferta));
        return json({ ok: true });
      }

      // ── Admin: validar certificado ─────────────────────────
      if (path.match(/^\/admin\/certificados\/([^/]+)\/validar$/) && method === 'POST') {
        if (!user || user.role !== 'admin') return json({ error: 'No autorizado' }, 403);
        const id = path.split('/')[3];
        // El certificado está embebido en el empleo
        const empleoIds = await getIndex(env, `idx:empleos`);
        for (const eid of empleoIds) {
          const empleo = await env.BOLSA_KV.get(`empleo:${eid}`, 'json');
          if (empleo && empleo.certificadoId === id) {
            empleo.certificadoValidado = true;
            empleo.certificadoValidadoAt = new Date().toISOString();
            await env.BOLSA_KV.put(`empleo:${eid}`, JSON.stringify(empleo));
            return json({ ok: true });
          }
        }
        return json({ error: 'Certificado no encontrado' }, 404);
      }

      // ── Admin: métricas ────────────────────────────────────
      if (path === '/admin/metricas' && method === 'GET') {
        if (!user || user.role !== 'admin') return json({ error: 'No autorizado' }, 403);
        const [empIds, trabIds, ofertaIds] = await Promise.all([
          getIndex(env, 'idx:empresas'),
          getIndex(env, 'idx:trabajadores'),
          getIndex(env, 'idx:ofertas'),
        ]);
        const [empresas, trabajadores, ofertas] = await Promise.all([
          Promise.all(empIds.map(id => env.BOLSA_KV.get(`empresa:${id}`, 'json'))),
          Promise.all(trabIds.map(id => env.BOLSA_KV.get(`trabajador:${id}`, 'json'))),
          Promise.all(ofertaIds.map(id => env.BOLSA_KV.get(`oferta:${id}`, 'json'))),
        ]);
        return json({
          empresas: { total: empresas.filter(Boolean).length, activas: empresas.filter(e => e?.status === 'activo').length, pendientes: empresas.filter(e => e?.status === 'pendiente').length },
          trabajadores: { total: trabajadores.filter(Boolean).length, activos: trabajadores.filter(t => t?.status === 'activo').length, pendientes: trabajadores.filter(t => t?.status === 'pendiente').length },
          ofertas: { total: ofertas.filter(Boolean).length, activas: ofertas.filter(o => o?.status === 'activa').length, pendientes: ofertas.filter(o => o?.status === 'pendiente').length },
        });
      }

      // ── Trabajador: su perfil ──────────────────────────────
      if (path === '/mi-perfil' && method === 'GET') {
        if (!user) return json({ error: 'No autorizado' }, 401);
        if (user.role === 'trabajador') {
          const ids = await getIndex(env, 'idx:trabajadores');
          for (const id of ids) {
            const t = await env.BOLSA_KV.get(`trabajador:${id}`, 'json');
            if (t && t.userId === user.id) {
              const empleoIds = await getIndex(env, `idx:empleos:${id}`);
              const empleos = await Promise.all(empleoIds.map(eid => env.BOLSA_KV.get(`empleo:${eid}`, 'json')));
              return json({ ...t, empleos: empleos.filter(Boolean) });
            }
          }
        }
        if (user.role === 'empresa') {
          const ids = await getIndex(env, 'idx:empresas');
          for (const id of ids) {
            const e = await env.BOLSA_KV.get(`empresa:${id}`, 'json');
            if (e && e.userId === user.id) return json(e);
          }
        }
        return json({ error: 'Perfil no encontrado' }, 404);
      }

      // ── Trabajador: actualizar perfil (disciplinas) ───────
      if (path === '/mi-perfil' && method === 'PUT') {
        if (!user || user.role !== 'trabajador') return json({ error: 'No autorizado' }, 403);
        const body = await request.json();
        const ids = await getIndex(env, 'idx:trabajadores');
        for (const id of ids) {
          const t = await env.BOLSA_KV.get(`trabajador:${id}`, 'json');
          if (t && t.userId === user.id) {
            if (body.disciplinas !== undefined) t.disciplinas = body.disciplinas;
            if (body.recibirCursos !== undefined) t.recibirCursos = body.recibirCursos;
            await env.BOLSA_KV.put(`trabajador:${id}`, JSON.stringify(t));
            return json({ ok: true });
          }
        }
        return json({ error: 'Perfil no encontrado' }, 404);
      }

      // ── Trabajador: enviar sugerencia de formación ──────────
      if (path === '/sugerencias' && method === 'POST') {
        if (!user || user.role !== 'trabajador') return json({ error: 'No autorizado' }, 403);
        const body = await request.json();
        const { texto } = body;
        if (!texto || !texto.trim()) return json({ error: 'El texto no puede estar vacío' }, 400);
        // Buscar trabajador
        const tids = await getIndex(env, 'idx:trabajadores');
        let nombreTrab = '';
        for (const tid of tids) {
          const t = await env.BOLSA_KV.get(`trabajador:${tid}`, 'json');
          if (t && t.userId === user.id) { nombreTrab = `${t.nombre} ${t.apellidos}`; break; }
        }
        const sid = generateId();
        const sugerencia = { id: sid, userId: user.id, nombre: nombreTrab, texto: texto.trim(), leida: false, createdAt: new Date().toISOString() };
        await env.BOLSA_KV.put(`sugerencia:${sid}`, JSON.stringify(sugerencia));
        await addToIndex(env, 'idx:sugerencias', sid);
        return json({ ok: true });
      }

      // ── Trabajador: subir vida laboral (R2) ─────────────────
      if (path === '/vida-laboral' && method === 'POST') {
        if (!user || user.role !== 'trabajador') return json({ error: 'No autorizado' }, 403);
        const formData = await request.formData();
        const file = formData.get('file');
        if (!file) return json({ error: 'No se recibió archivo' }, 400);
        // Validar tipo y tamaño (máx 5 MB)
        const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png'];
        if (!allowedTypes.includes(file.type)) return json({ error: 'Solo se admiten PDF, JPG o PNG' }, 400);
        const arrayBuffer = await file.arrayBuffer();
        if (arrayBuffer.byteLength > 5 * 1024 * 1024) return json({ error: 'El archivo supera el límite de 5 MB' }, 400);
        // Buscar trabajador para guardar referencia
        const tids = await getIndex(env, 'idx:trabajadores');
        let trabajadorObj = null;
        for (const tid of tids) {
          const t = await env.BOLSA_KV.get(`trabajador:${tid}`, 'json');
          if (t && t.userId === user.id) { trabajadorObj = t; break; }
        }
        if (!trabajadorObj) return json({ error: 'Perfil no encontrado' }, 404);
        // Si ya tenía una vida laboral, borrar la anterior de R2
        if (trabajadorObj.vidaLaboralKey) {
          try { await env.BOLSA_R2.delete(trabajadorObj.vidaLaboralKey); } catch(e) {}
        }
        const ext = file.type === 'application/pdf' ? 'pdf' : (file.type === 'image/png' ? 'png' : 'jpg');
        const key = `vida-laboral/${trabajadorObj.id}/${generateId()}.${ext}`;
        await env.BOLSA_R2.put(key, arrayBuffer, { httpMetadata: { contentType: file.type } });
        trabajadorObj.vidaLaboralKey = key;
        trabajadorObj.vidaLaboralFileName = file.name;
        trabajadorObj.vidaLaboralFecha = new Date().toISOString();
        await env.BOLSA_KV.put(`trabajador:${trabajadorObj.id}`, JSON.stringify(trabajadorObj));
        return json({ ok: true, fileName: file.name });
      }

      // ── Ver vida laboral (admin, empresa con acceso, propio trabajador) ──
      if (path.match(/^\/vida-laboral\/([^/]+)$/) && method === 'GET') {
        // Soportar token en query param para enlace directo en navegador
        let user2 = user;
        if (!user2) {
          const qToken = url.searchParams.get('token');
          if (qToken) {
            const fakeReq = new Request(request.url, { headers: { Authorization: `Bearer ${qToken}` } });
            user2 = await authenticate(fakeReq, env);
          }
        }
        if (!user2) return json({ error: 'No autorizado' }, 401);
        const trabajadorId = path.split('/')[2];
        const t = await env.BOLSA_KV.get(`trabajador:${trabajadorId}`, 'json');
        if (!t || !t.vidaLaboralKey) return json({ error: 'No hay vida laboral subida' }, 404);
        // Permisos: admin, el propio trabajador, o empresa con acceso
        let permitido = user2.role === 'admin';
        if (!permitido && user2.role === 'trabajador') {
          permitido = t.userId === user2.id;
        }
        if (!permitido && user2.role === 'empresa') {
          // Verificar que la empresa tiene acceso a este trabajador (perfiles asignados)
          const ofertaIds = await getIndex(env, 'idx:ofertas');
          outer: for (const oid of ofertaIds) {
            const o = await env.BOLSA_KV.get(`oferta:${oid}`, 'json');
            if (o && o.perfilesAsignados && o.perfilesAsignados.includes(trabajadorId)) {
              const empIds = await getIndex(env, 'idx:empresas');
              for (const eid of empIds) {
                const e = await env.BOLSA_KV.get(`empresa:${eid}`, 'json');
                if (e && e.userId === user2.id && e.id === o.empresaId) { permitido = true; break outer; }
              }
            }
          }
        }
        if (!permitido) return json({ error: 'No autorizado' }, 403);
        const obj = await env.BOLSA_R2.get(t.vidaLaboralKey);
        if (!obj) return json({ error: 'Archivo no encontrado' }, 404);
        const headers2 = new Headers();
        headers2.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
        headers2.set('Content-Disposition', `inline; filename="${t.vidaLaboralFileName || 'vida-laboral'}"`);
        headers2.set('Cache-Control', 'private, max-age=300');
        return new Response(obj.body, { headers: headers2 });
      }

      // ── Trabajador: añadir empleo ──────────────────────────
      if (path === '/empleos' && method === 'POST') {
        if (!user || user.role !== 'trabajador') return json({ error: 'No autorizado' }, 403);
        const body = await request.json();
        const { trabajadorId, empresa, cif, sector, categoria, oficio, fechaInicio, fechaFin, enActivo, tareas } = body;
        if (!trabajadorId || !empresa || !sector || !categoria) return json({ error: 'Faltan campos' }, 400);
        const id = generateId();
        const empleo = { id, trabajadorId, empresa, cif, sector, categoria, oficio: sector === 'fabricacion' ? oficio : null, fechaInicio, fechaFin: enActivo ? null : fechaFin, enActivo: !!enActivo, tareas, certificadoUrl: null, certificadoValidado: false, createdAt: new Date().toISOString() };
        await env.BOLSA_KV.put(`empleo:${id}`, JSON.stringify(empleo));
        await addToIndex(env, `idx:empleos:${trabajadorId}`, id);
        return json({ ok: true, id });
      }

      // ── Trabajador: subir certificado (base64) ─────────────
      if (path.match(/^\/empleos\/([^/]+)\/certificado$/) && method === 'POST') {
        if (!user || user.role !== 'trabajador') return json({ error: 'No autorizado' }, 403);
        const id = path.split('/')[2];
        const empleo = await env.BOLSA_KV.get(`empleo:${id}`, 'json');
        if (!empleo) return json({ error: 'No encontrado' }, 404);
        const { fileBase64, fileName } = await request.json();
        // Guardamos el base64 directamente en KV (PDF pequeño)
        const certId = generateId();
        await env.BOLSA_KV.put(`cert:${certId}`, JSON.stringify({ id: certId, empleoId: id, data: fileBase64, fileName, createdAt: new Date().toISOString() }));
        empleo.certificadoId = certId;
        empleo.certificadoFileName = fileName;
        empleo.certificadoValidado = false;
        await env.BOLSA_KV.put(`empleo:${id}`, JSON.stringify(empleo));
        return json({ ok: true, certId });
      }

      // ── Trabajador: ver certificado ────────────────────────
      if (path.match(/^\/certificados\/([^/]+)$/) && method === 'GET') {
        if (!user) return json({ error: 'No autorizado' }, 401);
        const id = path.split('/')[2];
        const cert = await env.BOLSA_KV.get(`cert:${id}`, 'json');
        if (!cert) return json({ error: 'No encontrado' }, 404);
        return json(cert);
      }

      // ── Empresa: publicar oferta ───────────────────────────
      if (path === '/ofertas' && method === 'POST') {
        if (!user || user.role !== 'empresa') return json({ error: 'No autorizado' }, 403);
        const body = await request.json();
        const { titulo, descripcion, sector, categoria, oficio, publica } = body;
        if (!titulo || !sector || !categoria) return json({ error: 'Faltan campos' }, 400);
        // Obtener empresaId
        const empIds = await getIndex(env, 'idx:empresas');
        let empresaId = null;
        for (const eid of empIds) {
          const e = await env.BOLSA_KV.get(`empresa:${eid}`, 'json');
          if (e && e.userId === user.id) { empresaId = eid; break; }
        }
        if (!empresaId) return json({ error: 'Empresa no encontrada' }, 404);
        const id = generateId();
        const oferta = { id, empresaId, titulo, descripcion, sector, categoria, oficio: sector === 'fabricacion' ? oficio : null, publica: !!publica, status: 'pendiente', perfilesDesbloqueados: [], createdAt: new Date().toISOString() };
        await env.BOLSA_KV.put(`oferta:${id}`, JSON.stringify(oferta));
        await addToIndex(env, 'idx:ofertas', id);
        return json({ ok: true, id });
      }

      // ── Empresa: ver sus ofertas ───────────────────────────
      if (path === '/mis-ofertas' && method === 'GET') {
        if (!user || user.role !== 'empresa') return json({ error: 'No autorizado' }, 403);
        const empIds = await getIndex(env, 'idx:empresas');
        let empresaId = null;
        for (const eid of empIds) {
          const e = await env.BOLSA_KV.get(`empresa:${eid}`, 'json');
          if (e && e.userId === user.id) { empresaId = eid; break; }
        }
        if (!empresaId) return json({ error: 'Empresa no encontrada' }, 404);
        const ofertaIds = await getIndex(env, 'idx:ofertas');
        const misOfertas = [];
        for (const oid of ofertaIds) {
          const o = await env.BOLSA_KV.get(`oferta:${oid}`, 'json');
          if (o && o.empresaId === empresaId) misOfertas.push(o);
        }
        return json(misOfertas);
      }

      // ── Empresa: ver perfiles desbloqueados de una oferta ──
      if (path.match(/^\/ofertas\/([^/]+)\/perfiles$/) && method === 'GET') {
        if (!user || user.role !== 'empresa') return json({ error: 'No autorizado' }, 403);
        const ofertaId = path.split('/')[2];
        const oferta = await env.BOLSA_KV.get(`oferta:${ofertaId}`, 'json');
        if (!oferta) return json({ error: 'No encontrada' }, 404);
        // Verificar que la oferta pertenece a esta empresa
        const empIds = await getIndex(env, 'idx:empresas');
        let empresaId = null;
        for (const eid of empIds) {
          const e = await env.BOLSA_KV.get(`empresa:${eid}`, 'json');
          if (e && e.userId === user.id) { empresaId = eid; break; }
        }
        if (oferta.empresaId !== empresaId) return json({ error: 'No autorizado' }, 403);
        const perfiles = [];
        for (const trabId of oferta.perfilesDesbloqueados) {
          const t = await env.BOLSA_KV.get(`trabajador:${trabId}`, 'json');
          if (t) {
            const empleoIds = await getIndex(env, `idx:empleos:${trabId}`);
            const empleos = (await Promise.all(empleoIds.map(eid => env.BOLSA_KV.get(`empleo:${eid}`, 'json')))).filter(Boolean);
            perfiles.push({ ...t, empleos });
          }
        }
        return json(perfiles);
      }

      // ── Ofertas públicas ───────────────────────────────────
      if (path === '/ofertas/publicas' && method === 'GET') {
        const ofertaIds = await getIndex(env, 'idx:ofertas');
        const publicas = [];
        for (const oid of ofertaIds) {
          const o = await env.BOLSA_KV.get(`oferta:${oid}`, 'json');
          if (o && o.publica && o.status === 'activa') {
            let nombreEmpresa = '';
            if (o.empresaId) {
              const empresaIds = await getIndex(env, 'idx:empresas');
              for (const eid of empresaIds) {
                const e = await env.BOLSA_KV.get(`empresa:${eid}`, 'json');
                if (e && e.id === o.empresaId) { nombreEmpresa = e.nombre; break; }
              }
            }
            publicas.push({ id: o.id, titulo: o.titulo, descripcion: o.descripcion, sector: o.sector, categoria: o.categoria, oficio: o.oficio, nombreEmpresa, createdAt: o.createdAt });
          }
        }
        return json(publicas);
      }

      // ── Servir HTML ────────────────────────────────────────
      if (path === '/' || path === '/index.html') {
        return new Response(HTML, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
      }

      // ── OG Image ────────────────────────────────────────────
      if (path === '/og-image.jpg') {
        const imgData = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAJ2BLADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9U6KKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAEJAoDAnHf0rz79oLxFN4T+CnjbVrad7a6ttIuDBNGcMkhQqhB9QzCvKf8Agn/JqVx+z/DPqF7c3vm6pdmE3UzSssYYDAZiTjIY9epNO2lzB1bVFTturn0Zq+q2mh6Zc6hf3MVnZWsbTT3EzhUjRRlmYnoAOazvBnjbQ/iDoFvrfh3U7fV9KnLCO6tmypKnBHqCD1B5rxv9ufxb/wAIv+zj4giBAl1aSHTFJ9JHy/8A44j1q/sa+EW8Ifs6eEIJUKXF7A2ozbupaZy4/wDHSv4YotpcSq3q+zXa57HqN/b6XYXF5dTJb2tvG0ss0rbURFBLMT2AAJzXP/D34leG/ipoH9t+FtUi1fTPNaDz4lZcOuNykMAQRkdu4rx39u34iDwJ8AtUtYphFe69Kmlx4PIRstMf+/asP+BD1roP2P8A4en4c/ALwzZzQmG+v4jqd2CefMm+YA/RNi/hRbQXtG6vIj2ncB14qCy1G11KNntLmG5RWKFoZA4DDqCQeo9K8c/a7+Lh+EHwY1a9tJRFrWoj+ztOOcFZZAd0n/AEDN9QK5z9hD4YXHw6+CFrdXodL3xBMdVeFyf3cbKqxDHYlFDH3aixXtf3ns0fR9FFFI3CiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigDwT9uXUxp37M/i1d21roW9sD/vToT+imrn7GOlf2Z+zX4JQrtaa2luG9980jD9MVxP8AwUZv/svwBhgB+a51m1XGeoXe5/8AQa9k/Z907+yfgZ4BtcEGPQ7TcCMfMYlJ/Umq6HCtcU/JfqfMn/BSPVJtSX4e+ELWT9/qF7JOY89SdkMfH1lOPoa+yfDmjw+HtC0/S7Ybbezt47aNfRUQKB+Qr4o+NQPxH/4KA+AtAAElvoiWzyp1HyiS5f6HG39K+45ZVghaSRlRFG52bgAdSaQUNak5/I+Fv2unb4xftTfD34ZQv5tpZtG92o/hMzeZKfbEEY/77FfdEEMVtbxxxIEjjUKqKOgAwAPwr4Y/Y+jPxg/ae+IvxNnXzre2aRLRzyIzM2yMD0Igj6f7dfXPxh+Idt8Kfhrr/im6wRp1q0kUZ/5ayn5Y0/FyoqiaDVp15dfyR8e/HyWX9pf9r3w98OrV2m8OeHpNl+UPygjbJdE++AkQ98195WttFaQRwwoI4o1CIijAUDgAfhXxz/wTx+HtxLoniT4k6uGl1XX7l4IZ35Z41fdM4P8AtSkj/tmK+yxSY8Km06r+1+XQWiiipO8KKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKA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WR4V8NWPhHw3peiabH5Vhp9tHawJ6IihRn3OMn3NbAGKTPSowVOmoC0UUzzF9R+dI2H0UgOaWgAopCwXqcUm8UCuOopAciloGFFITjrSbhQK46ikBB6UtAwopjOAcZA/GgSL6j86BXH0UgIPSloGFFNZwvBIH40K2fegVx1FIWA6kCkMijuPzoGOoqMyD+8Pzp6sGGRQK4tFMLjOMj86cDmgLi0UUUDCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigApsn3e/OBxTqjuJBDA8jdEG4/hzQJ6I+Gv2RpU1r9rr4ya3x5ObomTPA3Xo7/RDVb9iu7TxR8bvjJ8Rr0+XZoZW8x+QiyzvISPbZD+Vc1+yh4hHhrwj+0P4zJG6C0doXJzl3a5ZR+JZKy/hhrn/Crf2F/GurLN5epeKtTOk2rnh9oRY3I9cKJjn1atbaHgwklySf95nZfsdahF4o+KPxa+NOut5WnWqTssz/AMCyMZWwf9mGKNQOvI9aufsV6He/F/40eNvjHrUDZWd4LLdkhZZByo/65w7E/wCB15z4m1o/Cn9j3wn4H09T/wAJJ4+nOq3tvGP3ptGcCNf+BhYUHqNw9a+5/wBnj4XJ8H/hFoHhwqovYovPvmH8VzJ88v1wTtHsopPTU1oR9pKMX01fqz0pelOpB0payPaOK+M3jqP4a/C7xN4md9radYyyxD+9KRtjX8XZRX5YwftX/F+3mik/4T/WJzEyuUlePbIQclSAnQ9PpX1t/wAFJvH66Z4G0DwfBLi41a6N7OoPSCEfLkehkZf++DXxFN8MdUt/hRY+PX50u71aXSkAXOGSMMJM+hO9fqtbRStqfP42tP2vLTex+xfgPxZa+OfBui+IbNt1tqdnFdoP7u9AxU+4JI/Ctm6uY7S1lnmkWGGJS7yOcKqgZJJ7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/EQoGT7mtiigLIwl8E6BHrcmsLomnLq0j73vxaR+ezbdu4yY3Z28Zz04qKx+H/hrSkvRZeHtKtBexiG6EFjEgnjGfkcBfmHJ4PrXRUUCsjO/sTT/ADYZfsNsJYYTbxOIl3RxHGUU44U7RwOOB6Vyuk/Bnwpour6/eWuk2qW+t20Frd6b9njFmyRFyMRBcZJkbOc5wPSu6xRigHFPoc3cfDvwvdaKdIl8OaRJpRkE32FrGIwb+m7ZtxnAxnrW/aWkNjbRW9tDHb28SCOOKJAqIoGAABwAB2FS4paAUUgooooKCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigBKhurOG8haKeJJomGGSRQyn6g8Gp6KBNJ6M8f8AGv7J/wAKvHZll1DwdY290/W503NpJn1/dkAn3INeM+JP+Cangy9m8/QvE+taLKPuidY7pV/HCv8A+PV9jUU7s554elPeJ8KTfsL/ABW0BDB4c+LbfZMcRXEt1CGP+6GdRXCa7+wl8Z72WR5L3w1qUjfK07zqkjA/7Rh3frX6S0tVzM53gaUu5+Xf/Dvb4ujrF4eA9tUI/wDaVa+nf8E4viXdvi51Xw7Yj+8bmWX9FjFfpbRRzMlZfQXc+A9B/wCCY+pTMG1vx3awj+JNP093z7Zd1/PFeoeGv+Cc3w20kq+q3ut684IJWa5EEZ/4DGoJH1NfVlFK7NY4KhHaJzPw++G3hv4W+HxonhbSYdG0wStOYISx3SNjc7MxJJOByT0AHaumooqTtSsrIKKKKBhRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRWZ4i8T6N4Q01tR13VrHRdPVgjXeo3KW8QY9AXcgZPpmgNjToqjomvaZ4m0uDU9H1G01bTbgEw3ljOs0MgBKna6kg4II4PUGr1AbhRRRQAUUVz2rfEXwpoGvWuiap4n0bTdautgt9Ou9QiiuJt7bU2RswZtzDAwOTwKBNpbnQ0UUUDCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiue0D4i+FPFWq3OmaJ4n0bWNStQzT2dhqEU80IVgrF0RiVAYgHI6nFdDQJNPYKKKKBhRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQB+R3hH4K/8L9/ae8YeFP7Z/sLfqGpXP2v7L9oxsnb5dm9Oueua90vf+CY2t6PbPc6B8S4pNSQbokm0x7RS3bMiTOV+u01zP7I//J8viv8A67av/wCjjX6REgAknAHc0Hj4bD06sHKS1uz89/2Xf2jPHvw0+M8fwm+JN3dahBNd/wBmo2oS+bPZXJ4iCyHJeNztUAkjDKVIGQf0Jr8vfifrNn8Vv2+9Om8MSJewf27psC3VudyyGDyhLICOqr5b8jqEzX0j+29+1LqnwhhsPB3g+QR+K9Ui86W7VA7WkBYquxTkeY5DAZBwBnGSCA0oVlThPmd1F6H1jRX56+Hv+CfXxD+IulRa943+IEmm67cqJvst1HJfzxk8gSyGVdreoG7HrWHovxK+KX7DvxSsfDnjTUZ/EXg26wwRpWnikt84Mtsz/Mjp3j4B7jlWoNvrMo2dSFl3P0moqCwvrfVLG3vLSZbi1uI1mhlQ5V0YZVgfQgg1+a3jL9ob4h+BP2sPGNpo+ra1rx/tC607StAmvppLQTyDy4cQFtpCswIUDqAOOtBtWrRopN9T9MK+W/28vjT4y+DHhbwreeDdZ/se4vryaK4f7LDPvVUBAxKjAcntivNJv+Cf/wAQfiko1n4h/FNhrdx+8kt/sr3ywk87AxljUY6YRdo7cV47+2H8GviB8Lk0uXxJ4v8A+Eh8LS3DWuj2X224k+zLHGoz5LjZFlQOEZsdMmg5K9ar7Nvka87n6WfDLWLvxD8N/Cmq6hN9ov77SbS5uJdoXfI8KMzYUADJJOAAK6Wvzx8Gfsu/tIaz4P0LUNJ+Ln2HSruwgntLX/hJdSj8mFo1ZE2rEVXCkDA4GOK+1fhP4Z8T+DvhPo+jeJNV/tzxRaWzpcah9pkuPOkLMVPmSgM3BUZYdqDpo1JT0lFo7mivg4/sSfGT4roL74jfFJraaX5vsavLeiLP8OwNHGv0TIrmvGn7GXxR/Z60W68W+AvHs+pjTIzc3ENksllP5ajLER73SQAZJUnkZ4PSgh16iXN7N29f0P0Wr5n/AOCh3/Jtl/8A9hG0/wDQzXU/sjfHub4+/C1dS1JY4/EOmzmy1ERDasjBQyygdgynp/eDY4xXLf8ABQ7/AJNsv/8AsI2n/oZoKqzU6EpR2aOm/Yk/5Nd8C/8AXG5/9Kpq9yrw39iT/k13wL/1xuf/AEqmr3Kg1o/wo+iCiivz7/aK+OXjz49fGmT4R/DC7nstPt7h7O4ntJjCbqVP9c8kq8rCmGGB97BPzZUAFVqqkrvVvZH6CV+e37Wf/J93wy/66aN/6XPWjZf8E8fH/gu1Gt+GPigtv4qiHmLFBDLbIzjnb54kJOenzJg968U1j4jeIviP+1J8NZfF9gbDxVo+pabo+pqVC+ZNDfHL7RwCQwzjjIJHBFBwV6spRUZxs7rzP1jopGYKpJIAHJJ7V+fnjv4y/Ez9rz4p6h4H+FOoSaH4RsCRNqMUzQCaMNtM00q/MEY5CxryRyQedod9WqqSWl29kfoJRXwJP/wTX8WafbHUtL+J6N4gUb0DWksCl+379ZWYc99ldT+yP+0N4y0z4l3vwb+KUk0+u2xeOxvbtt0/mIu4xO//AC0DIC6Ock+pDLgMo15KSjUjy326n2lRRRQdh8a/8FO/+SU+E/8AsNf+0JK8n+E//BO7/haHw48P+K/+Fgf2Z/a1qtz9k/sXzfKzn5d/2hd3TrgV6x/wU7/5JT4T/wCw1/7Qkq5+z3+2D8IvA3wU8H6Drfi37Fq2n2CQ3Nv/AGbeSeW4JyNyRFT+BNB5E40pYmSq7W72OH/4dZf9VO/8oH/3TX09+zV8CP8Ahnj4f3Hhj+3P+Eg87UJL77V9k+zY3pGu3bvfp5ec579OK5z/AIbs+B3/AEO//lJvv/jFeteAvH2g/E7wtZ+I/DN//aWjXZcQ3PkyRbyjlG+WRVYYZSOR2oOqjTw8ZXpWv63Ohor4O/4KCfFHxT8Pvip4MTRPE2taNYNp4nuLXTNQlt0mxO2SyowDHAxzUr/s/wDxY/bBtR4w8YeMD4L8O6gPP0nw/HE9wIrc8xs0QdFyy4O4kseuAMCgbxD53ThG7R92UV+ZBm+IX7Afxd0W0vtbk1rwdqBEjxRM/wBnu7cMFlxExPlzJkEYz1XkgkV6ldeC/ij+3HPd+IB4mk8B/DAzPDpFkEd5LyNWK+c8SsofJB5ZsA5CjAJITHEuV4qPvdv+CfctFfmB8Qfhv8Sv2DvFGh+IdF8UNq2hXc3l74w8UE7L8zQXEBZh8y5IIJPBIIIr9I/A/iy08eeDdE8R2IK2mq2UV5ErHJUOgbafcZwfcUGtKt7RuMlZo3KK/O79qr48+LPhR+1sJrPXtZbQtOjs7ltCh1GWK0n/AHQJRow23DHrx3PWtmH9jr4r/tF2SeLPiP4/bRLy/H2i30drZ7gWyNyqeX5iLDxj5Rkj+L5s0GX1luThCN2j74or80rDxV8UP2Dfifpmk+I9Rm1/wVfHd5KytJb3EAIDvCH5ilTIJUYzxnIINfpJpmpW2s6baahZTLcWd3Ek8EyfddGAZWHsQQaDalWVW6as1uj8/wD9gv8A5Om+Jn/Xne/+l0VfoTX57fsF/wDJ03xM/wCvO9/9Loq+v/2hPjVYfAX4aX3ie7iF3dbhbWFmWx9ouGBKqT2UAMxPopxzig58LJQouT2uz0qivzn8HfAr4z/tiWI8YeL/ABpJoHh69YtZW8gdkZMkAxWqsqqnYMxDNjPzdab45/Ze+K/7KOkSeNfA3jqfVtP0399exW0b27JGOrvbl3SSMfxZJwOcYBIB/WZ251TfL/XQ/RqivKP2Z/jjB8ffhdZ+ITDHa6rDIbPUrWI/LHcKASVzztYMrDPTOMnGa8l/be/al1T4Qw2Hg7wfII/FeqRedLdqgdrSAsVXYpyPMchgMg4AzjJBAdEq0I0/adD6xor89fD3/BPr4h/EXSote8b/ABAk03XblRN9luo5L+eMnkCWQyrtb1A3Y9aw9F+JXxS/Yd+KVj4c8aajP4i8G3WGCNK08UlvnBltmf5kdO8fAPccq1Bh9ZlGzqQsu5+k1FQWF9b6pY295aTLcWtxGs0MqHKujDKsD6EEGp6DuCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD8jvCPgXxn8RP2nvGGkeA/EP8AwjOvtqGpSrf/AG2a0xGs7bl8yFS3ORxjBr3W8/Ys/aG8SW72Ov8AxcivdNl+WWGbXtRuVZe+UeMA/Q1zH7I//J8viv8A67av/wCjjX6R0Hj4ahCrBuV931Pnf9mr9jPw78AL1tcuL5vEXip4zEt9JEIorZWGGESZJBIyC5OSOAFBIPzZ4pt08Zf8FLba11EeZb2+q23lxv0HkWiyIMehZM/jX6N1+c37YWn6l8C/2s/D3xRtrV59NvpLa9BXhXkhVYpoc9i0aqf+2nsaDbEU40qceVaJq5+jNfH3/BTXRba6+DfhzVXRftlnriQRyEchJIJS6j6mJD/wGvpjwJ8T/C/xJ8Nwa74e1m11DT5YxIzLKA8PHKyLnKMO4OK+Gf2/vjZp3xU1rw58NvB066/Ja3vn3L2J81JLtgY4oYyOGYB3zjPLgdQRQa4qcfYvXfY+sv2SdTn1f9m7wBPcEtIumrAC392NmjX/AMdQV8ifDbSrfVf+Ck+sfaEEi22qajcqrDI3rBJtP4Egj3Ar7o+D/gg/Db4W+FvDDlWm0zT4beZk+60oUGQj2Llj+NfEnwk/5SS+JP8Ar91P/wBEtQZVk0qSfdH6F18S/wDBUL/kSfA//YRn/wDRQr7ar4z/AOCnWkXFz8MPCmpRxlre01ZopWAzt8yJtpPt8hH4ig3xf8GR9N/Bn/kj/gX/ALAVj/6TpW74p8Tad4M8Oalrur3AtdM063e5uJjztRRk4Hc9gO5wK8Y+BH7R3w0u/g/4OiuvHGg6VfWmk2trc2epajFbSxSxxKjjbIwJG5TgjgjBpv7X15H40/ZN8ZXvhq9g1a0mt4LhLrT5lmjlhjuomlKupIICo+cHsaC1USpc0XeyPnq7/bH+Nvxx1+9tfhF4SNppdu20TLaLczKD90yyyfukJxkLjjnlsZp2ot+2zPpl2btcWTRP5ysuiD5Np3cdema9J/4J0+OvDFx8GR4Zt721tvEdpfTy3dm7qk0wcgpKoPLDbtXI6bMHtnv/ANqr9obQfhV8O9Y0221CC98YapbvZafpds4knWSRSgkZRyqrnPP3iAB1oOKMeal7WdR/J2PAv+CWlw5HxKgJJjH9nOB6E/aQf5D8q9d/4KHf8m2X/wD2EbT/ANDNeO/8Es/+Pj4l/wC7pv8AO6r2L/god/ybZf8A/YRtP/QzQFP/AHN+j/U6b9iT/k13wL/1xuf/AEqmr3KvDf2JP+TXfAv/AFxuf/SqavcqDvo/wo+iKmrXbWGlXtyg3PDC8ij1IUn+lfAH/BMXTotT8ceP9cuf3uow2dvCJW5YiaR3kP4mJa/QiSNZY2R1DIwKsp6EGvzT/Z28WQfsi/tQeJ/CPi2Q6fol6zaeb2bIRAH32twx/uMpwT28zJxg0HNiHy1acpban6XV+cn7T2i22lft9eCp7dFR9QvtFuptvd/tCx5/75jWv0A1Pxv4e0Xw++uX2uafa6MqeYb+S5QQlcZyGzg/h1r8vfF/xVj+M37aPhnxNaRyppEviHTLfTjKpUvbx3EaB8H+8wdsdtxHagnGSjyxj1uj9HP2hNXn0H4F+Pr61Ypcw6Jd+W69VYxMAw+mc/hX5v8A7L3xa+K/wt0LW/8AhXPw+Hiu1vrlPtd9/Y15eFHRflj3wOoGA5ODz82e9fqJ478LQ+OPBOv+HbhvLh1awnsWfGdokjZN34Zz+Ffn5+xl8X4P2bfiL4q+HXxCb+woLq5VftNxxFa3UeV+c9kkUrh+nyqehyAnEr99Bt2Xc6v/AIa1/ag/6Iz/AOWtqn/x2vPdGi+MPxK/an8EePPEnw11nQp11XT4byez0K8t7ZIVkVGkcybsYQnJLYwO1fpVZ61p2o2K3tpf211ZsNy3EMyvGR6hgcVz0fxd8Fz+LbHwvB4n0y78Q3pcQ6da3KzTHYjSNuCZ2YVGOWxnHHNBcsPe3PUZ11FFFB6B8a/8FO/+SU+E/wDsNf8AtCSrn7Pf7H3wi8c/BTwfr2t+EvturahYJNc3H9pXkfmOScnakoUfgBVP/gp3/wAkp8J/9hr/ANoSV337Mvxo+HugfALwPp2p+O/DOnahb6akc1rd6xbxSxNk8MjOCD7EUHmWg8TLnS26mj/wwn8Dv+hI/wDKtff/AB+vWvAXgHQfhj4Ws/Dnhmw/s3RrQuYbbzpJdhdy7fNIzMcsxPJ71hf8NAfC/wD6KR4R/wDB7a//AByul8MeNPD3je0luvDuu6Zr9rC/lST6XeR3KI+AdpZCQDgg4PrQdsI0ov3Er+Vj4H/4KSWqX3xl8BW0n+rm08Rtj0NwwP8AOv0OhhjtoY4okWOKNQiIowFAGAAK/Pf/AIKMf8lw+Hf/AF5J/wClJr9C6DnofxqvyPhz/gqNAjeG/AExUeYl3doG7gFIiR/46Pyr6w+C2nwaV8HvA9pbII4YtEslVQP+mCZP1J5/GvlL/gqJ/wAip4C/6/br/wBFpX1r8J/+SWeDf+wNZ/8AohKAp/7zP0R4H/wUfgSX9nmFmUFotatnQnsdkoz+RP516F+xzK037M/gJmOSLJ1/ATSAfoK4H/go3/ybsP8AsMWv/oMld3+xr/ybJ4D/AOvST/0fJQEf96fofJX7RGjW3iH/AIKD+G9OvEWS0uL7SFljbo6/ISp+oGPxr9Ha/L/9tDxDeeEf2yF17T4zLe6UNOvokGfmaJFcA47fLz7Zr9Dfhl8XfC3xb8K2uu+HtVt7mCWMPNAZFE1q2OUlTOVYe/B6jIINBGGlH2lSPW58/wD/AAUp0a2vfgVpmoSIv2qx1qHypO+145VZfocKf+AivUP2PtTm1b9mnwDPcEtIlgbcE/3Y5XjX/wAdQV8wf8FB/jfpfj+TQPhp4Tuk126jv1ur1rBvNXz8GOGBSudzfvGJA6HaOuQPs34K+Bn+Gnwm8KeGJdpudN0+KK4K9DNjdJj23lqCqbUsTKUdkrHxX+wX/wAnTfEz/rzvf/S6KtD/AIKj6vP5/wAPdLDFbbbe3LL2Z8wqp/Abv++qz/2C/wDk6b4mf9ed7/6XRV6X/wAFIfhZe+L/AIa6N4r06BriXw3NL9qSMEsLaULuk+itGmfQMx6A0HKk5YSSXf8AU848O/tPftJ6BoGmaXp3wXC6fZWsVtbAeF9TIEaIFTpLjoB0p+tftP8A7TGv6Pf6Zd/Bcta3sEltMo8Lanko6lWHMvoTXvX7J/7Tvhn4p/DzRdKv9XtbDxfp9tHaXdhdyiN7gooUTR5PzhgASBypJBHQn3fVvEWk6Batc6nqdnp1uoyZru4SJAPXLECg6IU3OCkqrsfIP/BN/wAGeLfBOn+PrPxN4d1jw/DLLZS2q6rYy2wlbE4kKeYo3YAjzjpkZ7V5n4pt08Zf8FLba11EeZb2+q23lxv0HkWiyIMehZM/jX314K+IPhz4jWN5e+GdYttbsrS6azlubNt8QlVVYqG6N8rqcqSOevWvgf8AbC0/UvgX+1n4e+KNtavPpt9JbXoK8K8kKrFNDnsWjVT/ANtPY0GdaCpUYJO6TP0Zr4+/4Ka6LbXXwb8Oaq6L9ss9cSCOQjkJJBKXUfUxIf8AgNfTHgT4n+F/iT4bg13w9rNrqGnyxiRmWUB4eOVkXOUYdwcV8M/t/fGzTviprXhz4beDp11+S1vfPuXsT5qSXbAxxQxkcMwDvnGeXA6gig6MVOPsXrvsfWX7JOpz6v8As3eAJ7glpF01YAW/uxs0a/8AjqCvXa4/4P8Agg/Db4W+FvDDlWm0zT4beZk+60oUGQj2Llj+NdhQdNNNQSfYKKKKDQKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA8S+HX7JPhD4ZfFbUPiBpepa3PrN81y8kF5PC1uDO258KsStwemWPvmvbaKKCIwjBWirBXL/Ef4aeHPix4WuPD/AIo02PUtNmIYKxKvE46OjDlWGTyPUg5BIrqKKCmk1Znw9rX/AAS60W41Bn0nx9fWNkTlYbzTkuJAPTeskYP/AHzXsXwG/Yv8D/AzU01qJrjxD4jQER6jqAULb5GCYoxwpP8AeJZuoBAJr3+ig544alCXNGOoV434d/ZY8J+Gfjde/FK11DWZPEF3LPLJbTTxG1BlUq2FEQbAB4+f869kooNpQjKza2Csbxh4O0Xx/wCHL3QfEOnw6ppF4mye1mBwwzkEEYIIIBBBBBAINbNFBTSasz5R1L/gmv8ACm+uXlhv/E2noxyIba+hKL7DzIWb8ya+gvh/8NNI+HXw707wXZGbUNGsrd7YDUdkjyxszFhJhVVs7iPugYrrKKDKFGnTd4qx8ZePf+CZvhXX9anvfDPim88MWszlzYzWgvY489oyXRgvsxY+9dr8FP2DfBPwl1Iaxe3t14o1xFZY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UUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAf/9k=';
        const bytes = Uint8Array.from(atob(imgData), c => c.charCodeAt(0));
        return new Response(bytes, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } });
      }

      // ── Política de privacidad ─────────────────────────────
      if (path === '/privacidad') {
        return new Response(PRIVACIDAD_HTML, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
      }

      // ── Aviso legal ─────────────────────────────────────────
      if (path === '/aviso-legal') {
        return new Response(AVISO_LEGAL_HTML, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
      }

      return json({ error: 'Ruta no encontrada' }, 404);

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }
};

// ============================================================
// HTML — Portal completo embebido
// ============================================================
const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Portal de Empleo · Piel de Ubrique</title>
<meta property="og:title" content="Portal de Empleo · Piel de Ubrique">
<meta property="og:description" content="Bolsa de empleo del sector marroquinería de Ubrique, gestionada por Asopiel">
<meta property="og:image" content="https://portalmarroquineria.asopiel.com/og-image.jpg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #F7F5F2;
  --surface: #FFFFFF;
  --accent: #1B4F8A;
  --accent-light: #E8EFF8;
  --accent-dark: #143D6B;
  --success: #1A6B3C;
  --success-light: #E6F4ED;
  --warning: #7A5C00;
  --warning-light: #FFF8E1;
  --danger: #8B2020;
  --danger-light: #FDEAEA;
  --text: #1A1A1A;
  --text-secondary: #5A5A5A;
  --text-muted: #8A8A8A;
  --border: #E0DDD8;
  --radius: 10px;
  --shadow: 0 2px 8px rgba(0,0,0,.08);
  --shadow-lg: 0 8px 32px rgba(0,0,0,.12);
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
a { color: var(--accent); text-decoration: none; }

/* Header */
.header { background: var(--accent); color: #fff; padding: 0 24px; height: 60px; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 100; box-shadow: 0 2px 8px rgba(0,0,0,.15); }
.header-brand { display: flex; align-items: center; gap: 10px; }
.header-brand .logo { width: 32px; height: 32px; background: rgba(255,255,255,.2); border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 16px; }
.header-brand h1 { font-size: 15px; font-weight: 600; }
.header-brand span { font-size: 12px; opacity: .75; }
.header-right { display: flex; align-items: center; gap: 12px; }
.header-user { font-size: 13px; opacity: .9; }
.btn-logout { background: rgba(255,255,255,.15); border: 1px solid rgba(255,255,255,.3); color: #fff; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; font-family: inherit; }
.btn-logout:hover { background: rgba(255,255,255,.25); }

/* Main */
.main { max-width: 1200px; margin: 0 auto; padding: 32px 24px; }

/* Cards */
.card { background: var(--surface); border-radius: var(--radius); border: 1px solid var(--border); box-shadow: var(--shadow); }
.card-header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
.card-header h2 { font-size: 15px; font-weight: 600; }
.card-body { padding: 20px; }

/* Tabs */
.tabs { display: flex; gap: 4px; background: var(--bg); border-radius: 8px; padding: 4px; margin-bottom: 24px; overflow-x: auto; }
.tab { padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; color: var(--text-secondary); border: none; background: none; font-family: inherit; white-space: nowrap; }
.tab.active { background: var(--surface); color: var(--accent); box-shadow: 0 1px 4px rgba(0,0,0,.1); }
.tab-panel { display: none; }
.tab-panel.active { display: block; }

/* Forms */
.form-group { margin-bottom: 16px; }
.form-label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; color: var(--text); }
.form-label .req { color: var(--danger); margin-left: 2px; }
.rgpd-info { font-size: 12px; color: var(--text-secondary); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; line-height: 1.6; }
.rgpd-info strong { color: var(--text); }
.rgpd-check { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; color: var(--text); margin-bottom: 14px; cursor: pointer; }
.rgpd-check input[type=checkbox] { margin-top: 2px; flex-shrink: 0; }
.form-control { width: 100%; padding: 9px 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; font-family: inherit; background: var(--surface); color: var(--text); transition: border-color .15s; }
.form-control:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-light); }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.form-grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
textarea.form-control { resize: vertical; min-height: 100px; }
.form-hint { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
.form-check { display: flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
.form-check input { width: 16px; height: 16px; cursor: pointer; }

/* Buttons */
.btn { display: inline-flex; align-items: center; gap: 6px; padding: 9px 18px; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; border: none; font-family: inherit; transition: all .15s; }
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover { background: var(--accent-dark); }
.btn-success { background: var(--success); color: #fff; }
.btn-success:hover { opacity: .9; }
.btn-danger { background: var(--danger); color: #fff; }
.btn-danger:hover { opacity: .9; }
.btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
.btn-outline:hover { border-color: var(--accent); color: var(--accent); }
.btn-sm { padding: 5px 12px; font-size: 12px; }
.btn-block { width: 100%; justify-content: center; }

/* Badges */
.badge { display: inline-flex; align-items: center; padding: 3px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; }
.badge-success { background: var(--success-light); color: var(--success); }
.badge-warning { background: var(--warning-light); color: var(--warning); }
.badge-danger { background: var(--danger-light); color: var(--danger); }
.badge-accent { background: var(--accent-light); color: var(--accent); }
.badge-gray { background: #F0EFED; color: var(--text-secondary); }

/* Stats bar */
.stats-bar { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px; }
.stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 20px; }
.stat-value { font-size: 28px; font-weight: 700; color: var(--accent); }
.stat-label { font-size: 12px; color: var(--text-muted); margin-top: 2px; }

/* Table */
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { background: var(--bg); padding: 10px 12px; text-align: left; font-weight: 600; color: var(--text-secondary); border-bottom: 2px solid var(--border); white-space: nowrap; }
td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
tr:hover td { background: #FAFAF8; }

/* Alert */
.alert { padding: 12px 16px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; }
.alert-warning { background: var(--warning-light); color: var(--warning); border: 1px solid #F0D060; }
.alert-success { background: var(--success-light); color: var(--success); }
.alert-info { background: var(--accent-light); color: var(--accent); }
.alert-danger { background: var(--danger-light); color: var(--danger); }

/* Modal */
.modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 500; align-items: center; justify-content: center; padding: 16px; }
.modal-overlay.open { display: flex; }
.modal { background: var(--surface); border-radius: 12px; width: 100%; max-width: 600px; max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-lg); }
.modal-header { padding: 20px 24px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
.modal-header h3 { font-size: 16px; font-weight: 600; }
.modal-close { background: none; border: none; font-size: 20px; cursor: pointer; color: var(--text-muted); padding: 0 4px; }
.modal-body { padding: 24px; }
.modal-footer { padding: 16px 24px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 10px; }

/* Login */
.login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg); padding: 16px; }
.login-card { background: var(--surface); border-radius: 16px; padding: 40px; width: 100%; max-width: 420px; box-shadow: var(--shadow-lg); border: 1px solid var(--border); }
.login-logo { text-align: center; margin-bottom: 24px; }
.login-logo .emblem { width: 60px; height: 60px; background: var(--accent); border-radius: 14px; margin: 0 auto 12px; display: flex; align-items: center; justify-content: center; font-size: 28px; }
.login-logo h1 { font-size: 18px; font-weight: 700; color: var(--text); }
.login-logo p { font-size: 13px; color: var(--text-muted); margin-top: 4px; }
.login-tabs { display: flex; gap: 0; background: var(--bg); border-radius: 8px; padding: 4px; margin-bottom: 20px; }
.login-tab { flex: 1; padding: 8px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; color: var(--text-secondary); border: none; background: none; font-family: inherit; text-align: center; }
.login-tab.active { background: var(--surface); color: var(--accent); box-shadow: 0 1px 4px rgba(0,0,0,.1); }
.login-footer { text-align: center; font-size: 12px; color: var(--text-muted); margin-top: 20px; }

/* Empleo card */
.empleo-card { border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 12px; background: var(--bg); }
.empleo-card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
.empleo-empresa { font-weight: 600; font-size: 14px; }
.empleo-periodo { font-size: 12px; color: var(--text-muted); }
.empleo-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.cert-status { display: flex; align-items: center; gap: 6px; font-size: 12px; margin-top: 8px; padding: 6px 10px; border-radius: 6px; }
.cert-status.pendiente { background: var(--warning-light); color: var(--warning); }
.cert-status.validado { background: var(--success-light); color: var(--success); }
.cert-status.sin-cert { background: var(--danger-light); color: var(--danger); }

/* Perfil trabajador */
.perfil-card { border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-bottom: 16px; background: var(--surface); }
.perfil-header { display: flex; align-items: center; gap: 16px; margin-bottom: 12px; }
.perfil-avatar { width: 48px; height: 48px; background: var(--accent-light); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 700; color: var(--accent); flex-shrink: 0; }
.perfil-nombre { font-weight: 600; font-size: 15px; }
.perfil-sub { font-size: 12px; color: var(--text-muted); }

/* Oferta card */
.oferta-card { border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-bottom: 16px; background: var(--surface); }
.oferta-titulo { font-weight: 600; font-size: 15px; margin-bottom: 6px; }
.oferta-meta { font-size: 12px; color: var(--text-muted); display: flex; gap: 12px; flex-wrap: wrap; }

/* Section header */
.section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
.section-title { font-size: 18px; font-weight: 700; }
.section-sub { font-size: 13px; color: var(--text-muted); margin-top: 2px; }

/* Responsive */
@media (max-width: 700px) {
  .form-grid, .form-grid-3 { grid-template-columns: 1fr; }
  .stats-bar { grid-template-columns: 1fr 1fr; }
  .main { padding: 16px; }
  .tabs { gap: 2px; }
  .tab { padding: 7px 12px; font-size: 12px; }
}
</style>
</head>
<body>

<!-- LOGIN -->
<div id="loginWrap" class="login-wrap">
  <div class="login-card">
    <div class="login-logo">
      <img src="data:image/webp;base64,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" alt="Asopiel" style="height:64px;width:auto;margin-bottom:8px;">
      <h1>Portal de Empleo</h1>
      <p>Sector Piel de Ubrique</p>
    </div>
    <div id="loginTabs" class="login-tabs">
      <button class="login-tab active" onclick="switchLoginTab('login')">Acceder</button>
      <button class="login-tab" onclick="switchLoginTab('registro-empresa')">Soy empresa</button>
      <button class="login-tab" onclick="switchLoginTab('registro-trabajador')">Soy trabajador</button>
    </div>

    <!-- Acceder -->
    <div id="loginPanel">
      <div class="form-group">
        <label class="form-label">Email</label>
        <input id="loginEmail" type="email" class="form-control" placeholder="correo@empresa.com">
      </div>
      <div class="form-group">
        <label class="form-label">Contraseña</label>
        <input id="loginPassword" type="password" class="form-control" placeholder="••••••••">
      </div>
      <div id="loginError" class="alert alert-danger" style="display:none"></div>
      <button class="btn btn-primary btn-block" onclick="doLogin()">Entrar</button>
      <div class="login-footer">¿Problemas de acceso? Contacte a Asopiel<br><a href="mailto:oficina@asopiel.com">oficina@asopiel.com</a><br><br><a href="#" onclick="abrirLegal('privacidad')">Política de privacidad</a> · <a href="#" onclick="abrirLegal('cookies')">Cookies</a> · <a href="#" onclick="abrirLegal('terminos')">Términos de uso</a></div>
    </div>

    <!-- Registro empresa -->
    <div id="registroEmpresaPanel" style="display:none">
      <div class="alert alert-info">Su solicitud será revisada por Asopiel antes de activar el acceso.</div>
      <div class="form-group"><label class="form-label">Nombre de la empresa <span class="req">*</span></label><input id="reNombre" class="form-control" placeholder="Marroquinería Ejemplo S.L."></div>
      <div class="form-grid">
        <div class="form-group"><label class="form-label">CIF <span class="req">*</span></label><input id="reCif" class="form-control" placeholder="B12345678"></div>
        <div class="form-group"><label class="form-label">Teléfono</label><input id="reTel" class="form-control" placeholder="956..."></div>
      </div>
      <div class="form-group"><label class="form-label">Persona de contacto</label><input id="reContacto" class="form-control" placeholder="Nombre y apellidos"></div>
      <div class="form-group"><label class="form-label">Email <span class="req">*</span></label><input id="reEmail" type="email" class="form-control" placeholder="correo@empresa.com"></div>
      <div id="reError" class="alert alert-danger" style="display:none"></div>
      <div id="reOk" class="alert alert-success" style="display:none"></div>
      <div class="rgpd-info">
        <strong>Información básica sobre protección de datos (art. 13 RGPD)</strong><br>
        <strong>Responsable:</strong> Asopiel — CIF G-72357205 — gerencia@asopiel.com<br>
        <strong>Finalidad:</strong> Gestión de su alta como empresa en la Bolsa de Empleo sectorial y comunicaciones relacionadas.<br>
        <strong>Legitimación:</strong> Ejecución de relación precontractual (art. 6.1.b RGPD); consentimiento (art. 6.1.a RGPD).<br>
        <strong>Conservación:</strong> Mientras mantenga el acceso activo y hasta 3 años tras la baja.<br>
        <strong>Destinatarios:</strong> No se ceden a terceros salvo obligación legal. Los trabajadores asignados a su empresa podrán ver los datos de contacto de la empresa.<br>
        <strong>Derechos:</strong> Puede ejercer sus derechos de acceso, rectificación, supresión, oposición, limitación y portabilidad escribiendo a gerencia@asopiel.com.<br>
        <a href="#" onclick="abrirLegal('privacidad')" style="color:var(--primary)">Política de privacidad completa</a>
      </div>
      <label class="rgpd-check"><input type="checkbox" id="reConsentimiento"> He leído y acepto el tratamiento de mis datos según la política de privacidad de Asopiel. <span class="req">*</span></label>
      <button class="btn btn-primary btn-block" onclick="registrarEmpresa()">Solicitar alta</button>
    </div>

    <!-- Registro trabajador -->
    <div id="registroTrabajadorPanel" style="display:none">
      <div class="alert alert-info">Su perfil será visible para Asopiel desde el momento del registro.</div>
      <div class="form-grid">
        <div class="form-group"><label class="form-label">Nombre <span class="req">*</span></label><input id="rtNombre" class="form-control"></div>
        <div class="form-group"><label class="form-label">Apellidos <span class="req">*</span></label><input id="rtApellidos" class="form-control"></div>
      </div>
      <div class="form-grid">
        <div class="form-group"><label class="form-label">DNI/NIE <span class="req">*</span></label><input id="rtDni" class="form-control" placeholder="12345678A"></div>
        <div class="form-group"><label class="form-label">Teléfono</label><input id="rtTel" class="form-control" placeholder="6XX..."></div>
      </div>
      <div class="form-group"><label class="form-label">Dirección</label><input id="rtDireccion" class="form-control" placeholder="Calle Mayor, 12"></div>
      <div class="form-group"><label class="form-label">Localidad</label><input id="rtLocalidad" class="form-control" placeholder="Ubrique"></div>
      <div class="form-group"><label class="form-label">Email <span class="req">*</span></label><input id="rtEmail" type="email" class="form-control"></div>
      <div id="rtError" class="alert alert-danger" style="display:none"></div>
      <div id="rtOk" class="alert alert-success" style="display:none"></div>
      <div class="rgpd-info">
        <strong>Información básica sobre protección de datos (art. 13 RGPD)</strong><br>
        <strong>Responsable:</strong> Asopiel — CIF G-72357205 — gerencia@asopiel.com<br>
        <strong>Finalidad:</strong> Gestión de su perfil en la Bolsa de Empleo sectorial, intermediación laboral con empresas del sector y envío de información sobre cursos si lo autoriza expresamente.<br>
        <strong>Legitimación:</strong> Ejecución de relación precontractual (art. 6.1.b RGPD); consentimiento (art. 6.1.a RGPD).<br>
        <strong>Conservación:</strong> Mientras mantenga el perfil activo y hasta 3 años tras la baja.<br>
        <strong>Destinatarios:</strong> Las empresas del sector a las que Asopiel le asigne su perfil para procesos de selección. No se ceden a otros terceros salvo obligación legal.<br>
        <strong>Derechos:</strong> Puede ejercer sus derechos de acceso, rectificación, supresión, oposición, limitación y portabilidad escribiendo a gerencia@asopiel.com. Tiene derecho a retirar el consentimiento en cualquier momento sin que afecte a la licitud del tratamiento previo.<br>
        <a href="#" onclick="abrirLegal('privacidad')" style="color:var(--primary)">Política de privacidad completa</a>
      </div>
      <label class="rgpd-check"><input type="checkbox" id="rtConsentimiento"> He leído y acepto el tratamiento de mis datos según la política de privacidad de Asopiel, incluyendo la cesión de mi perfil a empresas del sector asignadas por Asopiel. <span class="req">*</span></label>
      <button class="btn btn-primary btn-block" onclick="registrarTrabajador()">Solicitar alta</button>
    </div>
  </div>
</div>

<!-- APP -->
<div id="appWrap" style="display:none">
  <header class="header">
    <div class="header-brand">
      <div class="logo">👜</div>
      <div>
        <h1>Portal de Empleo · Piel de Ubrique</h1>
        <span id="headerRole"></span>
      </div>
    </div>
    <div class="header-right">
      <span class="header-user" id="headerUser"></span>
      <button class="btn-logout" onclick="doLogout()">Salir</button>
    </div>
  </header>

  <footer style="background:var(--surface);border-top:1px solid var(--border);padding:10px 24px;text-align:center;font-size:12px;color:var(--text-muted)">
    <a href="#" onclick="abrirLegal('privacidad')">Política de privacidad</a> · <a href="#" onclick="abrirLegal('cookies')">Cookies</a> · <a href="#" onclick="abrirLegal('terminos')">Términos de uso</a> · Asopiel © 2026
  </footer>
  <main class="main">
    <!-- ADMIN -->
    <div id="viewAdmin" style="display:none">
      <div class="tabs" id="adminTabs">
        <button class="tab active" onclick="adminTab('metricas')">📊 Métricas</button>
        <button class="tab" onclick="adminTab('pendientes')">⏳ Pendientes</button>
        <button class="tab" onclick="adminTab('trabajadores')">👷 Trabajadores</button>
        <button class="tab" onclick="adminTab('empresas')">🏭 Empresas</button>
        <button class="tab" onclick="adminTab('ofertas')">📋 Ofertas</button>
        <button class="tab" onclick="adminTab('sugerencias')" id="tabBtnSugerencias">💡 Sugerencias</button>
      </div>

      <!-- Métricas -->
      <div id="tabMetricas" class="tab-panel active">
        <div class="stats-bar" id="statsBar">
          <div class="stat-card"><div class="stat-value" id="statEmpresas">—</div><div class="stat-label">Empresas activas</div></div>
          <div class="stat-card"><div class="stat-value" id="statTrabajadores">—</div><div class="stat-label">Trabajadores activos</div></div>
          <div class="stat-card"><div class="stat-value" id="statOfertas">—</div><div class="stat-label">Ofertas activas</div></div>
          <div class="stat-card"><div class="stat-value" id="statPendientes">—</div><div class="stat-label">Registros pendientes</div></div>
        </div>
        <div class="card">
          <div class="card-header"><h2>Resumen del portal</h2></div>
          <div class="card-body">
            <p style="color:var(--text-secondary);font-size:14px">Bienvenido al panel de administración del Portal de Empleo Piel de Ubrique. Desde aquí puede gestionar registros, validar certificados y asignar perfiles a ofertas.</p>
          </div>
        </div>
      </div>

      <!-- Pendientes -->
      <div id="tabPendientes" class="tab-panel">
        <div class="section-header"><div><div class="section-title">Registros pendientes</div><div class="section-sub">Apruebe o rechace cada solicitud</div></div></div>
        <div id="pendientesContent">
          <div class="alert alert-info">Cargando...</div>
        </div>
      </div>

      <!-- Trabajadores -->
      <div id="tabTrabajadores" class="tab-panel">
        <div class="section-header"><div><div class="section-title">Trabajadores</div></div></div>
        <div class="card">
          <div class="card-body">
            <div class="table-wrap">
              <table id="tablaTrabajadores">
                <thead><tr><th>Nombre</th><th>DNI</th><th>Localidad</th><th>Estado</th><th>Empleos</th><th>Acciones</th></tr></thead>
                <tbody id="bodyTrabajadores"><tr><td colspan="6" style="text-align:center;color:var(--text-muted)">Cargando...</td></tr></tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <!-- Empresas -->
      <div id="tabEmpresas" class="tab-panel">
        <div class="section-header"><div><div class="section-title">Empresas</div></div></div>
        <div class="card">
          <div class="card-body">
            <div class="table-wrap">
              <table>
                <thead><tr><th>Empresa</th><th>CIF</th><th>Contacto</th><th>Email</th><th>Estado</th></tr></thead>
                <tbody id="bodyEmpresas"><tr><td colspan="5" style="text-align:center;color:var(--text-muted)">Cargando...</td></tr></tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <!-- Ofertas -->
      <div id="tabOfertas" class="tab-panel">
        <div class="section-header"><div><div class="section-title">Ofertas de empleo</div><div class="section-sub">Valide y asigne perfiles a cada oferta</div></div></div>
        <div id="ofertasAdminContent"><div class="alert alert-info">Cargando...</div></div>
      </div>

      <!-- Sugerencias de formación -->
      <div id="tabSugerencias" class="tab-panel">
        <div class="section-header"><div><div class="section-title">💡 Propuestas de formación</div><div class="section-sub">Sugerencias enviadas por los trabajadores</div></div></div>
        <div id="sugerenciasAdminContent"><div class="alert alert-info">Cargando...</div></div>
      </div>
    </div>

    <!-- TRABAJADOR -->
    <div id="viewTrabajador" style="display:none">
      <div class="tabs">
        <button class="tab active" onclick="trabTab('miPerfil')">👤 Mi perfil</button>
        <button class="tab" onclick="trabTab('misEmpleos')">💼 Mi historial</button>
        <button class="tab" onclick="trabTab('ofertasPublicas')">📋 Ofertas públicas</button>
      </div>

      <!-- Mi perfil -->
      <div id="tabMiPerfil" class="tab-panel active">
        <div class="card">
          <div class="card-header"><h2>Mis datos</h2></div>
          <div class="card-body" id="miPerfilBody">
            <div class="alert alert-info">Cargando...</div>
          </div>
        </div>
      </div>

      <!-- Mis empleos -->
      <div id="tabMisEmpleos" class="tab-panel">
        <div class="section-header">
          <div><div class="section-title">Historial laboral</div><div class="section-sub">Añada sus empleos anteriores y suba los certificados</div></div>
          <button class="btn btn-primary" onclick="abrirModalEmpleo()">+ Añadir empleo</button>
        </div>
        <div id="misEmpleosContent"><div class="alert alert-info">Cargando...</div></div>
      </div>

      <!-- Ofertas públicas -->
      <div id="tabOfertasPublicas" class="tab-panel">
        <div class="section-header"><div><div class="section-title">Ofertas publicadas</div></div></div>
        <div id="ofertasPublicasContent"><div class="alert alert-info">Cargando...</div></div>
      </div>
    </div>

    <!-- EMPRESA -->
    <div id="viewEmpresa" style="display:none">
      <div class="tabs">
        <button class="tab active" onclick="empTab('misOfertas')">📋 Mis ofertas</button>
        <button class="tab" onclick="empTab('nuevaOferta')">+ Nueva oferta</button>
      </div>

      <!-- Mis ofertas -->
      <div id="tabMisOfertas" class="tab-panel active">
        <div class="section-header"><div><div class="section-title">Mis ofertas de empleo</div><div class="section-sub">Gestione sus vacantes y los perfiles asignados por Asopiel</div></div></div>
        <div id="misOfertasContent"><div class="alert alert-info">Cargando...</div></div>
      </div>

      <!-- Nueva oferta -->
      <div id="tabNuevaOferta" class="tab-panel">
        <div class="card" style="max-width:640px">
          <div class="card-header"><h2>Publicar nueva oferta</h2></div>
          <div class="card-body">
            <div class="alert alert-info">Su oferta será revisada por Asopiel antes de asignarle candidatos.</div>
            <div class="form-group"><label class="form-label">Título del puesto <span class="req">*</span></label><input id="ofTitulo" class="form-control" placeholder="Ej: Oficial de primera cortador"></div>
            <div class="form-group"><label class="form-label">Descripción</label><textarea id="ofDescripcion" class="form-control" placeholder="Descripción del puesto, condiciones, jornada..."></textarea></div>
            <div class="form-group">
              <label class="form-label">Área <span class="req">*</span></label>
              <select id="ofSector" class="form-control" onchange="actualizarCategoriasOferta()">
                <option value="">— Seleccione —</option>
                <option value="fabricacion">Fabricación</option>
                <option value="oficina">Oficina / Logística</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Categoría <span class="req">*</span></label>
              <select id="ofCategoria" class="form-control">
                <option value="">— Seleccione área primero —</option>
              </select>
            </div>
            <div id="ofOficioWrap" class="form-group" style="display:none">
              <label class="form-label">Oficio</label>
              <select id="ofOficio" class="form-control">
                <option value="">— Cualquier oficio —</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-check"><input type="checkbox" id="ofPublica"> Hacer esta oferta visible públicamente en el portal</label>
            </div>
            <div id="ofError" class="alert alert-danger" style="display:none"></div>
            <div id="ofOk" class="alert alert-success" style="display:none"></div>
            <button class="btn btn-primary" onclick="publicarOferta()">Enviar oferta</button>
          </div>
        </div>
      </div>
    </div>
  </main>
</div>

<!-- Modal: añadir empleo (trabajador) -->
<div id="modalEmpleo" class="modal-overlay">
  <div class="modal">
    <div class="modal-header">
      <h3>Añadir empleo</h3>
      <button class="modal-close" onclick="cerrarModal('modalEmpleo')">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-group"><label class="form-label">Empresa empleadora <span class="req">*</span></label><input id="emEmpresa" class="form-control" placeholder="Nombre de la empresa"></div>
      <div class="form-group"><label class="form-label">CIF de la empresa</label><input id="emCif" class="form-control" placeholder="B12345678"></div>
      <div class="form-grid">
        <div class="form-group"><label class="form-label">Fecha de inicio</label><input id="emFechaInicio" type="date" class="form-control"></div>
        <div class="form-group"><label class="form-label">Fecha de fin</label><input id="emFechaFin" type="date" class="form-control" id="emFechaFinInput"></div>
      </div>
      <div class="form-group">
        <label class="form-check"><input type="checkbox" id="emEnActivo" onchange="toggleFechaFin(this)"> Sigo trabajando aquí</label>
      </div>
      <div class="form-group">
        <label class="form-label">Área <span class="req">*</span></label>
        <select id="emSector" class="form-control" onchange="actualizarCategoriasEmpleo()">
          <option value="">— Seleccione —</option>
          <option value="fabricacion">Fabricación</option>
          <option value="oficina">Oficina / Logística</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Categoría profesional <span class="req">*</span></label>
        <select id="emCategoria" class="form-control">
          <option value="">— Seleccione área primero —</option>
        </select>
      </div>
      <div id="emOficioWrap" class="form-group" style="display:none">
        <label class="form-label">Oficio desempeñado</label>
        <select id="emOficio" class="form-control">
          <option value="">— Seleccione —</option>
        </select>
      </div>
      <div class="form-group"><label class="form-label">Tareas desarrolladas</label><textarea id="emTareas" class="form-control" placeholder="Describa las principales tareas que realizaba (máx. 500 palabras)"></textarea></div>
      <div id="emError" class="alert alert-danger" style="display:none"></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="cerrarModal('modalEmpleo')">Cancelar</button>
      <button class="btn btn-primary" onclick="guardarEmpleo()">Guardar empleo</button>
    </div>
  </div>
</div>

<!-- Modal: subir certificado -->
<div id="modalCertificado" class="modal-overlay">
  <div class="modal">
    <div class="modal-header">
      <h3>Subir certificado de empresa</h3>
      <button class="modal-close" onclick="cerrarModal('modalCertificado')">✕</button>
    </div>
    <div class="modal-body">
      <div class="alert alert-info">Suba el certificado firmado por la empresa. Asopiel lo revisará y validará.</div>
      <div class="form-group">
        <label class="form-label">Archivo (PDF)</label>
        <input id="certFile" type="file" accept=".pdf,.jpg,.jpeg,.png" class="form-control">
        <div class="form-hint">Formatos admitidos: PDF, JPG, PNG. Tamaño máximo: 2 MB</div>
      </div>
      <div id="certError" class="alert alert-danger" style="display:none"></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="cerrarModal('modalCertificado')">Cancelar</button>
      <button class="btn btn-primary" onclick="subirCertificado()">Subir certificado</button>
    </div>
  </div>
</div>

<!-- Modal: ver perfil trabajador (admin) -->
<div id="modalPerfil" class="modal-overlay">
  <div class="modal" style="max-width:700px">
    <div class="modal-header">
      <h3>Perfil del trabajador</h3>
      <button class="modal-close" onclick="cerrarModal('modalPerfil')">✕</button>
    </div>
    <div class="modal-body" id="modalPerfilBody"></div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="cerrarModal('modalPerfil')">Cerrar</button>
    </div>
  </div>
</div>

<!-- Modal: desbloquear perfiles para oferta (admin) -->
<div id="modalDesbloquear" class="modal-overlay">
  <div class="modal" style="max-width:700px">
    <div class="modal-header">
      <h3 id="modalDesbloquearTitulo">Asignar perfiles a oferta</h3>
      <button class="modal-close" onclick="cerrarModal('modalDesbloquear')">✕</button>
    </div>
    <div class="modal-body" id="modalDesbloquearBody"></div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="cerrarModal('modalDesbloquear')">Cancelar</button>
      <button class="btn btn-primary" onclick="guardarDesbloqueo()">Guardar asignación</button>
    </div>
  </div>
</div>

<script>
// ── Config ─────────────────────────────────────────────────
const API = '';  // mismo origen
let TOKEN = null, ROL = null, NOMBRE_USER = null, USER_ID = null;
let CATEGORIAS = null;
let currentEmpleoId = null; // para subida de certificado
let currentOfertaId = null; // para desbloqueo

// ── Init ───────────────────────────────────────────────────
async function init() {
  await loadCategorias();
  const stored = sessionStorage.getItem('portalToken');
  if (stored) {
    const d = JSON.parse(stored);
    TOKEN = d.token; ROL = d.role; NOMBRE_USER = d.nombre; USER_ID = d.id;
    showApp();
  }
}

async function loadCategorias() {
  const r = await fetch(API + '/categorias');
  CATEGORIAS = await r.json();
}

// ── Auth ───────────────────────────────────────────────────
async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const err = document.getElementById('loginError');
  err.style.display = 'none';
  try {
    const r = await fetch(API + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error; err.style.display = 'block'; return; }
    TOKEN = d.token; ROL = d.role; NOMBRE_USER = d.nombre; USER_ID = d.id;
    sessionStorage.setItem('portalToken', JSON.stringify({ token: TOKEN, role: ROL, nombre: NOMBRE_USER, id: USER_ID }));
    showApp();
  } catch(e) { err.textContent = 'Error de conexión'; err.style.display = 'block'; }
}

function doLogout() {
  sessionStorage.removeItem('portalToken');
  TOKEN = null; ROL = null;
  document.getElementById('appWrap').style.display = 'none';
  document.getElementById('loginWrap').style.display = 'flex';
}

function headers() { return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN }; }

// ── Show app ───────────────────────────────────────────────
function showApp() {
  document.getElementById('loginWrap').style.display = 'none';
  document.getElementById('appWrap').style.display = 'block';
  document.getElementById('headerUser').textContent = NOMBRE_USER;
  const roleLabels = { admin: 'Administrador Asopiel', empresa: 'Empresa', trabajador: 'Trabajador' };
  document.getElementById('headerRole').textContent = roleLabels[ROL] || ROL;
  document.getElementById('viewAdmin').style.display = ROL === 'admin' ? 'block' : 'none';
  document.getElementById('viewTrabajador').style.display = ROL === 'trabajador' ? 'block' : 'none';
  document.getElementById('viewEmpresa').style.display = ROL === 'empresa' ? 'block' : 'none';
  if (ROL === 'admin') { loadMetricas(); loadPendientes(); loadTrabajadoresAdmin(); loadEmpresasAdmin(); loadOfertasAdmin(); loadSugerenciasAdmin(); }
  if (ROL === 'trabajador') { loadMiPerfil(); loadMisEmpleos(); loadOfertasPublicas(); }
  if (ROL === 'empresa') { loadMisOfertas(); }
}

// ── Login tabs ─────────────────────────────────────────────
function switchLoginTab(tab) {
  document.getElementById('loginPanel').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('registroEmpresaPanel').style.display = tab === 'registro-empresa' ? 'block' : 'none';
  document.getElementById('registroTrabajadorPanel').style.display = tab === 'registro-trabajador' ? 'block' : 'none';
  document.querySelectorAll('.login-tab').forEach((t, i) => {
    const tabs = ['login', 'registro-empresa', 'registro-trabajador'];
    t.classList.toggle('active', tabs[i] === tab);
  });
}

// ── Admin tabs ─────────────────────────────────────────────
function adminTab(name) {
  const panels = ['metricas','pendientes','trabajadores','empresas','ofertas','sugerencias'];
  panels.forEach(p => { document.getElementById('tab' + cap(p)).classList.toggle('active', p === name); });
  document.querySelectorAll('#adminTabs .tab').forEach((t, i) => t.classList.toggle('active', panels[i] === name));
  if (name === 'sugerencias') loadSugerenciasAdmin();
}
function trabTab(name) {
  const panels = ['miPerfil','misEmpleos','ofertasPublicas'];
  panels.forEach(p => { document.getElementById('tab' + cap(p)).classList.toggle('active', p === name); });
  document.querySelectorAll('#viewTrabajador .tab').forEach((t, i) => t.classList.toggle('active', panels[i] === name));
}
function empTab(name) {
  const panels = ['misOfertas','nuevaOferta'];
  panels.forEach(p => { document.getElementById('tab' + cap(p)).classList.toggle('active', p === name); });
  document.querySelectorAll('#viewEmpresa .tab').forEach((t, i) => t.classList.toggle('active', panels[i] === name));
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ── Registro empresa ───────────────────────────────────────
async function registrarEmpresa() {
  const err = document.getElementById('reError'), ok = document.getElementById('reOk');
  err.style.display = 'none'; ok.style.display = 'none';
  const body = { nombre: document.getElementById('reNombre').value.trim(), cif: document.getElementById('reCif').value.trim(), contacto: document.getElementById('reContacto').value.trim(), telefono: document.getElementById('reTel').value.trim(), email: document.getElementById('reEmail').value.trim() };
  if (!body.nombre || !body.cif || !body.email) { err.textContent = 'Complete los campos obligatorios'; err.style.display = 'block'; return; }
  if (!document.getElementById('reConsentimiento').checked) { err.textContent = 'Debe aceptar la política de protección de datos para continuar.'; err.style.display = 'block'; return; }
  try {
    const r = await fetch(API + '/empresas/registro', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error; err.style.display = 'block'; return; }
    ok.textContent = d.message; ok.style.display = 'block';
  } catch(e) { err.textContent = 'Error de conexión'; err.style.display = 'block'; }
}

// ── Registro trabajador ────────────────────────────────────
async function registrarTrabajador() {
  const err = document.getElementById('rtError'), ok = document.getElementById('rtOk');
  err.style.display = 'none'; ok.style.display = 'none';
  const body = { nombre: document.getElementById('rtNombre').value.trim(), apellidos: document.getElementById('rtApellidos').value.trim(), dni: document.getElementById('rtDni').value.trim(), telefono: document.getElementById('rtTel').value.trim(), direccion: document.getElementById('rtDireccion').value.trim(), localidad: document.getElementById('rtLocalidad').value.trim(), email: document.getElementById('rtEmail').value.trim() };
  if (!body.nombre || !body.apellidos || !body.dni || !body.email) { err.textContent = 'Complete los campos obligatorios'; err.style.display = 'block'; return; }
  if (!document.getElementById('rtConsentimiento').checked) { err.textContent = 'Debe aceptar la política de protección de datos para continuar.'; err.style.display = 'block'; return; }
  try {
    const r = await fetch(API + '/trabajadores/registro', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error; err.style.display = 'block'; return; }
    ok.textContent = d.message; ok.style.display = 'block';
  } catch(e) { err.textContent = 'Error de conexión'; err.style.display = 'block'; }
}

// ── Admin: métricas ────────────────────────────────────────
async function loadMetricas() {
  const r = await fetch(API + '/admin/metricas', { headers: headers() });
  if (!r.ok) return;
  const d = await r.json();
  document.getElementById('statEmpresas').textContent = d.empresas.activas;
  document.getElementById('statTrabajadores').textContent = d.trabajadores.activos;
  document.getElementById('statOfertas').textContent = d.ofertas.activas;
  document.getElementById('statPendientes').textContent = d.empresas.pendientes + d.trabajadores.pendientes;
}

// ── Admin: pendientes ──────────────────────────────────────
async function loadPendientes() {
  const div = document.getElementById('pendientesContent');
  const r = await fetch(API + '/admin/pendientes', { headers: headers() });
  const d = await r.json();
  const total = d.empresas.length + d.trabajadores.length;
  if (total === 0) { div.innerHTML = '<div class="alert alert-success">No hay registros pendientes.</div>'; return; }
  let html = '';
  if (d.empresas.length > 0) {
    html += '<h3 style="font-size:14px;font-weight:600;margin-bottom:12px;color:var(--text-secondary)">EMPRESAS</h3>';
    html += '<div class="table-wrap"><table><thead><tr><th>Empresa</th><th>CIF</th><th>Contacto</th><th>Email</th><th>Fecha</th><th>Acciones</th></tr></thead><tbody>';
    for (const e of d.empresas) {
      html += \`<tr><td><strong>\${e.nombre}</strong></td><td>\${e.cif}</td><td>\${e.contacto||'—'}</td><td>\${e.email}</td><td>\${fmtDate(e.createdAt)}</td><td style="display:flex;gap:6px"><button class="btn btn-success btn-sm" onclick="aprobarEmpresa('\${e.id}')">✓ Aprobar</button><button class="btn btn-danger btn-sm" onclick="rechazar('empresas','\${e.id}')">✗ Rechazar</button></td></tr>\`;
    }
    html += '</tbody></table></div>';
  }
  if (d.trabajadores.length > 0) {
    html += '<h3 style="font-size:14px;font-weight:600;margin:20px 0 12px;color:var(--text-secondary)">TRABAJADORES</h3>';
    html += '<div class="table-wrap"><table><thead><tr><th>Nombre</th><th>DNI</th><th>Localidad</th><th>Email</th><th>Fecha</th><th>Acciones</th></tr></thead><tbody>';
    for (const t of d.trabajadores) {
      html += \`<tr><td><strong>\${t.nombre} \${t.apellidos}</strong></td><td>\${t.dni}</td><td>\${t.localidad||'—'}</td><td>\${t.email}</td><td>\${fmtDate(t.createdAt)}</td><td style="display:flex;gap:6px"><button class="btn btn-success btn-sm" onclick="aprobarTrabajador('\${t.id}')">✓ Aprobar</button><button class="btn btn-danger btn-sm" onclick="rechazar('trabajadores','\${t.id}')">✗ Rechazar</button></td></tr>\`;
    }
    html += '</tbody></table></div>';
  }
  div.innerHTML = html;
}

async function aprobarEmpresa(id) {
  await fetch(API + \`/admin/empresas/\${id}/aprobar\`, { method: 'POST', headers: headers() });
  loadPendientes(); loadMetricas(); loadEmpresasAdmin();
}
async function aprobarTrabajador(id) {
  await fetch(API + \`/admin/trabajadores/\${id}/aprobar\`, { method: 'POST', headers: headers() });
  loadPendientes(); loadMetricas(); loadTrabajadoresAdmin();
}
async function rechazar(tipo, id) {
  if (!confirm('¿Confirma que desea rechazar este registro?')) return;
  await fetch(API + \`/admin/\${tipo}/\${id}/rechazar\`, { method: 'POST', headers: headers() });
  loadPendientes(); loadMetricas();
}

// ── Admin: trabajadores ────────────────────────────────────
async function loadTrabajadoresAdmin() {
  const r = await fetch(API + '/admin/trabajadores', { headers: headers() });
  const lista = await r.json();
  const tbody = document.getElementById('bodyTrabajadores');
  if (!lista.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">Sin trabajadores registrados</td></tr>'; return; }
  tbody.innerHTML = lista.map(t => {
    const badge = t.status === 'activo' ? '<span class="badge badge-success">Activo</span>' : t.status === 'pendiente' ? '<span class="badge badge-warning">Pendiente</span>' : '<span class="badge badge-danger">Rechazado</span>';
    return \`<tr><td><strong>\${t.nombre} \${t.apellidos}</strong></td><td>\${t.dni}</td><td>\${t.localidad||'—'}</td><td>\${badge}</td><td>—</td><td><button class="btn btn-outline btn-sm" onclick="verPerfilTrabajador('\${t.id}')">Ver perfil</button></td></tr>\`;
  }).join('');
}

async function verPerfilTrabajador(id) {
  const r = await fetch(API + '/admin/trabajadores', { headers: headers() });
  const lista = await r.json();
  const t = lista.find(x => x.id === id);
  if (!t) return;
  // Cargar empleos
  const rPerfil = await fetch(API + '/mi-perfil', { headers: { Authorization: 'Bearer ' + TOKEN } }); // admin no tiene acceso directo, mostramos datos básicos
  const body = document.getElementById('modalPerfilBody');
  body.innerHTML = \`
    <div class="perfil-header">
      <div class="perfil-avatar">\${t.nombre.charAt(0)}</div>
      <div><div class="perfil-nombre">\${t.nombre} \${t.apellidos}</div><div class="perfil-sub">\${t.direccion ? t.direccion+', ' : ''}\${t.localidad||''} · \${t.email}</div></div>
    </div>
    <div class="form-grid" style="margin-top:12px">
      <div><span style="font-size:12px;color:var(--text-muted)">DNI</span><div style="font-size:14px;font-weight:500">\${t.dni}</div></div>
      <div><span style="font-size:12px;color:var(--text-muted)">Teléfono</span><div style="font-size:14px;font-weight:500">\${t.telefono||'—'}</div></div>
      <div><span style="font-size:12px;color:var(--text-muted)">Dirección</span><div style="font-size:14px;font-weight:500">\${t.direccion ? t.direccion+', '+( t.localidad||'') : (t.localidad||'—')}</div></div>
    </div>
    \${t.disciplinas && t.disciplinas.length ? \`
    <div style="margin-top:16px">
      <div style="font-size:14px;font-weight:600;margin-bottom:8px">🛠 Disciplinas y categorías</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        \${t.disciplinas.map(d=>\`<span class="badge badge-accent" style="font-size:12px">\${d.oficio} · \${d.categoria}</span>\`).join('')}
      </div>
    </div>\` : '<div style="margin-top:16px;color:var(--text-muted);font-size:13px">Sin disciplinas registradas.</div>'}
    <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
      <div style="font-size:14px;font-weight:600;margin-bottom:8px">📄 Vida laboral</div>
      \${t.vidaLaboralFileName
        ? \`<div style="display:flex;align-items:center;gap:10px">
             <span style="font-size:13px">📎 \${escHtml(t.vidaLaboralFileName)}</span>
             <span style="font-size:11px;color:var(--text-muted)">\${t.vidaLaboralFecha ? fmtDate(t.vidaLaboralFecha) : ''}</span>
             <a href="\${API}/vida-laboral/\${t.id}?token=\${TOKEN}" target="_blank" class="btn btn-outline btn-sm">Abrir</a>
           </div>\`
        : '<span style="font-size:13px;color:var(--text-muted)">No ha subido vida laboral todavía.</span>'}
    </div>
    \${t.recibirCursos ? '<div style="margin-top:10px"><span class="badge badge-success">✓ Interesado en recibir info de cursos</span></div>' : ''}
    <div style="margin-top:12px;color:var(--text-muted);font-size:13px">Para ver el historial completo de empleos, el trabajador debe haber iniciado sesión y añadido sus empleos.</div>
  \`;
  document.getElementById('modalPerfil').classList.add('open');
}

// ── Admin: empresas ────────────────────────────────────────
async function loadEmpresasAdmin() {
  const r = await fetch(API + '/admin/empresas', { headers: headers() });
  const lista = await r.json();
  const tbody = document.getElementById('bodyEmpresas');
  if (!lista.length) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">Sin empresas registradas</td></tr>'; return; }
  tbody.innerHTML = lista.map(e => {
    const badge = e.status === 'activo' ? '<span class="badge badge-success">Activa</span>' : e.status === 'pendiente' ? '<span class="badge badge-warning">Pendiente</span>' : '<span class="badge badge-danger">Rechazada</span>';
    return \`<tr><td><strong>\${e.nombre}</strong></td><td>\${e.cif}</td><td>\${e.contacto||'—'}</td><td>\${e.email}</td><td>\${badge}</td></tr>\`;
  }).join('');
}

// ── Admin: ofertas ─────────────────────────────────────────
async function loadOfertasAdmin() {
  const div = document.getElementById('ofertasAdminContent');
  const r = await fetch(API + '/admin/ofertas', { headers: headers() });
  const lista = await r.json();
  if (!lista.length) { div.innerHTML = '<div class="alert alert-info">No hay ofertas publicadas todavía.</div>'; return; }
  div.innerHTML = lista.map(o => {
    const badge = o.status === 'activa' ? '<span class="badge badge-success">Activa</span>' : o.status === 'pendiente' ? '<span class="badge badge-warning">Pendiente validación</span>' : '<span class="badge badge-gray">Cerrada</span>';
    const publicaBadge = o.publica ? '<span class="badge badge-accent">Pública</span>' : '<span class="badge badge-gray">Privada</span>';
    return \`<div class="oferta-card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div class="oferta-titulo">\${o.titulo}</div>
        <div style="display:flex;gap:6px">\${badge}\${publicaBadge}</div>
      </div>
      \${o.nombreEmpresa ? \`<div style="font-size:13px;font-weight:600;color:var(--primary);margin-bottom:4px">🏭 \${o.nombreEmpresa}</div>\` : ''}
      <div class="oferta-meta" style="margin-top:8px">
        <span>📁 \${o.sector === 'fabricacion' ? 'Fabricación' : 'Oficina/Logística'}</span>
        <span>🏷 \${o.categoria}</span>
        \${o.oficio ? \`<span>🔧 \${o.oficio}</span>\` : ''}
        <span>📅 \${fmtDate(o.createdAt)}</span>
      </div>
      \${o.descripcion ? \`<p style="font-size:13px;color:var(--text-secondary);margin-top:8px">\${o.descripcion}</p>\` : ''}
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-primary btn-sm" onclick="abrirDesbloqueo('\${o.id}', '\${escHtml(o.titulo)}')">👥 Asignar perfiles (\${(o.perfilesDesbloqueados||[]).length} asignados)</button>
        \${o.status==='pendiente' ? \`<button class="btn btn-success btn-sm" onclick="activarOferta('\${o.id}')">✓ Activar oferta</button>\` : ''}
      </div>
    </div>\`;
  }).join('');
}

async function loadSugerenciasAdmin() {
  const div = document.getElementById('sugerenciasAdminContent');
  if (!div) return;
  const r = await fetch(API + '/admin/sugerencias', { headers: headers() });
  const lista = await r.json();
  // Actualizar badge en pestaña
  const noLeidas = lista.filter(s => !s.leida).length;
  const btn = document.getElementById('tabBtnSugerencias');
  if (btn) btn.textContent = noLeidas > 0 ? \`💡 Sugerencias (\${noLeidas})\` : '💡 Sugerencias';
  if (!lista.length) { div.innerHTML = '<div class="alert alert-info">Aún no hay propuestas de formación enviadas.</div>'; return; }
  div.innerHTML = lista.map(s => \`
    <div class="oferta-card" style="\${s.leida ? 'opacity:0.7' : 'border-left:3px solid var(--primary)'}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <div>
          <span style="font-size:14px;font-weight:600">\${escHtml(s.nombre)}</span>
          <span style="font-size:12px;color:var(--text-muted);margin-left:8px">\${fmtDate(s.createdAt)}</span>
        </div>
        \${s.leida
          ? '<span class="badge badge-gray">Leída</span>'
          : \`<button class="btn btn-outline btn-sm" onclick="marcarSugerenciaLeida('\${s.id}')">✓ Marcar leída</button>\`}
      </div>
      <p style="font-size:14px;color:var(--text-secondary);margin:0;white-space:pre-wrap">\${escHtml(s.texto)}</p>
    </div>
  \`).join('');
}

async function marcarSugerenciaLeida(id) {
  await fetch(API + \`/admin/sugerencias/\${id}/leer\`, { method: 'POST', headers: headers() });
  loadSugerenciasAdmin();
}

async function activarOferta(id) {
  await fetch(API + \`/admin/ofertas/\${id}/desbloquear\`, { method: 'POST', headers: headers(), body: JSON.stringify({ perfiles: [] }) });
  loadOfertasAdmin();
}

// ── Admin: desbloquear perfiles ────────────────────────────
async function abrirDesbloqueo(ofertaId, titulo) {
  currentOfertaId = ofertaId;
  document.getElementById('modalDesbloquearTitulo').textContent = 'Asignar perfiles: ' + titulo;
  const body = document.getElementById('modalDesbloquearBody');
  body.innerHTML = '<div class="alert alert-info">Cargando trabajadores...</div>';
  document.getElementById('modalDesbloquear').classList.add('open');
  const [rTrab, rOferta] = await Promise.all([
    fetch(API + '/admin/trabajadores', { headers: headers() }),
    fetch(API + \`/admin/ofertas\`, { headers: headers() }),
  ]);
  const trabajadores = (await rTrab.json()).filter(t => t.status === 'activo');
  const ofertas = await rOferta.json();
  const oferta = ofertas.find(o => o.id === ofertaId);
  const desbloqueados = oferta?.perfilesDesbloqueados || [];
  if (!trabajadores.length) { body.innerHTML = '<div class="alert alert-warning">No hay trabajadores activos registrados.</div>'; return; }
  body.innerHTML = \`
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">Seleccione los trabajadores cuyo perfil desea mostrar a la empresa para esta oferta.</p>
    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
      <button class="btn btn-outline btn-sm" onclick="seleccionarSector('fabricacion')">🏭 Todos Fabricación</button>
      <button class="btn btn-outline btn-sm" onclick="seleccionarSector('oficina')">🗂 Todos Oficina/Logística</button>
      <button class="btn btn-outline btn-sm" onclick="seleccionarSector('todos')">✅ Seleccionar todos</button>
      <button class="btn btn-outline btn-sm" onclick="seleccionarSector('ninguno')">✕ Deseleccionar todos</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">
      \${trabajadores.map(t => \`
        <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;cursor:pointer;background:var(--bg)" data-sectores="\${(t.sectores||[]).join(',')}">
          <input type="checkbox" class="desbloqueo-check" value="\${t.id}" \${desbloqueados.includes(t.id)?'checked':''}>
          <div>
            <div style="font-size:14px;font-weight:500">\${t.nombre} \${t.apellidos}</div>
            <div style="font-size:12px;color:var(--text-muted)">\${t.direccion ? t.direccion+', ' : ''}\${t.localidad||''} · DNI: \${t.dni}\${t.sectores&&t.sectores.length?' · '+t.sectores.map(s=>s==='fabricacion'?'Fabricación':'Oficina/Logística').join(', '):''}</div>
          </div>
        </label>
      \`).join('')}
    </div>
  \`;
}

async function guardarDesbloqueo() {
  const checks = document.querySelectorAll('.desbloqueo-check:checked');
  const perfiles = Array.from(checks).map(c => c.value);
  await fetch(API + \`/admin/ofertas/\${currentOfertaId}/desbloquear\`, { method: 'POST', headers: headers(), body: JSON.stringify({ perfiles }) });
  cerrarModal('modalDesbloquear');
  loadOfertasAdmin();
}

function seleccionarSector(sector) {
  const labels = document.querySelectorAll('#modalDesbloquearBody label[data-sectores]');
  labels.forEach(label => {
    const check = label.querySelector('input[type=checkbox]');
    const sectores = label.getAttribute('data-sectores');
    if (sector === 'todos') check.checked = true;
    else if (sector === 'ninguno') check.checked = false;
    else check.checked = sectores.includes(sector);
  });
}

// ── Trabajador: mi perfil ──────────────────────────────────
async function loadMiPerfil() {
  const r = await fetch(API + '/mi-perfil', { headers: headers() });
  const d = await r.json();
  const body = document.getElementById('miPerfilBody');
  const disciplinas = d.disciplinas || [];
  const disciplinasHtml = disciplinas.length
    ? disciplinas.map((disc, i) => \`
        <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg)">
          <div style="flex:1">
            <span style="font-size:13px;font-weight:500">\${disc.oficio}</span>
            <span style="font-size:12px;color:var(--text-muted);margin-left:8px">· \${disc.categoria}</span>
          </div>
          <button class="btn btn-outline btn-sm" style="color:var(--danger)" onclick="eliminarDisciplina(\${i})">✕</button>
        </div>\`).join('')
    : '<div style="font-size:13px;color:var(--text-muted)">No ha añadido disciplinas todavía.</div>';

  body.innerHTML = \`
    <div class="perfil-header">
      <div class="perfil-avatar">\${d.nombre.charAt(0)}</div>
      <div><div class="perfil-nombre">\${d.nombre} \${d.apellidos}</div><div class="perfil-sub">\${d.direccion ? d.direccion+', ' : ''}\${d.localidad||''}</div></div>
    </div>
    <div class="form-grid" style="margin-top:16px">
      <div><span style="font-size:12px;color:var(--text-muted)">DNI/NIE</span><div style="font-size:14px;font-weight:500">\${d.dni}</div></div>
      <div><span style="font-size:12px;color:var(--text-muted)">Teléfono</span><div style="font-size:14px;font-weight:500">\${d.telefono||'—'}</div></div>
      <div><span style="font-size:12px;color:var(--text-muted)">Email</span><div style="font-size:14px;font-weight:500">\${d.email}</div></div>
      <div><span style="font-size:12px;color:var(--text-muted)">Estado</span><div>\${d.status==='activo'?'<span class="badge badge-success">Activo</span>':'<span class="badge badge-warning">Pendiente</span>'}</div></div>
    </div>
    <div style="margin-top:24px">
      <div style="font-size:15px;font-weight:600;margin-bottom:10px">🛠 Mis disciplinas y categorías</div>
      <div id="listaDisciplinas" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px">\${disciplinasHtml}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        <div>
          <label style="font-size:12px;color:var(--text-muted)">Disciplina (oficio)</label>
          <select id="nuevaDiscOficio" class="form-control" style="min-width:160px" onchange="actualizarCatDisc()">
            <option value="">Seleccione...</option>
            <optgroup label="Fabricación">\${(CATEGORIAS?.oficios||[]).map(o=>\`<option value="\${o}">\${o}</option>\`).join('')}</optgroup>
          </select>
        </div>
        <div>
          <label style="font-size:12px;color:var(--text-muted)">Categoría</label>
          <select id="nuevaDiscCategoria" class="form-control" style="min-width:180px">
            <option value="">Seleccione disciplina primero</option>
          </select>
        </div>
        <button class="btn btn-primary" onclick="agregarDisciplina()">+ Añadir</button>
      </div>
    </div>

    <div style="margin-top:28px;padding-top:24px;border-top:1px solid var(--border)">
      <div style="font-size:15px;font-weight:600;margin-bottom:14px">🎓 Formación</div>

      <label style="display:flex;align-items:center;gap:10px;padding:14px 16px;border:1px solid var(--border);border-radius:10px;background:var(--bg-card);cursor:pointer;margin-bottom:12px">
        <input type="checkbox" id="recibirCursosCheck" \${d.recibirCursos ? 'checked' : ''} onchange="toggleRecibirCursos(this.checked)" style="width:18px;height:18px;accent-color:var(--primary)">
        <div>
          <div style="font-size:14px;font-weight:500">Quiero recibir información sobre cursos del sector</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">Asopiel te avisará cuando haya cursos, talleres o seminarios de marroquinería disponibles</div>
        </div>
      </label>

      <div style="padding:14px 16px;border:1px solid var(--border);border-radius:10px;background:var(--bg-card);margin-bottom:12px">
        <div style="font-size:14px;font-weight:500;margin-bottom:8px">📄 Vida laboral</div>
        \${d.vidaLaboralFileName
          ? \`<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
               <span style="font-size:13px;color:var(--text-secondary)">📎 \${escHtml(d.vidaLaboralFileName)}</span>
               <span style="font-size:11px;color:var(--text-muted)">\${d.vidaLaboralFecha ? '(subida el ' + fmtDate(d.vidaLaboralFecha) + ')' : ''}</span>
               <a href="\${API}/vida-laboral/\${d.id}?token=\${TOKEN}" target="_blank" class="btn btn-outline btn-sm">Ver</a>
             </div>\`
          : '<div style="font-size:13px;color:var(--text-muted);margin-bottom:10px">Aún no ha subido su vida laboral.</div>'}
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <input type="file" id="vidaLaboralInput" accept=".pdf,.jpg,.jpeg,.png" style="display:none" onchange="subirVidaLaboral(this)">
          <button class="btn btn-outline btn-sm" onclick="document.getElementById('vidaLaboralInput').click()">
            \${d.vidaLaboralFileName ? '🔄 Actualizar vida laboral' : '⬆ Subir vida laboral'}
          </button>
          <span style="font-size:11px;color:var(--text-muted)">PDF, JPG o PNG · máx. 5 MB</span>
          <span id="vidaLaboralStatus" style="font-size:12px;color:var(--primary)"></span>
        </div>
      </div>

      <div style="padding:14px 16px;border:1px solid var(--border);border-radius:10px;background:var(--bg-card)">
        <div style="font-size:14px;font-weight:500;margin-bottom:6px">💡 Proponer formación a Asopiel</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">¿Echa en falta algún curso, taller o seminario? Cuéntenoslo y lo estudiaremos.</div>
        <textarea id="sugerenciaTexto" class="form-control" rows="3" placeholder="Ej: Sería interesante un taller de teñido de pieles para oficiales..." style="resize:vertical;margin-bottom:8px"></textarea>
        <button class="btn btn-primary btn-sm" onclick="enviarSugerencia()">Enviar propuesta</button>
        <span id="sugerenciaStatus" style="font-size:12px;color:var(--primary);margin-left:10px"></span>
      </div>

      <div style="margin-top:16px;padding:12px 14px;border:1px solid var(--border);border-radius:8px;font-size:12px;color:var(--text-muted)">
        🔒 <strong>Sus datos están protegidos.</strong> Puede ejercer sus derechos de acceso, rectificación, supresión, oposición, limitación y portabilidad escribiendo a <a href="mailto:gerencia@asopiel.com" style="color:var(--primary)">gerencia@asopiel.com</a>. Para solicitar la eliminación de su cuenta y datos: <a href="mailto:gerencia@asopiel.com?subject=Solicitud%20de%20supresión%20de%20datos&body=Solicito%20la%20supresión%20de%20mi%20cuenta%20y%20todos%20mis%20datos%20del%20Portal%20de%20Empleo%20de%20Asopiel." style="color:var(--primary)">enviar solicitud de supresión (art. 17 RGPD)</a>.
        Ver <a href="/privacidad" target="_blank" style="color:var(--primary)">política de privacidad completa</a>.
      </div>
    </div>
  \`;
  window._perfilDisciplinas = disciplinas.slice();
  window._perfilId = d.id;
}

function actualizarCatDisc() {
  const sel = document.getElementById('nuevaDiscCategoria');
  sel.innerHTML = (CATEGORIAS?.fabricacion||[]).map(c=>\`<option value="\${c}">\${c}</option>\`).join('');
}

async function agregarDisciplina() {
  const oficio = document.getElementById('nuevaDiscOficio').value;
  const categoria = document.getElementById('nuevaDiscCategoria').value;
  if (!oficio || !categoria) return;
  if (!window._perfilDisciplinas) window._perfilDisciplinas = [];
  if (window._perfilDisciplinas.find(d => d.oficio === oficio && d.categoria === categoria)) return;
  window._perfilDisciplinas.push({ oficio, categoria });
  await fetch(API + '/mi-perfil', { method: 'PUT', headers: headers(), body: JSON.stringify({ disciplinas: window._perfilDisciplinas }) });
  loadMiPerfil();
}

async function eliminarDisciplina(idx) {
  if (!window._perfilDisciplinas) return;
  window._perfilDisciplinas.splice(idx, 1);
  await fetch(API + '/mi-perfil', { method: 'PUT', headers: headers(), body: JSON.stringify({ disciplinas: window._perfilDisciplinas }) });
  loadMiPerfil();
}

async function toggleRecibirCursos(checked) {
  await fetch(API + '/mi-perfil', { method: 'PUT', headers: headers(), body: JSON.stringify({ recibirCursos: checked }) });
}

async function subirVidaLaboral(input) {
  const file = input.files[0];
  if (!file) return;
  const status = document.getElementById('vidaLaboralStatus');
  status.textContent = 'Subiendo...';
  const formData = new FormData();
  formData.append('file', file);
  const r = await fetch(API + '/vida-laboral', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: formData });
  const d = await r.json();
  if (d.ok) { status.textContent = '✓ Subido correctamente'; setTimeout(() => loadMiPerfil(), 800); }
  else { status.textContent = '✗ Error: ' + (d.error || 'desconocido'); }
}

async function enviarSugerencia() {
  const texto = document.getElementById('sugerenciaTexto').value.trim();
  const status = document.getElementById('sugerenciaStatus');
  if (!texto) { status.textContent = 'Escriba una propuesta antes de enviar.'; return; }
  status.textContent = 'Enviando...';
  const r = await fetch(API + '/sugerencias', { method: 'POST', headers: headers(), body: JSON.stringify({ texto }) });
  const d = await r.json();
  if (d.ok) {
    status.textContent = '✓ Propuesta enviada. ¡Gracias!';
    document.getElementById('sugerenciaTexto').value = '';
  } else {
    status.textContent = '✗ Error: ' + (d.error || 'desconocido');
  }
}

// ── Trabajador: empleos ────────────────────────────────────
async function loadMisEmpleos() {
  const r = await fetch(API + '/mi-perfil', { headers: headers() });
  const d = await r.json();
  const div = document.getElementById('misEmpleosContent');
  const empleos = d.empleos || [];
  if (!empleos.length) {
    div.innerHTML = '<div class="alert alert-warning">⚠️ No ha añadido ningún empleo todavía. Añada su historial laboral para mejorar su perfil.</div>';
    return;
  }
  div.innerHTML = empleos.map(e => {
    const certHtml = e.certificadoId
      ? (e.certificadoValidado
          ? '<div class="cert-status validado">✓ Certificado validado por Asopiel</div>'
          : '<div class="cert-status pendiente">⏳ Certificado pendiente de validación</div>')
      : \`<div class="cert-status sin-cert">⚠️ Sin certificado — <button class="btn btn-outline btn-sm" onclick="abrirSubirCertificado('\${e.id}')">Subir certificado</button></div>\`;
    return \`<div class="empleo-card">
      <div class="empleo-card-header">
        <div>
          <div class="empleo-empresa">\${e.empresa}</div>
          <div class="empleo-periodo">\${e.fechaInicio ? fmtDate(e.fechaInicio) : '—'} → \${e.enActivo ? 'Actualidad' : (e.fechaFin ? fmtDate(e.fechaFin) : '—')}</div>
        </div>
      </div>
      <div class="empleo-badges">
        <span class="badge badge-accent">\${e.sector === 'fabricacion' ? '🔧 Fabricación' : '🏢 Oficina'}</span>
        <span class="badge badge-gray">\${e.categoria}</span>
        \${e.oficio ? \`<span class="badge badge-gray">\${e.oficio}</span>\` : ''}
      </div>
      \${e.tareas ? \`<p style="font-size:13px;color:var(--text-secondary);margin-top:8px">\${e.tareas.substring(0,200)}\${e.tareas.length>200?'...':''}</p>\` : ''}
      \${certHtml}
    </div>\`;
  }).join('');
}

function abrirModalEmpleo() {
  document.getElementById('emEmpresa').value = '';
  document.getElementById('emCif').value = '';
  document.getElementById('emFechaInicio').value = '';
  document.getElementById('emFechaFin').value = '';
  document.getElementById('emEnActivo').checked = false;
  document.getElementById('emSector').value = '';
  document.getElementById('emCategoria').innerHTML = '<option value="">— Seleccione área primero —</option>';
  document.getElementById('emOficioWrap').style.display = 'none';
  document.getElementById('emTareas').value = '';
  document.getElementById('emError').style.display = 'none';
  document.getElementById('modalEmpleo').classList.add('open');
}

function toggleFechaFin(cb) {
  document.getElementById('emFechaFin').disabled = cb.checked;
  if (cb.checked) document.getElementById('emFechaFin').value = '';
}

function actualizarCategoriasEmpleo() {
  const sector = document.getElementById('emSector').value;
  const sel = document.getElementById('emCategoria');
  const oficioWrap = document.getElementById('emOficioWrap');
  sel.innerHTML = '<option value="">— Seleccione —</option>';
  if (!sector || !CATEGORIAS) return;
  const cats = sector === 'fabricacion' ? CATEGORIAS.fabricacion : CATEGORIAS.oficina;
  cats.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); });
  if (sector === 'fabricacion') {
    oficioWrap.style.display = 'block';
    const selO = document.getElementById('emOficio');
    selO.innerHTML = '<option value="">— Seleccione —</option>';
    CATEGORIAS.oficios.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; selO.appendChild(o); });
  } else {
    oficioWrap.style.display = 'none';
  }
}

function actualizarCategoriasOferta() {
  const sector = document.getElementById('ofSector').value;
  const sel = document.getElementById('ofCategoria');
  const oficioWrap = document.getElementById('ofOficioWrap');
  sel.innerHTML = '<option value="">— Seleccione —</option>';
  if (!sector || !CATEGORIAS) return;
  const cats = sector === 'fabricacion' ? CATEGORIAS.fabricacion : CATEGORIAS.oficina;
  cats.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); });
  if (sector === 'fabricacion') {
    oficioWrap.style.display = 'block';
    const selO = document.getElementById('ofOficio');
    selO.innerHTML = '<option value="">— Cualquier oficio —</option>';
    CATEGORIAS.oficios.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; selO.appendChild(o); });
  } else {
    oficioWrap.style.display = 'none';
  }
}

async function guardarEmpleo() {
  const err = document.getElementById('emError');
  err.style.display = 'none';
  const perfil = await (await fetch(API + '/mi-perfil', { headers: headers() })).json();
  const body = {
    trabajadorId: perfil.id,
    empresa: document.getElementById('emEmpresa').value.trim(),
    cif: document.getElementById('emCif').value.trim(),
    sector: document.getElementById('emSector').value,
    categoria: document.getElementById('emCategoria').value,
    oficio: document.getElementById('emOficio')?.value || null,
    fechaInicio: document.getElementById('emFechaInicio').value,
    fechaFin: document.getElementById('emFechaFin').value,
    enActivo: document.getElementById('emEnActivo').checked,
    tareas: document.getElementById('emTareas').value.trim(),
  };
  if (!body.empresa || !body.sector || !body.categoria) { err.textContent = 'Complete los campos obligatorios'; err.style.display = 'block'; return; }
  const r = await fetch(API + '/empleos', { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) { err.textContent = d.error; err.style.display = 'block'; return; }
  cerrarModal('modalEmpleo');
  loadMisEmpleos();
}

function abrirSubirCertificado(empleoId) {
  currentEmpleoId = empleoId;
  document.getElementById('certFile').value = '';
  document.getElementById('certError').style.display = 'none';
  document.getElementById('modalCertificado').classList.add('open');
}

async function subirCertificado() {
  const err = document.getElementById('certError');
  err.style.display = 'none';
  const file = document.getElementById('certFile').files[0];
  if (!file) { err.textContent = 'Seleccione un archivo'; err.style.display = 'block'; return; }
  if (file.size > 2 * 1024 * 1024) { err.textContent = 'El archivo no puede superar 2 MB'; err.style.display = 'block'; return; }
  const reader = new FileReader();
  reader.onload = async (e) => {
    const b64 = e.target.result.split(',')[1];
    const r = await fetch(API + \`/empleos/\${currentEmpleoId}/certificado\`, { method: 'POST', headers: headers(), body: JSON.stringify({ fileBase64: b64, fileName: file.name }) });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error; err.style.display = 'block'; return; }
    cerrarModal('modalCertificado');
    loadMisEmpleos();
  };
  reader.readAsDataURL(file);
}

// ── Ofertas públicas ───────────────────────────────────────
async function loadOfertasPublicas() {
  const div = document.getElementById('ofertasPublicasContent');
  const r = await fetch(API + '/ofertas/publicas');
  const lista = await r.json();
  if (!lista.length) { div.innerHTML = '<div class="alert alert-info">No hay ofertas públicas en este momento.</div>'; return; }
  div.innerHTML = lista.map(o => \`
    <div class="oferta-card">
      <div class="oferta-titulo">\${o.titulo}</div>
      \${o.nombreEmpresa ? \`<div style="font-size:13px;font-weight:600;color:var(--primary);margin-bottom:4px">🏭 \${o.nombreEmpresa}</div>\` : ''}
      <div class="oferta-meta">
        <span>📁 \${o.sector === 'fabricacion' ? 'Fabricación' : 'Oficina/Logística'}</span>
        <span>🏷 \${o.categoria}</span>
        \${o.oficio ? \`<span>🔧 \${o.oficio}</span>\` : ''}
        <span>📅 \${fmtDate(o.createdAt)}</span>
      </div>
      \${o.descripcion ? \`<p style="font-size:13px;color:var(--text-secondary);margin-top:8px">\${o.descripcion}</p>\` : ''}
    </div>
  \`).join('');
}

// ── Empresa: mis ofertas ───────────────────────────────────
async function loadMisOfertas() {
  const div = document.getElementById('misOfertasContent');
  const r = await fetch(API + '/mis-ofertas', { headers: headers() });
  const lista = await r.json();
  if (!lista.length) { div.innerHTML = '<div class="alert alert-info">No ha publicado ninguna oferta todavía. Use la pestaña "Nueva oferta" para publicar una vacante.</div>'; return; }
  div.innerHTML = lista.map(o => {
    const badge = o.status === 'activa' ? '<span class="badge badge-success">Activa</span>' : o.status === 'pendiente' ? '<span class="badge badge-warning">Pendiente — Asopiel revisando</span>' : '<span class="badge badge-gray">Cerrada</span>';
    const perfilesN = (o.perfilesDesbloqueados||[]).length;
    return \`<div class="oferta-card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div class="oferta-titulo">\${o.titulo}</div>
        \${badge}
      </div>
      <div class="oferta-meta" style="margin-top:8px">
        <span>📁 \${o.sector === 'fabricacion' ? 'Fabricación' : 'Oficina/Logística'}</span>
        <span>🏷 \${o.categoria}</span>
        \${o.oficio ? \`<span>🔧 \${o.oficio}</span>\` : ''}
        <span>📅 \${fmtDate(o.createdAt)}</span>
      </div>
      \${o.descripcion ? \`<p style="font-size:13px;color:var(--text-secondary);margin-top:8px">\${o.descripcion}</p>\` : ''}
      \${perfilesN > 0 ? \`<div class="alert alert-info" style="margin-top:12px">👥 Asopiel le ha asignado \${perfilesN} perfil\${perfilesN>1?'es':''} para esta oferta. <button class="btn btn-primary btn-sm" onclick="verPerfilesOferta('\${o.id}')">Ver perfiles</button></div>\` : ''}
    </div>\`;
  }).join('');
}

async function verPerfilesOferta(ofertaId) {
  const r = await fetch(API + \`/ofertas/\${ofertaId}/perfiles\`, { headers: headers() });
  const perfiles = await r.json();
  const body = document.getElementById('modalPerfilBody');
  if (!perfiles.length) { body.innerHTML = '<div class="alert alert-info">No hay perfiles asignados todavía.</div>'; }
  else {
    body.innerHTML = perfiles.map(t => \`
      <div class="perfil-card">
        <div class="perfil-header">
          <div class="perfil-avatar">\${t.nombre.charAt(0)}</div>
          <div>
            <div class="perfil-nombre">\${t.nombre} \${t.apellidos}</div>
            <div class="perfil-sub">\${t.direccion ? t.direccion+', ' : ''}\${t.localidad||''} · <a href="tel:\${t.telefono}">\${t.telefono||''}</a> · <a href="mailto:\${t.email}">\${t.email}</a></div>
          </div>
        </div>
        \${(t.empleos||[]).map(e => \`
          <div class="empleo-card">
            <div class="empleo-empresa">\${e.empresa}</div>
            <div class="empleo-periodo">\${e.fechaInicio||'—'} → \${e.enActivo?'Actualidad':(e.fechaFin||'—')}</div>
            <div class="empleo-badges">
              <span class="badge badge-accent">\${e.sector==='fabricacion'?'Fabricación':'Oficina'}</span>
              <span class="badge badge-gray">\${e.categoria}</span>
              \${e.oficio?\`<span class="badge badge-gray">\${e.oficio}</span>\`:''}
              \${e.certificadoValidado?'<span class="badge badge-success">✓ Certificado validado</span>':''}
            </div>
          </div>
        \`).join('')}
      </div>
    \`).join('');
  }
  document.getElementById('modalPerfil').classList.add('open');
}

// ── Empresa: nueva oferta ──────────────────────────────────
async function publicarOferta() {
  const err = document.getElementById('ofError'), ok = document.getElementById('ofOk');
  err.style.display = 'none'; ok.style.display = 'none';
  const body = { titulo: document.getElementById('ofTitulo').value.trim(), descripcion: document.getElementById('ofDescripcion').value.trim(), sector: document.getElementById('ofSector').value, categoria: document.getElementById('ofCategoria').value, oficio: document.getElementById('ofOficio')?.value || null, publica: document.getElementById('ofPublica').checked };
  if (!body.titulo || !body.sector || !body.categoria) { err.textContent = 'Complete los campos obligatorios'; err.style.display = 'block'; return; }
  const r = await fetch(API + '/ofertas', { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) { err.textContent = d.error; err.style.display = 'block'; return; }
  ok.textContent = 'Oferta enviada. Asopiel la revisará y le asignará candidatos en breve.'; ok.style.display = 'block';
  document.getElementById('ofTitulo').value = '';
  document.getElementById('ofDescripcion').value = '';
  loadMisOfertas();
}

// ── Utils ──────────────────────────────────────────────────
function cerrarModal(id) { document.getElementById(id).classList.remove('open'); }
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch { return iso; }
}
document.querySelectorAll('.modal-overlay').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); }));
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open')); });

// ── Legal ──────────────────────────────────────────────────
const LEGAL_TEXTS = {
  privacidad: {
    titulo: 'Política de Privacidad',
    html: \`
<h4 style="color:var(--text);margin-bottom:8px">1. Responsable del tratamiento</h4>
<p><strong>Asopiel — Asociación de Empresarios del Sector de la Piel de Ubrique</strong><br>
Dirección: Ubrique, Cádiz (España)<br>
Email de contacto: <a href="mailto:oficina@asopiel.com">oficina@asopiel.com</a></p>
<h4 style="color:var(--text);margin:16px 0 8px">2. Datos que recogemos</h4>
<p><strong>Trabajadores:</strong> nombre, apellidos, DNI/NIE, teléfono, email, dirección, localidad, historial laboral y certificados de empresa.</p>
<p><strong>Empresas:</strong> nombre, CIF, persona de contacto, teléfono y email.</p>
<h4 style="color:var(--text);margin:16px 0 8px">3. Finalidad y base jurídica</h4>
<p>Los datos se tratan para la gestión de la bolsa de empleo sectorial (ejecución de una relación precontractual o contractual, art. 6.1.b RGPD) y para el envío de comunicaciones relacionadas con el servicio (interés legítimo, art. 6.1.f RGPD).</p>
<h4 style="color:var(--text);margin:16px 0 8px">4. Conservación</h4>
<p>Los datos se conservan mientras la cuenta esté activa. Puede solicitar la cancelación en cualquier momento contactando con Asopiel. Tras la baja se conservarán bloqueados durante los plazos legales aplicables (máximo 5 años).</p>
<h4 style="color:var(--text);margin:16px 0 8px">5. Destinatarios</h4>
<p>Sus datos no se ceden a terceros salvo obligación legal. Las empresas usuarias del portal sólo acceden a los perfiles que Asopiel les habilita expresamente.</p>
<h4 style="color:var(--text);margin:16px 0 8px">6. Transferencias internacionales</h4>
<p>Los datos se almacenan en infraestructura de Cloudflare Inc. (EE.UU.), que ofrece garantías adecuadas mediante cláusulas contractuales tipo de la Comisión Europea.</p>
<h4 style="color:var(--text);margin:16px 0 8px">7. Sus derechos</h4>
<p>Puede ejercer los derechos de acceso, rectificación, supresión, oposición, limitación y portabilidad dirigiéndose a <a href="mailto:oficina@asopiel.com">oficina@asopiel.com</a>. Si considera que el tratamiento no se ajusta a la normativa puede presentar reclamación ante la <a href="https://www.aepd.es" target="_blank">Agencia Española de Protección de Datos (AEPD)</a>.</p>
<h4 style="color:var(--text);margin:16px 0 8px">8. Seguridad</h4>
<p>Las contraseñas se almacenan cifradas mediante SHA-256. Las comunicaciones se realizan a través de HTTPS. Los certificados de empresa se guardan cifrados en nuestra base de datos.</p>
\`
  },
  cookies: {
    titulo: 'Política de Cookies',
    html: \`
<h4 style="color:var(--text);margin-bottom:8px">¿Qué son las cookies?</h4>
<p>Las cookies son pequeños archivos de texto que se almacenan en su navegador cuando visita un sitio web.</p>
<h4 style="color:var(--text);margin:16px 0 8px">Cookies que utilizamos</h4>
<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:8px">
  <thead><tr style="background:var(--bg)"><th style="padding:8px;text-align:left;border-bottom:2px solid var(--border)">Cookie</th><th style="padding:8px;text-align:left;border-bottom:2px solid var(--border)">Tipo</th><th style="padding:8px;text-align:left;border-bottom:2px solid var(--border)">Finalidad</th><th style="padding:8px;text-align:left;border-bottom:2px solid var(--border)">Duración</th></tr></thead>
  <tbody>
    <tr><td style="padding:8px;border-bottom:1px solid var(--border)">portalToken (sessionStorage)</td><td style="padding:8px;border-bottom:1px solid var(--border)">Técnica / Sesión</td><td style="padding:8px;border-bottom:1px solid var(--border)">Mantener la sesión iniciada</td><td style="padding:8px;border-bottom:1px solid var(--border)">Hasta cerrar el navegador</td></tr>
    <tr><td style="padding:8px;border-bottom:1px solid var(--border)">cookieConsent (localStorage)</td><td style="padding:8px;border-bottom:1px solid var(--border)">Técnica</td><td style="padding:8px;border-bottom:1px solid var(--border)">Recordar su elección sobre cookies</td><td style="padding:8px;border-bottom:1px solid var(--border)">1 año</td></tr>
  </tbody>
</table>
<h4 style="color:var(--text);margin:16px 0 8px">No utilizamos</h4>
<p>Este portal <strong>no utiliza</strong> cookies publicitarias, de seguimiento, ni de análisis de terceros (Google Analytics, Facebook Pixel, etc.).</p>
<h4 style="color:var(--text);margin:16px 0 8px">Cómo gestionar las cookies</h4>
<p>Puede configurar su navegador para bloquear o eliminar cookies. Tenga en cuenta que bloquear las cookies técnicas puede impedir el funcionamiento del portal. Consulte la ayuda de su navegador: <a href="https://support.google.com/chrome/answer/95647" target="_blank">Chrome</a> · <a href="https://support.mozilla.org/es/kb/habilitar-y-deshabilitar-cookies" target="_blank">Firefox</a> · <a href="https://support.apple.com/es-es/HT201265" target="_blank">Safari</a>.</p>
\`
  },
  terminos: {
    titulo: 'Términos de Uso',
    html: \`
<h4 style="color:var(--text);margin-bottom:8px">1. Objeto y titularidad</h4>
<p>El presente portal de empleo es un servicio gestionado por <strong>Asopiel — Asociación de Empresarios del Sector de la Piel de Ubrique</strong> con el objetivo de facilitar la intermediación laboral en el sector de la marroquinería de Ubrique.</p>
<h4 style="color:var(--text);margin:16px 0 8px">2. Acceso y registro</h4>
<p>El acceso requiere registro previo y aprobación por parte de Asopiel. Se reserva el derecho de denegar o revocar el acceso a cualquier usuario que incumpla estos términos.</p>
<h4 style="color:var(--text);margin:16px 0 8px">3. Obligaciones de los usuarios</h4>
<p><strong>Trabajadores:</strong> Se comprometen a facilitar datos verídicos y actualizados, y a aportar certificados de empresa auténticos. La falsificación de documentos o datos podrá dar lugar a la baja inmediata del portal y a las acciones legales que procedan.</p>
<p><strong>Empresas:</strong> Se comprometen a publicar ofertas reales y conformes a la legalidad laboral vigente (Convenio Colectivo del Sector de la Marroquinería), y a tratar los datos de los candidatos conforme al RGPD.</p>
<h4 style="color:var(--text);margin:16px 0 8px">4. Responsabilidad</h4>
<p>Asopiel actúa como intermediario y no garantiza la contratación efectiva ni es responsable de las relaciones laborales que se establezcan entre empresas y trabajadores a través del portal.</p>
<h4 style="color:var(--text);margin:16px 0 8px">5. Propiedad intelectual</h4>
<p>El diseño, código y contenidos del portal son propiedad de Asopiel. Queda prohibida su reproducción o uso sin autorización expresa.</p>
<h4 style="color:var(--text);margin:16px 0 8px">6. Legislación aplicable</h4>
<p>Estos términos se rigen por la legislación española. Para cualquier controversia, las partes se someten a los Juzgados y Tribunales de Jerez de la Frontera (Cádiz).</p>
<h4 style="color:var(--text);margin:16px 0 8px">7. Modificaciones</h4>
<p>Asopiel podrá modificar estos términos notificándolo a los usuarios registrados con al menos 15 días de antelación.</p>
<p style="margin-top:16px;font-size:12px;color:var(--text-muted)"><em>Última actualización: octubre de 2026</em></p>
\`
  }
};

function abrirLegal(tipo) {
  const t = LEGAL_TEXTS[tipo];
  if (!t) return;
  document.getElementById('modalLegalTitulo').textContent = t.titulo;
  document.getElementById('modalLegalBody').innerHTML = t.html;
  document.getElementById('modalLegal').classList.add('open');
  return false;
}

function initLegal() {
  try {
    const consent = localStorage.getItem('cookieConsent');
    if (!consent) document.getElementById('cookieBanner').style.display = 'block';
  } catch(e) { document.getElementById('cookieBanner').style.display = 'block'; }
}

function aceptarCookies() {
  try { localStorage.setItem('cookieConsent', 'accepted'); } catch(e) {}
  document.getElementById('cookieBanner').style.display = 'none';
}

function rechazarCookies() {
  try { localStorage.setItem('cookieConsent', 'minimal'); } catch(e) {}
  document.getElementById('cookieBanner').style.display = 'none';
}

init();
initLegal();
</script>

<!-- ── BANNER COOKIES ──────────────────────────────────── -->
<div id="cookieBanner" style="display:none;position:fixed;bottom:0;left:0;right:0;background:#1B2B3A;color:#fff;padding:16px 24px;z-index:999;box-shadow:0 -4px 16px rgba(0,0,0,.2)">
  <div style="max-width:1200px;margin:0 auto;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
    <p style="flex:1;font-size:13px;margin:0">Este portal utiliza cookies técnicas necesarias para su funcionamiento y cookies de sesión para la autenticación. No utilizamos cookies publicitarias ni de seguimiento. <a href="#" onclick="abrirLegal('cookies')" style="color:#8BBFFF">Más información</a>.</p>
    <div style="display:flex;gap:8px">
      <button onclick="rechazarCookies()" style="background:transparent;border:1px solid rgba(255,255,255,.4);color:#fff;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px;font-family:inherit">Solo necesarias</button>
      <button onclick="aceptarCookies()" style="background:#1B4F8A;border:none;color:#fff;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px;font-family:inherit">Aceptar</button>
    </div>
  </div>
</div>

<!-- ── MODAL LEGAL ─────────────────────────────────────── -->
<div id="modalLegal" class="modal-overlay">
  <div class="modal" style="max-width:720px">
    <div class="modal-header">
      <h3 id="modalLegalTitulo">Política de Privacidad</h3>
      <button class="modal-close" onclick="cerrarModal('modalLegal')">✕</button>
    </div>
    <div class="modal-body" id="modalLegalBody" style="font-size:14px;line-height:1.7;color:var(--text-secondary)"></div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="cerrarModal('modalLegal')">Cerrar</button></div>
  </div>
</div>

<footer style="margin-top:40px;padding:20px 0;text-align:center;font-size:12px;color:var(--text-secondary);border-top:1px solid var(--border)">
  <strong>Asociación de Empresarios del Sector de la Piel de Ubrique (ASOPIEL)</strong><br>
  CIF G-72357205 · Avda. de los Callejones, 18, Bl. 1, Pl. 1, Pta. C · 11600 Ubrique (Cádiz)<br>
  <a href="mailto:gerencia@asopiel.com" style="color:var(--primary)">gerencia@asopiel.com</a><br>
  <br>
  <a href="/privacidad" target="_blank" style="color:var(--primary)">Política de privacidad</a> ·
  <a href="/aviso-legal" target="_blank" style="color:var(--primary)">Aviso legal</a> ·
  <a href="#" onclick="abrirLegal('cookies')" style="color:var(--primary)">Cookies</a>
</footer>
</body>
</html>`;

// ============================================================
// POLÍTICA DE PRIVACIDAD
// ============================================================
const PRIVACIDAD_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Política de Privacidad — Portal de Empleo Piel de Ubrique</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:800px;margin:0 auto;padding:40px 20px;color:#1a1a2e;line-height:1.8;font-size:16px}
h1{font-size:24px;font-weight:700;margin-bottom:4px;color:#1a1a2e}
h2{font-size:17px;font-weight:600;margin-top:32px;margin-bottom:8px;color:#1a1a2e}
h3{font-size:15px;font-weight:600;margin-top:20px;margin-bottom:6px;color:#1a1a2e}
p{margin-bottom:14px}
ul{margin:0 0 14px 20px}
li{margin-bottom:6px}
a{color:#5c6bc0;text-decoration:none}
a:hover{text-decoration:underline}
.meta{font-size:13px;color:#666;margin-bottom:32px}
.back{display:inline-block;margin-bottom:28px;font-size:14px;color:#5c6bc0;text-decoration:none}
table{width:100%;border-collapse:collapse;margin-bottom:16px;font-size:14px}
th,td{border:1px solid #ddd;padding:8px 12px;text-align:left;vertical-align:top}
th{background:#f5f5f5;font-weight:600}
</style>
</head>
<body>
<a href="/" class="back">← Volver al Portal de Empleo</a>
<h1>Política de Privacidad</h1>
<p class="meta">Portal de Empleo Sectorial · Piel de Ubrique · Versión 1.0 · Octubre 2026</p>

<h2>1. Responsable del tratamiento</h2>
<table>
<tr><th>Denominación</th><td>Asociación de Empresarios del Sector de la Piel de Ubrique (ASOPIEL)</td></tr>
<tr><th>CIF</th><td>G-72357205</td></tr>
<tr><th>Domicilio</th><td>Avda. de los Callejones, 18, Bloque 1, Planta 1, Puerta C · 11600 Ubrique (Cádiz)</td></tr>
<tr><th>Email</th><td><a href="mailto:gerencia@asopiel.com">gerencia@asopiel.com</a></td></tr>
<tr><th>DPD</th><td>No designado (no obligatorio según art. 37 RGPD para este perfil de actividad)</td></tr>
</table>

<h2>2. Finalidades y base legal del tratamiento</h2>

<h3>A. Trabajadores demandantes de empleo</h3>
<p>Tratamos sus datos para:</p>
<ul>
<li>Gestionar su perfil en la bolsa de empleo sectorial y facilitar la intermediación laboral.</li>
<li>Comunicarle ofertas de empleo del sector marroquinería de Ubrique.</li>
<li>Si lo autoriza expresamente, enviarle información sobre cursos, talleres y seminarios del sector.</li>
<li>Compartir su perfil profesional con empresas del sector asignadas por Asopiel para procesos de selección.</li>
<li>Conservar su vida laboral (documento PDF) y ponerla a disposición de Asopiel y las empresas autorizadas.</li>
</ul>
<p><strong>Base legal:</strong> Art. 6.1.b RGPD (ejecución de relación precontractual o contractual); art. 6.1.a RGPD (consentimiento para comunicaciones de cursos y cesión de datos a empresas).</p>

<h3>B. Empresas</h3>
<p>Tratamos sus datos para:</p>
<ul>
<li>Gestionar su alta y acceso al portal de empleo sectorial.</li>
<li>Facilitarles perfiles de trabajadores en función de sus ofertas de empleo.</li>
<li>Comunicarles novedades, ofertas e información sectorial relacionada con la bolsa de empleo.</li>
</ul>
<p><strong>Base legal:</strong> Art. 6.1.b RGPD (ejecución de relación precontractual o contractual); art. 6.1.a RGPD (consentimiento).</p>

<h2>3. Plazos de conservación</h2>
<ul>
<li><strong>Trabajadores:</strong> mientras el perfil esté activo y hasta 3 años tras la baja voluntaria o cancelación.</li>
<li><strong>Empresas:</strong> mientras el acceso esté activo y hasta 3 años tras la baja.</li>
<li><strong>Documentos (vida laboral):</strong> mismo plazo que el perfil del trabajador.</li>
</ul>

<h2>4. Destinatarios y cesiones</h2>
<ul>
<li><strong>Empresas del sector:</strong> los perfiles de los trabajadores (y su vida laboral, si la han subido) son accesibles para las empresas del portal que Asopiel asigne expresamente a ese trabajador para un proceso de selección. Esta cesión está cubierta por el consentimiento prestado en el registro.</li>
<li><strong>Encargados del tratamiento (art. 28 RGPD):</strong> Cloudflare, Inc. (EE. UU.) como proveedor de infraestructura (Workers, KV, R2). La transferencia internacional está cubierta por el DPA público de Cloudflare y cláusulas contractuales tipo aprobadas por la Comisión Europea.</li>
<li><strong>No se ceden datos a terceros</strong> salvo obligación legal.</li>
</ul>

<h2>5. Derechos de los interesados</h2>
<p>Puede ejercer en cualquier momento los siguientes derechos escribiendo a <a href="mailto:gerencia@asopiel.com">gerencia@asopiel.com</a>:</p>
<ul>
<li><strong>Acceso:</strong> conocer qué datos tratamos sobre usted.</li>
<li><strong>Rectificación:</strong> corregir datos inexactos o incompletos.</li>
<li><strong>Supresión (art. 17 RGPD):</strong> solicitar la eliminación de sus datos cuando ya no sean necesarios para la finalidad con que fueron recabados, o cuando retire el consentimiento.</li>
<li><strong>Oposición:</strong> oponerse al tratamiento en determinadas circunstancias.</li>
<li><strong>Limitación:</strong> solicitar que se restrinja el tratamiento de sus datos.</li>
<li><strong>Portabilidad:</strong> recibir sus datos en formato estructurado y de uso común.</li>
<li><strong>Retirada del consentimiento:</strong> en cualquier momento, sin que afecte a la licitud del tratamiento previo.</li>
</ul>
<p>Si considera que el tratamiento de sus datos no se ajusta a la normativa vigente, puede presentar una reclamación ante la <a href="https://www.aepd.es" target="_blank" rel="noopener">Agencia Española de Protección de Datos (AEPD)</a>.</p>

<h2>6. Medidas de seguridad</h2>
<p>Los datos se almacenan de forma cifrada en la infraestructura de Cloudflare (KV y R2). Las comunicaciones se realizan mediante HTTPS. El acceso al portal está protegido mediante autenticación con contraseña. Los documentos (vida laboral) solo son accesibles mediante un enlace autenticado con token temporal. El alta de empresas y trabajadores requiere validación manual por parte de Asopiel antes de activar el acceso.</p>

<h2>7. Modificaciones de esta política</h2>
<p>Asopiel puede modificar esta política de privacidad para adaptarla a cambios legislativos o del servicio. Le informaremos de los cambios relevantes a través del email asociado a su cuenta.</p>

<p style="margin-top:40px;font-size:13px;color:#999">Portal de Empleo Piel de Ubrique · <a href="/">Volver al inicio</a> · <a href="/aviso-legal">Aviso legal</a></p>
</body>
</html>`;

// ============================================================
// AVISO LEGAL (art. 10 LSSI)
// ============================================================
const AVISO_LEGAL_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aviso Legal — Portal de Empleo Piel de Ubrique</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:800px;margin:0 auto;padding:40px 20px;color:#1a1a2e;line-height:1.8;font-size:16px}
h1{font-size:24px;font-weight:700;margin-bottom:4px;color:#1a1a2e}
h2{font-size:17px;font-weight:600;margin-top:32px;margin-bottom:8px;color:#1a1a2e}
p{margin-bottom:14px}
ul{margin:0 0 14px 20px}
li{margin-bottom:6px}
a{color:#5c6bc0;text-decoration:none}
a:hover{text-decoration:underline}
.meta{font-size:13px;color:#666;margin-bottom:32px}
.back{display:inline-block;margin-bottom:28px;font-size:14px;color:#5c6bc0;text-decoration:none}
table{width:100%;border-collapse:collapse;margin-bottom:16px;font-size:14px}
th,td{border:1px solid #ddd;padding:8px 12px;text-align:left;vertical-align:top}
th{background:#f5f5f5;font-weight:600}
</style>
</head>
<body>
<a href="/" class="back">← Volver al Portal de Empleo</a>
<h1>Aviso Legal</h1>
<p class="meta">En cumplimiento del art. 10 de la Ley 34/2002, de Servicios de la Sociedad de la Información y del Comercio Electrónico (LSSI)</p>

<h2>1. Datos identificativos del titular</h2>
<table>
<tr><th>Denominación</th><td>Asociación de Empresarios del Sector de la Piel de Ubrique (ASOPIEL)</td></tr>
<tr><th>CIF</th><td>G-72357205</td></tr>
<tr><th>Domicilio</th><td>Avda. de los Callejones, 18, Bloque 1, Planta 1, Puerta C · 11600 Ubrique (Cádiz)</td></tr>
<tr><th>Email de contacto</th><td><a href="mailto:gerencia@asopiel.com">gerencia@asopiel.com</a></td></tr>
<tr><th>Naturaleza jurídica</th><td>Asociación sin ánimo de lucro inscrita en el Registro de Asociaciones de Andalucía</td></tr>
</table>

<h2>2. Objeto y ámbito de aplicación</h2>
<p>El presente aviso legal regula el uso del <strong>Portal de Empleo Sectorial Piel de Ubrique</strong>, titularidad de Asopiel, cuyo acceso se realiza a través de Internet. El portal tiene como finalidad facilitar la intermediación laboral entre demandantes de empleo y empresas del sector de la marroquinería de Ubrique.</p>
<p>El acceso al portal y el uso de sus servicios implica la aceptación plena de este aviso legal. Si no está de acuerdo con alguno de sus términos, deberá abstenerse de utilizar el portal.</p>

<h2>3. Condiciones de uso</h2>
<p>El portal es de acceso privado. Para utilizar sus servicios es necesario registrarse y obtener la validación de Asopiel. El usuario se compromete a:</p>
<ul>
<li>Facilitar datos verídicos y actualizados en el proceso de registro.</li>
<li>No utilizar el portal para fines ilícitos o contrarios a estos términos.</li>
<li>No realizar acciones que puedan dañar, bloquear o sobrecargar el portal.</li>
<li>No suplantar la identidad de otros usuarios ni de terceros.</li>
</ul>

<h2>4. Propiedad intelectual e industrial</h2>
<p>El código fuente, diseño, textos y elementos del portal son propiedad de Asopiel o de sus colaboradores, y están protegidos por la legislación vigente en materia de propiedad intelectual e industrial. Queda prohibida su reproducción, distribución o modificación sin autorización expresa.</p>
<p>La denominación <strong>«Piel de Ubrique»</strong> es una Indicación Geográfica Protegida (IGP) regulada por el Reglamento de Ejecución (UE) 2023/2411. Su uso en este portal se limita a la identificación del sector geográfico al que sirve la bolsa de empleo.</p>

<h2>5. Exclusión de responsabilidad</h2>
<p>Asopiel no se responsabiliza de los daños que puedan derivarse del uso del portal, de interrupciones del servicio, ni de la veracidad de los datos aportados por los usuarios. La intermediación laboral realizada a través del portal no genera relación laboral entre Asopiel y los usuarios, ni garantiza la contratación.</p>

<h2>6. Modificaciones</h2>
<p>Asopiel se reserva el derecho de modificar este aviso legal, la política de privacidad y las condiciones de uso del portal en cualquier momento.</p>

<h2>7. Legislación aplicable y jurisdicción</h2>
<p>Este aviso legal se rige por la legislación española. Para la resolución de cualquier controversia, las partes se someten, con renuncia a cualquier otro fuero, a los Juzgados y Tribunales de Cádiz.</p>

<p style="margin-top:40px;font-size:13px;color:#999">Portal de Empleo Piel de Ubrique · <a href="/">Volver al inicio</a> · <a href="/privacidad">Política de privacidad</a></p>
</body>
</html>`;
