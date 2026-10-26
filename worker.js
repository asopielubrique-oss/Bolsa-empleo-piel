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
      <div class="emblem">👜</div>
      <h1>Portal de Empleo</h1>
      <p>Piel de Ubrique · Asopiel</p>
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
  if (ROL === 'admin') { loadMetricas(); loadPendientes(); loadTrabajadoresAdmin(); loadEmpresasAdmin(); loadOfertasAdmin(); }
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
  const panels = ['metricas','pendientes','trabajadores','empresas','ofertas'];
  panels.forEach(p => { document.getElementById('tab' + cap(p)).classList.toggle('active', p === name); });
  document.querySelectorAll('#adminTabs .tab').forEach((t, i) => t.classList.toggle('active', panels[i] === name));
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
    <div style="margin-top:16px;color:var(--text-muted);font-size:13px">Para ver el historial completo de empleos, el trabajador debe haber iniciado sesión y añadido sus empleos.</div>
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
  \`;
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

</body>
</html>`;
