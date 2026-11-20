import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, DATA_DIR, getConfig, setConfig, hoy } from './db.js';
import * as L from './logic.js';
import * as A from './auth.js';
import { importarResumen, analizarResumen } from './importar.js';
import { enviar, mailConfigurado } from './mail.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'"
  );
  next();
});
app.use(express.json({ limit: '2mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------- Sesión ----------
app.post('/api/login', (req, res) => {
  const token = A.ingresar(req.body?.email, req.body?.clave, req.ip);
  A.ponerCookie(req, res, token);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  A.cerrarSesion(req);
  A.ponerCookie(req, res, '');
  res.json({ ok: true });
});

const api = express.Router();
app.use('/api', api);
api.use((req, res, next) => {
  if (req.method !== 'GET' && !req.is('application/json') && req.method !== 'DELETE' && req.path !== '/restaurar')
    return res.status(415).json({ error: 'Formato no admitido' });
  next();
});
api.use(A.requiereSesion);
const admin = A.requiereAdmin;

api.get('/yo', (req, res) => res.json({ usuario: req.usuario, mail: mailConfigurado(), hoy: hoy() }));
api.post('/yo/clave', (req, res) => {
  A.cambiarClave(req.usuario.id, req.body?.actual, req.body?.nueva);
  res.json({ ok: true });
});

// ---------- Resumen y configuración ----------
api.get('/resumen', (req, res) => res.json(L.resumen()));

const CLAVES_CONFIG = [
  'nombre_logia',
  'venerable',
  'venerable_email',
  'tesorero',
  'dia_devengo',
  'devengo_auto',
  'mail_devengo',
  'umbral_art201',
  'umbral_informe',
  'plantilla_aviso',
];
api.get('/config', (req, res) => {
  const c = getConfig();
  delete c.ultimo_devengo_auto;
  res.json(c);
});
api.get('/config/cambio-cuota', admin, (req, res) =>
  res.json(L.previsualizarCambioCuota(L.aCentavos(String(req.query.valor || ''))))
);
api.put('/config', admin, (req, res) => {
  const b = req.body || {};
  for (const k of CLAVES_CONFIG) {
    if (!(k in b)) continue;
    let v = String(b[k]).trim();
    if (k === 'dia_devengo') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 28) throw new L.ErrorUsuario('El día de devengamiento debe estar entre 1 y 28');
    }
    if (k === 'umbral_art201' || k === 'umbral_informe') {
      if (!(Number(v) > 0)) throw new L.ErrorUsuario('Los umbrales deben ser mayores a 0');
    }
    if (k === 'devengo_auto' || k === 'mail_devengo') v = v === '1' || v === 'true' ? '1' : '0';
    setConfig(k, v);
  }
  if ('cuota_base' in b) {
    const c = L.aCentavos(b.cuota_base);
    if (!(c > 0)) throw new L.ErrorUsuario('Valor de cuota inválido');
    L.cambiarCuota(c, req.usuario.nombre);
  }
  res.json(getConfig());
});

// ---------- Categorías ----------
api.get('/categorias', (req, res) =>
  res.json(
    db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM miembros WHERE categoria_id = c.id) AS miembros
         FROM categorias c ORDER BY c.porcentaje DESC, c.nombre`
      )
      .all()
  )
);
function datosCategoria(b) {
  const nombre = String(b?.nombre || '').trim();
  const porcentaje = Number(String(b?.porcentaje ?? '').replace(',', '.'));
  if (!nombre) throw new L.ErrorUsuario('Falta el nombre de la categoría');
  if (!(porcentaje >= 0 && porcentaje <= 1000)) throw new L.ErrorUsuario('Porcentaje inválido');
  return { nombre, porcentaje };
}
api.post('/categorias', admin, (req, res) => {
  const d = datosCategoria(req.body);
  if (db.prepare('SELECT 1 FROM categorias WHERE nombre = ?').get(d.nombre))
    throw new L.ErrorUsuario('Ya existe esa categoría', 409);
  db.prepare('INSERT INTO categorias (nombre, porcentaje) VALUES (?, ?)').run(d.nombre, d.porcentaje);
  res.json({ ok: true });
});
api.put('/categorias/:id', admin, (req, res) => {
  const d = datosCategoria(req.body);
  const otra = db.prepare('SELECT 1 FROM categorias WHERE nombre = ? AND id != ?').get(d.nombre, Number(req.params.id));
  if (otra) throw new L.ErrorUsuario('Ya existe esa categoría', 409);
  db.prepare('UPDATE categorias SET nombre = ?, porcentaje = ? WHERE id = ?').run(d.nombre, d.porcentaje, Number(req.params.id));
  res.json({ ok: true });
});
api.delete('/categorias/:id', admin, (req, res) => {
  const id = Number(req.params.id);
  if (db.prepare('SELECT 1 FROM miembros WHERE categoria_id = ?').get(id))
    throw new L.ErrorUsuario('Hay miembros en esa categoría');
  db.prepare('DELETE FROM categorias WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------- Miembros ----------
api.get('/miembros', (req, res) => res.json(L.listarMiembros()));
api.post('/miembros', admin, (req, res) => res.json(L.crearMiembro(req.body || {})));
api.get('/miembros/:id', (req, res) => {
  const m = L.obtenerMiembro(Number(req.params.id));
  const movs = L.listarMovimientos({ miembro_id: m.id, anulados: true, limite: 5000 }).filas;
  res.json({ miembro: m, movimientos: movs, aviso: L.textoAviso(m) });
});
api.put('/miembros/:id', admin, (req, res) => res.json(L.editarMiembro(Number(req.params.id), req.body || {})));
api.post('/miembros/:id/estado', admin, (req, res) => {
  const estado = req.body?.estado;
  if (!['activo', 'baja'].includes(estado)) throw new L.ErrorUsuario('Estado inválido');
  res.json(L.cambiarEstado(Number(req.params.id), estado));
});
api.post('/miembros/:id/fusionar', admin, (req, res) =>
  res.json(L.fusionarMiembros(Number(req.params.id), Number(req.body?.destino_id)))
);
api.delete('/miembros/:id', admin, (req, res) => {
  L.eliminarMiembro(Number(req.params.id));
  res.json({ ok: true });
});
api.post('/miembros/:id/aviso-mail', admin, async (req, res) => {
  const m = L.obtenerMiembro(Number(req.params.id));
  if (!mailConfigurado()) throw new L.ErrorUsuario('El envío de mails no está configurado (variables SMTP_*)');
  if (!m.email) throw new L.ErrorUsuario('El miembro no tiene mail cargado');
  const cfg = getConfig();
  const ok = await enviar(m.email, `Tesorería ${cfg.nombre_logia} - Estado de cuenta`, L.textoAviso(m, cfg));
  if (!ok) throw new L.ErrorUsuario('No se pudo enviar el mail. Revisá la configuración SMTP.', 502);
  res.json({ ok: true });
});

// ---------- Movimientos ----------
api.get('/movimientos', (req, res) => res.json(L.listarMovimientos(req.query)));
api.post('/movimientos', admin, (req, res) => {
  const b = req.body || {};
  if (b.tipo === 'devengo') throw new L.ErrorUsuario('Los devengamientos se generan desde "Devengar cuotas"');
  if (L.TIPOS[b.tipo]?.sistema) throw new L.ErrorUsuario('Ese movimiento lo genera el sistema');
  res.json(L.crearMovimiento(b, req.usuario.nombre));
});
api.post('/movimientos/:id/anular', admin, (req, res) => {
  L.anularMovimiento(Number(req.params.id), req.body?.motivo, req.usuario.nombre);
  res.json({ ok: true });
});

function csvCampo(v) {
  const s = String(v ?? '');
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
api.get('/exportar/movimientos.csv', (req, res) => {
  const { filas } = L.listarMovimientos({ ...req.query, anulados: true, limite: 5000 });
  const pesos = (c) => (c / 100).toFixed(2);
  const lineas = [
    ['id', 'fecha', 'tipo', 'miembro', 'concepto', 'periodo', 'caja', 'saco', 'cuenta_miembro', 'anulado', 'usuario'].join(','),
    ...filas.map((f) =>
      [f.id, f.fecha, f.tipo, f.miembro, f.concepto, f.periodo, pesos(f.efecto_caja), pesos(f.efecto_saco), pesos(f.efecto_miembro), f.anulado ? 'SI' : '', f.usuario]
        .map(csvCampo)
        .join(',')
    ),
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="movimientos_${hoy()}.csv"`);
  res.send('﻿' + lineas.join('\r\n'));
});

// ---------- Devengamiento e informe ----------
async function avisarDevengo(hechos) {
  const cfg = getConfig();
  if (cfg.mail_devengo !== '1' || !mailConfigurado()) return;
  for (const m of hechos) {
    if (m.email)
      await enviar(m.email, `Tesorería ${cfg.nombre_logia} - Devengamiento de cuota mensual`, L.textoAviso(m, cfg));
  }
}
api.post('/devengar', admin, (req, res) => {
  const hechos = L.devengar(req.body?.periodo, req.usuario.nombre);
  avisarDevengo(hechos).catch((e) => console.error('[mail]', e));
  res.json({ devengados: hechos.length, total: hechos.reduce((s, m) => s + m.cuota, 0) });
});
api.get('/informe', (req, res) => res.json(L.informe(String(req.query.periodo || ''))));

// ---------- Importación y respaldo ----------
api.post('/importar/analizar', admin, (req, res) => {
  const a = analizarResumen(String(req.body?.csv || ''));
  res.json({
    miembros: a.miembros.length,
    activos: a.miembros.filter((m) => m.estado === 'activo').length,
    bajas: a.miembros.filter((m) => m.estado === 'baja').length,
    caja: a.caja,
    saco: a.saco,
    cuota_base: a.cuotaBase,
    deuda_planilla: a.deudaPlanilla,
    deuda_importada: a.miembros.reduce((s, m) => s + (m.saldo < 0 ? -m.saldo : 0), 0),
    duplicados: a.duplicados,
  });
});
api.post('/importar', admin, (req, res) => res.json(importarResumen(String(req.body?.csv || ''), req.usuario.nombre)));

// Restaura padrón, categorías, movimientos y configuración desde un respaldo (.db).
// Solo con el sistema vacío; los usuarios no se copian.
api.post('/restaurar', admin, express.raw({ type: 'application/octet-stream', limit: '100mb' }), (req, res) => {
  if (db.prepare('SELECT COUNT(*) n FROM miembros').get().n > 0)
    throw new L.ErrorUsuario('La restauración solo se puede hacer con el sistema vacío (sin miembros cargados).', 409);
  const datos = req.body;
  if (!Buffer.isBuffer(datos) || datos.length < 100 || datos.subarray(0, 15).toString('latin1') !== 'SQLite format 3')
    throw new L.ErrorUsuario('El archivo no es un respaldo válido');
  const tmp = path.join(DATA_DIR, `restaurar_${Date.now()}.db`);
  fs.writeFileSync(tmp, datos);
  let adjunta = false;
  try {
    db.exec(`ATTACH DATABASE '${tmp.replace(/'/g, "''")}' AS r`);
    adjunta = true;
    const tablas = db.prepare("SELECT name FROM r.sqlite_master WHERE type = 'table'").all().map((t) => t.name);
    for (const t of ['config', 'categorias', 'miembros', 'movimientos'])
      if (!tablas.includes(t)) throw new L.ErrorUsuario('El archivo no es un respaldo de este sistema');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        DELETE FROM movimientos; DELETE FROM miembros; DELETE FROM categorias;
        INSERT INTO categorias (id, nombre, porcentaje) SELECT id, nombre, porcentaje FROM r.categorias;
        INSERT INTO miembros (id, nombre, apellido, telefono, email, categoria_id, estado, notas, creado_en)
          SELECT id, nombre, apellido, telefono, email, categoria_id, estado, notas, creado_en FROM r.miembros;
        INSERT INTO movimientos (id, fecha, tipo, miembro_id, concepto, periodo, efecto_caja, efecto_saco, efecto_miembro, anulado, anulado_motivo, usuario, creado_en)
          SELECT id, fecha, tipo, miembro_id, concepto, periodo, efecto_caja, efecto_saco, efecto_miembro, anulado, anulado_motivo, usuario, creado_en FROM r.movimientos;
        INSERT INTO config (clave, valor) SELECT clave, valor FROM r.config WHERE true
          ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor;
      `);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    if (adjunta) db.exec('DETACH DATABASE r');
    fs.rmSync(tmp, { force: true });
  }
  const r = L.resumen();
  res.json({ miembros: r.capitantes + r.bajas, caja: r.caja, deuda: r.deuda });
});

api.get('/respaldo', admin, (req, res) => {
  const destino = path.join(DATA_DIR, `respaldo_${Date.now()}.db`);
  db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  res.download(destino, `tesoreria_${hoy()}.db`, () => fs.rm(destino, { force: true }, () => {}));
});

// ---------- Usuarios ----------
api.get('/usuarios', admin, (req, res) =>
  res.json(db.prepare('SELECT id, email, nombre, rol, creado_en FROM usuarios ORDER BY nombre').all())
);
api.post('/usuarios', admin, (req, res) => {
  A.crearUsuario(req.body || {});
  res.json({ ok: true });
});
api.delete('/usuarios/:id', admin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.usuario.id) throw new L.ErrorUsuario('No podés eliminar tu propio usuario');
  db.prepare('DELETE FROM usuarios WHERE id = ?').run(id);
  res.json({ ok: true });
});

api.use((req, res) => res.status(404).json({ error: 'No encontrado' }));

// ---------- Interfaz ----------
app.use(express.static(PUBLIC, { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0, index: 'index.html' }));
app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

// ---------- Errores ----------
app.use((err, req, res, next) => {
  if (err instanceof L.ErrorUsuario) return res.status(err.status).json({ error: err.message });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'El archivo es demasiado grande' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Datos inválidos' });
  console.error(err);
  res.status(500).json({ error: 'Error interno. Revisá los registros del servidor.' });
});

// ---------- Devengo automático ----------
function tick() {
  try {
    const periodo = L.devengoAutomaticoPendiente();
    if (!periodo) return;
    const hechos = L.devengar(periodo, 'automático');
    setConfig('ultimo_devengo_auto', periodo);
    console.log(`[devengo] ${periodo}: ${hechos.length} cuotas devengadas`);
    avisarDevengo(hechos).catch((e) => console.error('[mail]', e));
  } catch (e) {
    console.error('[devengo]', e);
  }
}

A.asegurarAdmin();
const PUERTO = Number(process.env.PORT || 3000);
const servidor = app.listen(PUERTO, '0.0.0.0', () => {
  console.log(`Tesorería escuchando en el puerto ${PUERTO}`);
  tick();
  setInterval(tick, 60 * 60 * 1000).unref();
});
for (const s of ['SIGTERM', 'SIGINT'])
  process.on(s, () => {
    servidor.close(() => {
      db.close();
      process.exit(0);
    });
  });
