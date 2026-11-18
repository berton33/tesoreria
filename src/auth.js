import crypto from 'node:crypto';
import { db, ahoraISO } from './db.js';
import { ErrorUsuario } from './logic.js';

const DURACION_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE = 'sid';

export function hashear(clave) {
  const sal = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(clave), sal, 64);
  return `scrypt$${sal.toString('hex')}$${h.toString('hex')}`;
}

function verificar(clave, guardado) {
  const [alg, salHex, hHex] = String(guardado).split('$');
  if (alg !== 'scrypt') return false;
  const h = crypto.scryptSync(String(clave), Buffer.from(salHex, 'hex'), 64);
  const esperado = Buffer.from(hHex, 'hex');
  return h.length === esperado.length && crypto.timingSafeEqual(h, esperado);
}

export function validarClave(clave) {
  if (typeof clave !== 'string' || clave.length < 10)
    throw new ErrorUsuario('La contraseña debe tener al menos 10 caracteres');
}

export function crearUsuario({ email, nombre, rol, clave }) {
  email = String(email || '').trim().toLowerCase();
  nombre = String(nombre || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new ErrorUsuario('Mail inválido');
  if (!nombre) throw new ErrorUsuario('Falta el nombre');
  if (!['admin', 'lectura'].includes(rol)) throw new ErrorUsuario('Rol inválido');
  validarClave(clave);
  if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email))
    throw new ErrorUsuario('Ya existe un usuario con ese mail', 409);
  db.prepare('INSERT INTO usuarios (email, nombre, rol, hash, creado_en) VALUES (?, ?, ?, ?, ?)').run(
    email,
    nombre,
    rol,
    hashear(clave),
    ahoraISO()
  );
}

/** Crea el primer administrador a partir de variables de entorno, si no hay usuarios. */
export function asegurarAdmin() {
  if (db.prepare('SELECT COUNT(*) n FROM usuarios').get().n > 0) return;
  const email = process.env.ADMIN_EMAIL;
  const clave = process.env.ADMIN_PASSWORD;
  if (!email || !clave) {
    console.warn('[auth] No hay usuarios. Definí ADMIN_EMAIL y ADMIN_PASSWORD y reiniciá para crear el administrador.');
    return;
  }
  crearUsuario({ email, nombre: process.env.ADMIN_NOMBRE || 'Tesorero', rol: 'admin', clave });
  console.log(`[auth] Administrador creado: ${email}`);
}

// Límite simple de intentos de ingreso por IP.
const intentos = new Map();
function chequearIntentos(ip) {
  const ahora = Date.now();
  const reg = intentos.get(ip);
  if (reg && ahora - reg.desde < 15 * 60 * 1000) {
    if (reg.n >= 10) throw new ErrorUsuario('Demasiados intentos. Probá de nuevo en 15 minutos.', 429);
    reg.n++;
  } else intentos.set(ip, { desde: ahora, n: 1 });
}

export function ingresar(email, clave, ip) {
  chequearIntentos(ip);
  const u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(String(email || '').trim().toLowerCase());
  if (!u || !verificar(clave, u.hash)) throw new ErrorUsuario('Mail o contraseña incorrectos', 401);
  intentos.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sesiones (token, usuario_id, expira) VALUES (?, ?, ?)').run(token, u.id, Date.now() + DURACION_MS);
  db.prepare('DELETE FROM sesiones WHERE expira < ?').run(Date.now());
  return token;
}

export function cambiarClave(usuarioId, actual, nueva) {
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(usuarioId);
  if (!u || !verificar(actual, u.hash)) throw new ErrorUsuario('La contraseña actual no es correcta', 401);
  validarClave(nueva);
  db.prepare('UPDATE usuarios SET hash = ? WHERE id = ?').run(hashear(nueva), usuarioId);
}

function leerCookie(req) {
  const c = req.headers.cookie || '';
  const m = c.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`));
  return m ? m[1] : null;
}

export function ponerCookie(req, res, token) {
  const seguro = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${token ? DURACION_MS / 1000 : 0}${seguro ? '; Secure' : ''}`
  );
}

export function cerrarSesion(req) {
  const t = leerCookie(req);
  if (t) db.prepare('DELETE FROM sesiones WHERE token = ?').run(t);
}

export function usuarioDe(req) {
  const t = leerCookie(req);
  if (!t) return null;
  const u = db
    .prepare(
      `SELECT u.id, u.email, u.nombre, u.rol FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
       WHERE s.token = ? AND s.expira > ?`
    )
    .get(t, Date.now());
  return u || null;
}

export function requiereSesion(req, res, next) {
  const u = usuarioDe(req);
  if (!u) return res.status(401).json({ error: 'Sesión vencida. Ingresá de nuevo.' });
  req.usuario = u;
  next();
}

export function requiereAdmin(req, res, next) {
  if (req.usuario?.rol !== 'admin') return res.status(403).json({ error: 'Tu usuario es de solo lectura.' });
  next();
}
