import { db, tx, getConfig, setConfig, ahoraISO, hoy } from './db.js';

export class ErrorUsuario extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

// tipo -> { miembro: requiere miembro, efecto(monto) }
export const TIPOS = {
  pago: { nombre: 'Pago de cuotas', miembro: true, caja: 1, mbr: 1 },
  devengo: { nombre: 'Devengamiento de cápita', miembro: true, mbr: -1 },
  deuda_adicional: { nombre: 'Deuda adicional', miembro: true, mbr: -1 },
  gasto: { nombre: 'Gasto', caja: -1 },
  otro_ingreso: { nombre: 'Otro ingreso', caja: 1 },
  saco_ingreso: { nombre: 'Ingreso Saco de la Viuda', saco: 1 },
  saco_egreso: { nombre: 'Egreso Saco de la Viuda', saco: -1 },
  // Lo genera el sistema cuando cambia el valor de la cuota (ver cambiarCuota).
  actualizacion_cuota: { nombre: 'Actualización por cambio de cuota', miembro: true, mbr: 1, signo: true, sistema: true },
  // Ajustes: aceptan importe con signo. Se usan para saldos iniciales y correcciones.
  ajuste_miembro: { nombre: 'Ajuste de cuenta de miembro', miembro: true, mbr: 1, signo: true },
  ajuste_caja: { nombre: 'Ajuste de caja', caja: 1, signo: true },
  ajuste_saco: { nombre: 'Ajuste Saco de la Viuda', saco: 1, signo: true },
};

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Convierte pesos (número o texto "1.234,56" / "1234.56") a centavos enteros. */
export function aCentavos(v) {
  if (typeof v === 'number') return Math.round(v * 100);
  let s = String(v ?? '').trim().replace(/[$\s]/g, '');
  if (!s) return NaN;
  if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, ''); // "35.000" = treinta y cinco mil
  } else if (s.includes(',') && s.includes('.')) {
    // el último separador es el decimal
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

/** Cuota de una categoría, en centavos. Las categorías reducidas se redondean a $100. */
export function cuotaDe(baseCent, porcentaje) {
  if (porcentaje === 100) return baseCent;
  const pesos = (baseCent / 100) * (porcentaje / 100);
  return Math.round(pesos / 100) * 100 * 100;
}

// ---------- Miembros ----------

const SQL_MIEMBROS = `
  SELECT m.id, m.nombre, m.apellido, m.telefono, m.email, m.estado, m.notas, m.creado_en,
         m.categoria_id, c.nombre AS categoria, c.porcentaje,
         COALESCE((SELECT SUM(efecto_miembro) FROM movimientos
                   WHERE miembro_id = m.id AND anulado = 0), 0) AS saldo
  FROM miembros m JOIN categorias c ON c.id = m.categoria_id`;

function decorar(m, cfg) {
  const base = Number(cfg.cuota_base);
  m.cuota = cuotaDe(base, m.porcentaje);
  m.cuotas_saldo = m.cuota > 0 ? m.saldo / m.cuota : null;
  m.art201 = m.cuota > 0 && m.saldo <= -Number(cfg.umbral_art201) * m.cuota;
  return m;
}

export function listarMiembros() {
  const cfg = getConfig();
  return db
    .prepare(SQL_MIEMBROS + ' ORDER BY m.apellido COLLATE NOCASE, m.nombre COLLATE NOCASE')
    .all()
    .map((m) => decorar(m, cfg));
}

export function obtenerMiembro(id) {
  const m = db.prepare(SQL_MIEMBROS + ' WHERE m.id = ?').get(id);
  if (!m) throw new ErrorUsuario('Miembro no encontrado', 404);
  return decorar(m, getConfig());
}

function limpiar(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function validarMiembro(d) {
  const nombre = limpiar(d.nombre);
  const apellido = limpiar(d.apellido);
  if (!nombre || !apellido) throw new ErrorUsuario('Nombre y apellido son obligatorios');
  const cat = db.prepare('SELECT id FROM categorias WHERE id = ?').get(Number(d.categoria_id));
  if (!cat) throw new ErrorUsuario('Categoría inválida');
  return {
    nombre,
    apellido,
    telefono: limpiar(d.telefono),
    email: limpiar(d.email).toLowerCase(),
    categoria_id: cat.id,
    notas: String(d.notas ?? '').trim(),
  };
}

function buscarDuplicado(d, exceptoId = 0) {
  return db
    .prepare(
      `SELECT id, nombre, apellido FROM miembros
       WHERE id != ? AND ((lower(nombre) = lower(?) AND lower(apellido) = lower(?))
          OR (? != '' AND lower(email) = ?))`
    )
    .get(exceptoId, d.nombre, d.apellido, d.email, d.email);
}

export function crearMiembro(datos) {
  const d = validarMiembro(datos);
  const dup = buscarDuplicado(d);
  if (dup && !datos.forzar)
    throw new ErrorUsuario(`Ya existe un miembro con ese nombre o mail: ${dup.apellido}, ${dup.nombre}`, 409);
  const r = db
    .prepare(
      `INSERT INTO miembros (nombre, apellido, telefono, email, categoria_id, notas, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(d.nombre, d.apellido, d.telefono, d.email, d.categoria_id, d.notas, ahoraISO());
  return obtenerMiembro(Number(r.lastInsertRowid));
}

export function editarMiembro(id, datos) {
  obtenerMiembro(id);
  const d = validarMiembro(datos);
  db.prepare(
    `UPDATE miembros SET nombre = ?, apellido = ?, telefono = ?, email = ?, categoria_id = ?, notas = ?
     WHERE id = ?`
  ).run(d.nombre, d.apellido, d.telefono, d.email, d.categoria_id, d.notas, id);
  return obtenerMiembro(id);
}

export function cambiarEstado(id, estado) {
  obtenerMiembro(id);
  db.prepare('UPDATE miembros SET estado = ? WHERE id = ?').run(estado, id);
  return obtenerMiembro(id);
}

export function eliminarMiembro(id) {
  obtenerMiembro(id);
  const n = db.prepare('SELECT COUNT(*) n FROM movimientos WHERE miembro_id = ?').get(id).n;
  if (n > 0)
    throw new ErrorUsuario('El miembro tiene movimientos. Dalo de baja o fusionalo con otro en lugar de eliminarlo.');
  db.prepare('DELETE FROM miembros WHERE id = ?').run(id);
}

/** Pasa todos los movimientos de `origenId` a `destinoId` y elimina el origen. */
export function fusionarMiembros(origenId, destinoId) {
  if (origenId === destinoId) throw new ErrorUsuario('Elegí dos miembros distintos');
  obtenerMiembro(origenId);
  obtenerMiembro(destinoId);
  return tx(() => {
    // Devengos del mismo período en ambos: el del origen pasa a ser un ajuste para no violar la unicidad.
    db.prepare(
      `UPDATE movimientos
       SET tipo = 'ajuste_miembro',
           concepto = 'Devengamiento ' || periodo || ' (de registro duplicado fusionado)',
           periodo = NULL
       WHERE miembro_id = ? AND tipo = 'devengo' AND anulado = 0
         AND periodo IN (SELECT periodo FROM movimientos
                         WHERE miembro_id = ? AND tipo = 'devengo' AND anulado = 0)`
    ).run(origenId, destinoId);
    db.prepare('UPDATE movimientos SET miembro_id = ? WHERE miembro_id = ?').run(destinoId, origenId);
    db.prepare('DELETE FROM miembros WHERE id = ?').run(origenId);
    return obtenerMiembro(destinoId);
  });
}

// ---------- Movimientos ----------

const SQL_MOVS = `
  SELECT v.*, m.apellido || ', ' || m.nombre AS miembro
  FROM movimientos v LEFT JOIN miembros m ON m.id = v.miembro_id`;

export function crearMovimiento(d, usuario) {
  const def = TIPOS[d.tipo];
  if (!def) throw new ErrorUsuario('Tipo de movimiento inválido');
  const monto = aCentavos(d.monto);
  if (!Number.isFinite(monto) || monto === 0) throw new ErrorUsuario('Importe inválido');
  if (monto < 0 && !def.signo) throw new ErrorUsuario('El importe debe ser positivo');
  const fecha = d.fecha || hoy();
  if (!RE_FECHA.test(fecha) || Number.isNaN(Date.parse(fecha))) throw new ErrorUsuario('Fecha inválida');
  let miembroId = null;
  if (def.miembro) {
    miembroId = Number(d.miembro_id);
    obtenerMiembro(miembroId);
  }
  let periodo = null;
  if (d.tipo === 'devengo') {
    periodo = d.periodo || fecha.slice(0, 7);
    if (!RE_PERIODO.test(periodo)) throw new ErrorUsuario('Período inválido');
    const ya = db
      .prepare(`SELECT 1 FROM movimientos WHERE miembro_id = ? AND periodo = ? AND tipo = 'devengo' AND anulado = 0`)
      .get(miembroId, periodo);
    if (ya) throw new ErrorUsuario(`Ese miembro ya tiene devengada la cuota de ${periodo}`, 409);
  }
  const concepto = limpiar(d.concepto) || def.nombre;
  const r = db
    .prepare(
      `INSERT INTO movimientos
        (fecha, tipo, miembro_id, concepto, periodo, efecto_caja, efecto_saco, efecto_miembro, usuario, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fecha,
      d.tipo,
      miembroId,
      concepto,
      periodo,
      (def.caja || 0) * monto,
      (def.saco || 0) * monto,
      (def.mbr || 0) * monto,
      usuario || '',
      ahoraISO()
    );
  return db.prepare(SQL_MOVS + ' WHERE v.id = ?').get(Number(r.lastInsertRowid));
}

export function anularMovimiento(id, motivo, usuario) {
  const v = db.prepare('SELECT * FROM movimientos WHERE id = ?').get(id);
  if (!v) throw new ErrorUsuario('Movimiento no encontrado', 404);
  if (v.anulado) throw new ErrorUsuario('El movimiento ya estaba anulado');
  db.prepare('UPDATE movimientos SET anulado = 1, anulado_motivo = ? WHERE id = ?').run(
    `${limpiar(motivo) || 'Sin motivo'} (${usuario || ''}, ${hoy()})`,
    id
  );
}

export function listarMovimientos(f = {}) {
  const cond = [];
  const args = [];
  if (f.miembro_id) (cond.push('v.miembro_id = ?'), args.push(Number(f.miembro_id)));
  if (f.tipo) (cond.push('v.tipo = ?'), args.push(f.tipo));
  if (f.desde) (cond.push('v.fecha >= ?'), args.push(f.desde));
  if (f.hasta) (cond.push('v.fecha <= ?'), args.push(f.hasta));
  if (f.ambito === 'caja') cond.push('v.efecto_caja != 0');
  if (f.ambito === 'saco') cond.push('v.efecto_saco != 0');
  if (!f.anulados) cond.push('v.anulado = 0');
  const where = cond.length ? ' WHERE ' + cond.join(' AND ') : '';
  const limite = Math.min(Math.max(Number(f.limite) || 100, 1), 5000);
  const desde = Math.max(Number(f.offset) || 0, 0);
  const total = db.prepare('SELECT COUNT(*) n FROM movimientos v' + where).get(...args).n;
  const filas = db
    .prepare(SQL_MOVS + where + ' ORDER BY v.fecha DESC, v.id DESC LIMIT ? OFFSET ?')
    .all(...args, limite, desde);
  return { total, filas };
}

// ---------- Resumen ----------

export function resumen() {
  const cfg = getConfig();
  const t = db
    .prepare(
      `SELECT COALESCE(SUM(efecto_caja),0) caja, COALESCE(SUM(efecto_saco),0) saco
       FROM movimientos WHERE anulado = 0`
    )
    .get();
  const ms = listarMiembros();
  let deuda = 0;
  let aFavor = 0;
  for (const m of ms) {
    if (m.saldo < 0) deuda += -m.saldo;
    else aFavor += m.saldo;
  }
  return {
    caja: t.caja,
    saco: t.saco,
    deuda,
    a_favor: aFavor,
    capitantes: ms.filter((m) => m.estado === 'activo').length,
    bajas: ms.filter((m) => m.estado === 'baja').length,
    art201: ms.filter((m) => m.art201 && m.estado === 'activo').length,
    cuota_base: Number(cfg.cuota_base),
    ultimo_devengo: db
      .prepare(`SELECT MAX(periodo) p FROM movimientos WHERE tipo = 'devengo' AND anulado = 0`)
      .get().p,
  };
}

// ---------- Devengamiento ----------

/** Devenga la cuota del período a todos los activos que aún no la tengan. */
export function devengar(periodo, usuario) {
  if (!RE_PERIODO.test(periodo || '')) throw new ErrorUsuario('Período inválido (AAAA-MM)');
  const cfg = getConfig();
  const base = Number(cfg.cuota_base);
  const hechos = [];
  tx(() => {
    const ins = db.prepare(
      `INSERT INTO movimientos (fecha, tipo, miembro_id, concepto, periodo, efecto_miembro, usuario, creado_en)
       VALUES (?, 'devengo', ?, ?, ?, ?, ?, ?)`
    );
    // Cuenta también los anulados: si a un miembro se le anuló a mano la cuota de un mes
    // (por ejemplo, porque la cubría la iniciación), el devengo masivo no se la vuelve a cargar.
    const ya = db.prepare(`SELECT 1 FROM movimientos WHERE miembro_id = ? AND periodo = ? AND tipo = 'devengo'`);
    for (const m of listarMiembros()) {
      if (m.estado !== 'activo') continue;
      const cuota = cuotaDe(base, m.porcentaje);
      if (cuota <= 0) continue;
      if (ya.get(m.id, periodo)) continue;
      ins.run(hoy(), m.id, `Devengamiento de cápita ${periodo}`, periodo, -cuota, usuario || 'sistema', ahoraISO());
      hechos.push({ ...m, saldo: m.saldo - cuota, cuota });
    }
  });
  return hechos;
}

/** Devengo automático: una sola vez por período, a partir del día configurado. */
export function devengoAutomaticoPendiente() {
  const cfg = getConfig();
  if (cfg.devengo_auto !== '1') return null;
  const h = hoy();
  const periodo = h.slice(0, 7);
  if (Number(h.slice(8, 10)) < Number(cfg.dia_devengo || 1)) return null;
  if (cfg.ultimo_devengo_auto === periodo) return null;
  const existe = db
    .prepare(`SELECT 1 FROM movimientos WHERE tipo = 'devengo' AND periodo = ? AND anulado = 0`)
    .get(periodo);
  if (existe) {
    setConfig('ultimo_devengo_auto', periodo);
    return null;
  }
  return periodo;
}

// ---------- Cambio del valor de la cuota ----------
// La deuda se entiende en cuotas: si la cuota cambia, toda la deuda pendiente se
// actualiza en la misma proporción (quien debía 3 cuotas sigue debiendo 3 cuotas).
// Los saldos a favor quedan en pesos.

function ajustesPorCambioCuota(nuevaCent) {
  const vieja = Number(getConfig().cuota_base);
  if (!(nuevaCent > 0)) throw new ErrorUsuario('Valor de cuota inválido');
  const ajustes = [];
  if (nuevaCent === vieja || !(vieja > 0)) return { vieja, ajustes };
  for (const m of listarMiembros()) {
    if (m.saldo >= 0) continue;
    const nuevoSaldo = Math.round((m.saldo * nuevaCent) / vieja / 100) * 100; // sin centavos
    if (nuevoSaldo !== m.saldo) ajustes.push({ id: m.id, nombre: `${m.apellido}, ${m.nombre}`, antes: m.saldo, despues: nuevoSaldo });
  }
  return { vieja, ajustes };
}

export function previsualizarCambioCuota(nuevaCent) {
  const { vieja, ajustes } = ajustesPorCambioCuota(nuevaCent);
  return {
    cuota_actual: vieja,
    cuota_nueva: nuevaCent,
    afectados: ajustes.length,
    diferencia: ajustes.reduce((s, a) => s + (a.antes - a.despues), 0), // positivo = la deuda total sube
    detalle: ajustes,
  };
}

export function cambiarCuota(nuevaCent, usuario) {
  const pesos = (c) => '$' + (c / 100).toLocaleString('es-AR');
  return tx(() => {
    const { vieja, ajustes } = ajustesPorCambioCuota(nuevaCent);
    const ins = db.prepare(
      `INSERT INTO movimientos (fecha, tipo, miembro_id, concepto, efecto_miembro, usuario, creado_en)
       VALUES (?, 'actualizacion_cuota', ?, ?, ?, ?, ?)`
    );
    const concepto = `Cambio de cuota ${pesos(vieja)} → ${pesos(nuevaCent)}`;
    for (const a of ajustes) ins.run(hoy(), a.id, concepto, a.despues - a.antes, usuario || '', ahoraISO());
    setConfig('cuota_base', nuevaCent);
    return ajustes.length;
  });
}

// ---------- Informe mensual ----------

export function informe(periodo) {
  if (!RE_PERIODO.test(periodo || '')) throw new ErrorUsuario('Período inválido (AAAA-MM)');
  const cfg = getConfig();
  const desde = periodo + '-01';
  const hasta = periodo + '-31';
  const mes = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN efecto_caja > 0 THEN efecto_caja END),0) ingresos,
              COALESCE(SUM(CASE WHEN efecto_caja < 0 THEN -efecto_caja END),0) egresos
       FROM movimientos
       WHERE anulado = 0 AND tipo != 'ajuste_caja' AND fecha BETWEEN ? AND ?`
    )
    .get(desde, hasta);
  const cierre = db
    .prepare(
      `SELECT COALESCE(SUM(efecto_caja),0) caja, COALESCE(SUM(efecto_saco),0) saco
       FROM movimientos WHERE anulado = 0 AND fecha <= ?`
    )
    .get(hasta);
  const saldos = db
    .prepare(
      `SELECT m.id, m.nombre, m.apellido, m.estado, c.porcentaje,
              COALESCE((SELECT SUM(efecto_miembro) FROM movimientos
                        WHERE miembro_id = m.id AND anulado = 0 AND fecha <= ?), 0) saldo
       FROM miembros m JOIN categorias c ON c.id = m.categoria_id
       ORDER BY m.apellido COLLATE NOCASE, m.nombre COLLATE NOCASE`
    )
    .all(hasta);
  const base = Number(cfg.cuota_base);
  const umbral = Number(cfg.umbral_informe);
  let deuda = 0;
  const deudores = [];
  for (const s of saldos) {
    if (s.saldo < 0) deuda += -s.saldo;
    if (s.saldo < -umbral * base)
      deudores.push({ nombre: `${s.nombre} ${s.apellido}`, deuda: -s.saldo, baja: s.estado === 'baja' });
  }
  const detalle = db
    .prepare(
      `SELECT fecha, tipo, concepto, efecto_caja FROM movimientos
       WHERE anulado = 0 AND efecto_caja != 0 AND tipo NOT IN ('pago','ajuste_caja') AND fecha BETWEEN ? AND ?
       ORDER BY fecha, id`
    )
    .all(desde, hasta);
  const pagos = db
    .prepare(
      `SELECT COALESCE(SUM(efecto_caja),0) total, COUNT(*) n FROM movimientos
       WHERE anulado = 0 AND tipo = 'pago' AND fecha BETWEEN ? AND ?`
    )
    .get(desde, hasta);
  return {
    periodo,
    logia: cfg.nombre_logia,
    venerable: cfg.venerable,
    tesorero: cfg.tesorero,
    ingresos: mes.ingresos,
    egresos: mes.egresos,
    resultado: mes.ingresos - mes.egresos,
    caja: cierre.caja,
    saco: cierre.saco,
    deuda,
    deudores,
    pagos,
    detalle,
    umbral,
  };
}

// ---------- Aviso (WhatsApp / mail) ----------

export function textoAviso(m, cfg = getConfig()) {
  const abs = Math.abs(m.saldo) / 100;
  const favcon = m.saldo < 0 ? 'deudor' : m.saldo === 0 ? 'a plomo' : 'a favor';
  const saldo = abs.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return String(cfg.plantilla_aviso)
    .replaceAll('<nompila>', m.nombre)
    .replaceAll('<saldo>', saldo)
    .replaceAll('<favcon>', favcon)
    .replaceAll('<tesorero>', cfg.tesorero || '')
    .replaceAll('<logia>', cfg.nombre_logia || '');
}
