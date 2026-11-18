// Importa la hoja "Resumen" de la planilla vieja (exportada como CSV).
// Trae el padrón y deja a cada miembro, la caja y el Saco con su saldo actual
// como "saldo inicial". El historial anterior queda en la planilla original.
import { db, tx, setConfig, ahoraISO, hoy } from './db.js';
import { ErrorUsuario } from './logic.js';

export function parseCSV(texto) {
  const filas = [];
  let fila = [];
  let campo = '';
  let enComillas = false;
  const t = String(texto).replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (enComillas) {
      if (c === '"') {
        if (t[i + 1] === '"') (campo += '"'), i++;
        else enComillas = false;
      } else campo += c;
    } else if (c === '"') enComillas = true;
    else if (c === ',') (fila.push(campo), (campo = ''));
    else if (c === '\n') (fila.push(campo), filas.push(fila), (fila = []), (campo = ''));
    else if (c !== '\r') campo += c;
  }
  if (campo !== '' || fila.length) (fila.push(campo), filas.push(fila));
  return filas;
}

/** "$7,112,789.45" / "-$434,358.97" -> centavos. */
function plata(s) {
  const n = Number(String(s ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

const limpio = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function analizarResumen(csv) {
  const filas = parseCSV(csv);
  if (filas.length < 3) throw new ErrorUsuario('El archivo no parece ser la hoja Resumen');
  const cab = {};
  for (let i = 0; i < filas[0].length - 1; i++) {
    const et = limpio(filas[0][i]);
    if (et.endsWith(':')) cab[et.slice(0, -1).toLowerCase()] = filas[0][i + 1];
  }
  if (!('caja' in cab) || !('cuota' in cab))
    throw new ErrorUsuario('No encuentro "Caja:" y "Cuota:" en la primera fila. ¿Es la hoja Resumen?');
  const cuotaBase = plata(cab['cuota']);
  const miembros = [];
  for (const f of filas.slice(1)) {
    const nombre = limpio(f[3]);
    const apellido = limpio(f[4]);
    if (!nombre || !apellido) continue;
    const cuota = plata(f[16]);
    miembros.push({
      nombre,
      apellido,
      telefono: limpio(f[5]),
      email: limpio(f[6]).toLowerCase(),
      saldo: plata(f[7]),
      categoria: limpio(f[9]) || 'Normal',
      porcentaje: cuotaBase > 0 ? Math.round((cuota / cuotaBase) * 1e6) / 1e4 : 100,
      estado: limpio(f[13]).toLowerCase().startsWith('baja') ? 'baja' : 'activo',
    });
  }
  if (!miembros.length) throw new ErrorUsuario('No encontré miembros en el archivo');
  const porMail = new Map();
  const duplicados = [];
  for (const m of miembros) {
    if (!m.email) continue;
    if (porMail.has(m.email)) duplicados.push(`${porMail.get(m.email)}  ↔  ${m.apellido}, ${m.nombre} (${m.email})`);
    else porMail.set(m.email, `${m.apellido}, ${m.nombre}`);
  }
  return {
    caja: plata(cab['caja']),
    saco: plata(cab['saco de la viuda']),
    cuotaBase,
    tesorero: limpio(cab['tesorero']),
    deudaPlanilla: plata(cab['deuda miembros']),
    miembros,
    duplicados,
  };
}

export function importarResumen(csv, usuario) {
  if (db.prepare('SELECT COUNT(*) n FROM miembros').get().n > 0)
    throw new ErrorUsuario('La importación solo se puede hacer con el sistema vacío (sin miembros cargados).', 409);
  const a = analizarResumen(csv);
  const fecha = hoy();
  const ahora = ahoraISO();
  tx(() => {
    const catId = new Map();
    const selCat = db.prepare('SELECT id FROM categorias WHERE nombre = ?');
    const insCat = db.prepare('INSERT INTO categorias (nombre, porcentaje) VALUES (?, ?)');
    const updCat = db.prepare('UPDATE categorias SET porcentaje = ? WHERE id = ?');
    for (const m of a.miembros) {
      if (catId.has(m.categoria.toLowerCase())) continue;
      const ex = selCat.get(m.categoria);
      if (ex) (updCat.run(m.porcentaje, ex.id), catId.set(m.categoria.toLowerCase(), ex.id));
      else catId.set(m.categoria.toLowerCase(), Number(insCat.run(m.categoria, m.porcentaje).lastInsertRowid));
    }
    const insM = db.prepare(
      `INSERT INTO miembros (nombre, apellido, telefono, email, categoria_id, estado, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insV = db.prepare(
      `INSERT INTO movimientos (fecha, tipo, miembro_id, concepto, efecto_caja, efecto_saco, efecto_miembro, usuario, creado_en)
       VALUES (?, ?, ?, 'Saldo inicial migrado de la planilla', ?, ?, ?, ?, ?)`
    );
    for (const m of a.miembros) {
      const id = Number(
        insM.run(m.nombre, m.apellido, m.telefono, m.email, catId.get(m.categoria.toLowerCase()), m.estado, ahora)
          .lastInsertRowid
      );
      if (m.saldo !== 0) insV.run(fecha, 'ajuste_miembro', id, 0, 0, m.saldo, usuario, ahora);
    }
    if (a.caja !== 0) insV.run(fecha, 'ajuste_caja', null, a.caja, 0, 0, usuario, ahora);
    if (a.saco !== 0) insV.run(fecha, 'ajuste_saco', null, 0, a.saco, 0, usuario, ahora);
    if (a.cuotaBase > 0) setConfig('cuota_base', a.cuotaBase);
    if (a.tesorero) setConfig('tesorero', a.tesorero);
  });
  const deudaImportada = a.miembros.reduce((s, m) => s + (m.saldo < 0 ? -m.saldo : 0), 0);
  return {
    miembros: a.miembros.length,
    activos: a.miembros.filter((m) => m.estado === 'activo').length,
    bajas: a.miembros.filter((m) => m.estado === 'baja').length,
    caja: a.caja,
    saco: a.saco,
    cuota_base: a.cuotaBase,
    deuda_planilla: a.deudaPlanilla,
    deuda_importada: deudaImportada,
    duplicados: a.duplicados,
  };
}
