import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
export const DB_PATH = path.join(DATA_DIR, 'tesoreria.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// Todos los importes se guardan en centavos (enteros).
db.exec(`
CREATE TABLE IF NOT EXISTS config (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nombre TEXT NOT NULL,
  rol TEXT NOT NULL CHECK (rol IN ('admin','lectura')),
  hash TEXT NOT NULL,
  creado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sesiones (
  token TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categorias (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE COLLATE NOCASE,
  porcentaje REAL NOT NULL CHECK (porcentaje >= 0)
);

CREATE TABLE IF NOT EXISTS miembros (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  apellido TEXT NOT NULL,
  telefono TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  categoria_id INTEGER NOT NULL REFERENCES categorias(id),
  estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','baja')),
  notas TEXT NOT NULL DEFAULT '',
  creado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS movimientos (
  id INTEGER PRIMARY KEY,
  fecha TEXT NOT NULL,              -- AAAA-MM-DD
  tipo TEXT NOT NULL,
  miembro_id INTEGER REFERENCES miembros(id),
  concepto TEXT NOT NULL DEFAULT '',
  periodo TEXT,                     -- AAAA-MM, solo devengos
  efecto_caja INTEGER NOT NULL DEFAULT 0,
  efecto_saco INTEGER NOT NULL DEFAULT 0,
  efecto_miembro INTEGER NOT NULL DEFAULT 0,
  anulado INTEGER NOT NULL DEFAULT 0,
  anulado_motivo TEXT,
  usuario TEXT NOT NULL DEFAULT '',
  creado_en TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS mov_miembro ON movimientos(miembro_id);
CREATE INDEX IF NOT EXISTS mov_fecha ON movimientos(fecha);
CREATE UNIQUE INDEX IF NOT EXISTS mov_devengo_unico
  ON movimientos(miembro_id, periodo) WHERE tipo = 'devengo' AND anulado = 0;
`);

const DEFAULTS = {
  nombre_logia: 'Logia Unión n° 17',
  cuota_base: '3500000',
  venerable: '',
  venerable_email: '',
  tesorero: '',
  dia_devengo: '1',
  devengo_auto: '0',
  mail_devengo: '0',
  umbral_art201: '3',
  umbral_informe: '2',
  plantilla_aviso:
    'Hola <nompila>, te escribo de la Tesorería de la <logia>. Tu estado de cuenta al día de hoy es de $ <saldo> <favcon>. Un abrazo, <tesorero>.',
};
const insDef = db.prepare('INSERT OR IGNORE INTO config (clave, valor) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULTS)) insDef.run(k, v);

const insCat = db.prepare('INSERT OR IGNORE INTO categorias (nombre, porcentaje) VALUES (?, ?)');
if (db.prepare('SELECT COUNT(*) n FROM categorias').get().n === 0) {
  insCat.run('Normal', 100);
  insCat.run('Libre', 0);
}

export function getConfig() {
  const out = {};
  for (const r of db.prepare('SELECT clave, valor FROM config').all()) out[r.clave] = r.valor;
  return out;
}

export function setConfig(clave, valor) {
  db.prepare(
    'INSERT INTO config (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor'
  ).run(clave, String(valor));
}

/** Ejecuta fn dentro de una transacción. */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function ahoraISO() {
  return new Date().toISOString();
}

/** Fecha de hoy (AAAA-MM-DD) en la zona horaria configurada. */
export function hoy() {
  const tz = process.env.TZ_APP || 'America/Argentina/Buenos_Aires';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}
