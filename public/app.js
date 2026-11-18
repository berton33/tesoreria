// Interfaz de la tesorería. Sin dependencias ni paso de compilación.
const $app = document.getElementById('app');
const S = { yo: null, mail: false, hoy: '', cfg: {} };

// ---------- Utilidades ----------
function h(tag, attrs, ...hijos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of hijos.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const fmtPlata = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' });
const plata = (cent) => fmtPlata.format((cent || 0) / 100);
const fecha = (iso) => (iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : '');
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const nombrePeriodo = (p) => `${MESES[Number(p.slice(5, 7)) - 1]} de ${p.slice(0, 4)}`;
const esAdmin = () => S.yo?.rol === 'admin';

function spanSaldo(cent) {
  return h('span', { class: cent < 0 ? 'neg' : cent > 0 ? 'pos' : '' }, plata(cent));
}

function toast(msg, mal = false) {
  const t = h('div', { class: 'toast' + (mal ? ' mal' : '') }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), mal ? 6000 : 3000);
}

async function api(metodo, url, cuerpo) {
  const r = await fetch('/api' + url, {
    method: metodo,
    headers: cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
  });
  let d = null;
  try {
    d = await r.json();
  } catch {}
  if (r.status === 401 && url !== '/login') {
    S.yo = null;
    vistaLogin();
    throw new Error(d?.error || 'Sesión vencida');
  }
  if (!r.ok) {
    const e = new Error(d?.error || `Error ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return d;
}

/** Ejecuta una acción y muestra el error como aviso si falla. */
async function intentar(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
  }
}

function dialogo(titulo, cuerpo) {
  const d = h(
    'dialog',
    {},
    h('div', { class: 'cab' }, h('h2', {}, titulo), h('button', { class: 'x', 'aria-label': 'Cerrar', onclick: () => d.close() }, '×')),
    h('div', { class: 'cuerpo' }, cuerpo)
  );
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}

function campo(etiqueta, control) {
  return h('div', {}, h('label', {}, etiqueta), control);
}

/** Formulario genérico: muestra el error dentro del diálogo y bloquea el doble envío. */
function formulario(campos, botones, alEnviar) {
  const err = h('div', { class: 'error', hidden: true });
  const f = h('form', {}, campos, err, h('div', { class: 'pie' }, botones));
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const bts = f.querySelectorAll('button');
    bts.forEach((b) => (b.disabled = true));
    err.hidden = true;
    try {
      await alEnviar(ev.submitter?.value || '');
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      bts.forEach((b) => (b.disabled = false));
    }
  });
  return f;
}

// ---------- Estructura y rutas ----------
const RUTAS = [
  ['#/', 'Inicio'],
  ['#/miembros', 'Miembros'],
  ['#/movimientos', 'Movimientos'],
  ['#/informe', 'Informe'],
  ['#/config', 'Configuración'],
];

function marco(contenido) {
  const ruta = location.hash || '#/';
  const activa = (r) => (r === '#/' ? ruta === '#/' : ruta.startsWith(r) || (r === '#/miembros' && ruta.startsWith('#/miembro/')));
  $app.replaceChildren(
    h(
      'header',
      { class: 'top' },
      h(
        'div',
        { class: 'in' },
        h('div', { class: 'marca' }, S.cfg.nombre_logia || 'Tesorería'),
        h('nav', {}, RUTAS.map(([r, t]) => h('a', { href: r, class: activa(r) ? 'activo' : '' }, t))),
        h(
          'button',
          {
            class: 'salir',
            onclick: async () => {
              await intentar(() => api('POST', '/logout', {}));
              S.yo = null;
              vistaLogin();
            },
          },
          'Salir'
        )
      )
    ),
    h('main', {}, contenido)
  );
}

async function render() {
  if (!S.yo) return;
  const ruta = location.hash || '#/';
  try {
    S.cfg = await api('GET', '/config');
    document.title = 'Tesorería · ' + (S.cfg.nombre_logia || '');
    let v;
    const mM = ruta.match(/^#\/miembro\/(\d+)$/);
    if (mM) v = await vistaMiembro(Number(mM[1]));
    else if (ruta.startsWith('#/miembros')) v = await vistaMiembros();
    else if (ruta.startsWith('#/movimientos')) v = await vistaMovimientos();
    else if (ruta.startsWith('#/informe')) v = await vistaInforme();
    else if (ruta.startsWith('#/config')) v = await vistaConfig();
    else v = await vistaInicio();
    if (S.yo) marco(v);
  } catch (e) {
    if (S.yo) marco(h('div', { class: 'error' }, e.message));
  }
}
window.addEventListener('hashchange', render);

// ---------- Ingreso ----------
function vistaLogin() {
  const email = h('input', { type: 'email', autocomplete: 'username', required: true });
  const clave = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const f = formulario(
    [campo('Mail', email), campo('Contraseña', clave)],
    h('button', { class: 'pri', type: 'submit' }, 'Ingresar'),
    async () => {
      await api('POST', '/login', { email: email.value, clave: clave.value });
      await iniciar();
    }
  );
  $app.replaceChildren(h('div', { class: 'login' }, h('div', { class: 'panel' }, h('h1', {}, 'Tesorería'), f)));
  email.focus();
}

async function iniciar() {
  try {
    const d = await api('GET', '/yo');
    S.yo = d.usuario;
    S.mail = d.mail;
    S.hoy = d.hoy;
    await render();
  } catch {
    /* api() ya mostró el ingreso */
  }
}

// ---------- Carga de movimientos ----------
const TIPOS = {
  pago: { nombre: 'Pago de cuotas', miembro: true },
  deuda_adicional: { nombre: 'Deuda adicional', miembro: true, ayuda: 'Suma deuda al miembro (rifas, cenas, etc.). No mueve la caja.' },
  gasto: { nombre: 'Gasto' },
  otro_ingreso: { nombre: 'Otro ingreso' },
  saco_ingreso: { nombre: 'Ingreso Saco de la Viuda' },
  saco_egreso: { nombre: 'Egreso Saco de la Viuda' },
  ajuste_miembro: { nombre: 'Ajuste de cuenta de miembro', miembro: true, signo: true, ayuda: 'Positivo a favor del miembro, negativo en contra. No mueve la caja.' },
  ajuste_caja: { nombre: 'Ajuste de caja', signo: true, ayuda: 'Positivo suma a la caja, negativo resta.' },
  ajuste_saco: { nombre: 'Ajuste Saco de la Viuda', signo: true, ayuda: 'Positivo suma al Saco, negativo resta.' },
  devengo: { nombre: 'Devengamiento de cápita', oculto: true },
};

async function abrirMovimiento(tipoInicial, miembroId) {
  const miembros = await api('GET', '/miembros');
  const tipo = h('select', {}, Object.entries(TIPOS).filter(([, t]) => !t.oculto).map(([k, t]) => h('option', { value: k }, t.nombre)));
  tipo.value = tipoInicial;
  const opciones = (estado) =>
    miembros.filter((m) => m.estado === estado).map((m) => h('option', { value: m.id }, `${m.apellido}, ${m.nombre}`));
  const miembro = h(
    'select',
    {},
    h('option', { value: '' }, 'Elegí un miembro…'),
    h('optgroup', { label: 'Activos' }, opciones('activo')),
    h('optgroup', { label: 'Bajas' }, opciones('baja'))
  );
  if (miembroId) miembro.value = miembroId;
  const info = h('div', { class: 'small muted' });
  const rapidos = h('div', { class: 'fila', style: 'margin-top:8px' });
  const monto = h('input', { inputmode: 'decimal', placeholder: '0,00', required: true, autocomplete: 'off' });
  const fechaI = h('input', { type: 'date', value: S.hoy, max: S.hoy, required: true });
  const concepto = h('input', { maxlength: 200, placeholder: 'Opcional' });
  const ayuda = h('div', { class: 'small muted' });
  const cMiembro = campo('Miembro', [miembro, info, rapidos]);

  function refrescar() {
    const t = TIPOS[tipo.value];
    cMiembro.hidden = !t.miembro;
    miembro.required = Boolean(t.miembro);
    ayuda.textContent = t.ayuda || '';
    const m = miembros.find((x) => x.id === Number(miembro.value));
    info.replaceChildren();
    rapidos.replaceChildren();
    if (t.miembro && m) {
      info.append('Saldo actual: ', spanSaldo(m.saldo), ` · Cuota: ${plata(m.cuota)}`);
      if (tipo.value === 'pago') {
        const poner = (c) => ((monto.value = (c / 100).toFixed(2).replace('.', ',')), monto.focus());
        if (m.cuota > 0) rapidos.append(h('button', { type: 'button', class: 'chico', onclick: () => poner(m.cuota) }, '1 cuota'));
        if (m.saldo < 0) rapidos.append(h('button', { type: 'button', class: 'chico', onclick: () => poner(-m.saldo) }, 'Saldar deuda'));
      }
    }
  }
  tipo.addEventListener('change', refrescar);
  miembro.addEventListener('change', refrescar);

  const f = formulario(
    [campo('Tipo', [tipo, ayuda]), cMiembro, h('div', { class: 'dos' }, campo('Importe ($)', monto), campo('Fecha', fechaI)), campo('Concepto', concepto)],
    [
      h('button', { type: 'submit', value: 'otro' }, 'Guardar y cargar otro'),
      h('button', { type: 'submit', class: 'pri', value: 'cerrar' }, 'Guardar'),
    ],
    async (accion) => {
      const v = await api('POST', '/movimientos', {
        tipo: tipo.value,
        miembro_id: miembro.value || null,
        monto: monto.value,
        fecha: fechaI.value,
        concepto: concepto.value,
      });
      toast(`${TIPOS[v.tipo].nombre} registrado${v.miembro ? ': ' + v.miembro : ''}`);
      if (accion === 'otro') {
        const m = miembros.find((x) => x.id === v.miembro_id);
        if (m) m.saldo += v.efecto_miembro;
        monto.value = '';
        concepto.value = '';
        if (TIPOS[tipo.value].miembro) (miembro.value = ''), miembro.focus();
        else monto.focus();
        refrescar();
      } else d.close();
    }
  );
  const d = dialogo('Registrar movimiento', f);
  d.addEventListener('close', render);
  refrescar();
  (TIPOS[tipo.value].miembro && !miembroId ? miembro : monto).focus();
}

function anular(v) {
  const motivo = h('input', { required: true, maxlength: 200, placeholder: 'Ej.: importe mal cargado' });
  const f = formulario(
    [
      h('p', {}, `${TIPOS[v.tipo]?.nombre || v.tipo} del ${fecha(v.fecha)}${v.miembro ? ' — ' + v.miembro : ''}`),
      h('p', { class: 'small muted' }, 'El movimiento queda tachado en el historial y deja de contar en los saldos.'),
      campo('Motivo', motivo),
    ],
    h('button', { type: 'submit', class: 'pri' }, 'Anular movimiento'),
    async () => {
      await api('POST', `/movimientos/${v.id}/anular`, { motivo: motivo.value });
      toast('Movimiento anulado');
      d.close();
    }
  );
  const d = dialogo('Anular movimiento', f);
  d.addEventListener('close', render);
  motivo.focus();
}

function importeMov(v) {
  const c = v.efecto_caja || v.efecto_saco || v.efecto_miembro;
  return spanSaldo(c);
}

function tablaMovimientos(filas, { conMiembro = true } = {}) {
  if (!filas.length) return h('p', { class: 'muted' }, 'Sin movimientos.');
  return h(
    'div',
    { class: 'tabla-wrap' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Fecha'), h('th', {}, 'Movimiento'), conMiembro && h('th', { class: 'sec' }, 'Miembro'), h('th', { class: 'num' }, 'Importe'), h('th', {}))),
      h(
        'tbody',
        {},
        filas.map((v) =>
          h(
            'tr',
            { class: v.anulado ? 'anulado' : '', title: v.anulado ? 'Anulado: ' + v.anulado_motivo : '' },
            h('td', { class: 'num', style: 'text-align:left' }, fecha(v.fecha)),
            h(
              'td',
              {},
              TIPOS[v.tipo]?.nombre || v.tipo,
              v.concepto && v.concepto !== TIPOS[v.tipo]?.nombre ? h('div', { class: 'small muted' }, v.concepto) : null,
              conMiembro && v.miembro ? h('div', { class: 'small solo-movil' }, h('a', { href: `#/miembro/${v.miembro_id}` }, v.miembro)) : null
            ),
            conMiembro && h('td', { class: 'sec' }, v.miembro_id ? h('a', { href: `#/miembro/${v.miembro_id}` }, v.miembro) : ''),
            h('td', { class: 'num' }, importeMov(v)),
            h('td', { class: 'num' }, esAdmin() && !v.anulado ? h('button', { class: 'chico peligro', onclick: () => anular(v) }, 'Anular') : null)
          )
        )
      )
    )
  );
}

// ---------- Inicio ----------
async function vistaInicio() {
  const [r, movs] = await Promise.all([api('GET', '/resumen'), api('GET', '/movimientos?limite=12')]);
  const tarjeta = (et, val, sub) => h('div', { class: 'tarjeta' }, h('div', { class: 'et' }, et), h('div', { class: 'val' }, val), sub && h('div', { class: 'sub' }, sub));
  const vacio = r.capitantes + r.bajas === 0;
  return [
    vacio && esAdmin() && h('div', { class: 'aviso' }, 'El sistema está vacío. Podés traer el padrón y los saldos de la planilla desde ', h('a', { href: '#/config' }, 'Configuración → Importar'), '.'),
    h(
      'div',
      { class: 'tarjetas' },
      tarjeta('Caja', plata(r.caja)),
      tarjeta('Deuda de miembros', plata(r.deuda), r.a_favor ? `Saldos a favor: ${plata(r.a_favor)}` : null),
      tarjeta('Saco de la Viuda', plata(r.saco)),
      tarjeta('Capitantes', r.capitantes, `${r.bajas} bajas · ${r.art201} en Art. 201`),
      tarjeta('Cuota', plata(r.cuota_base), r.ultimo_devengo ? `Último devengo: ${nombrePeriodo(r.ultimo_devengo)}` : 'Sin devengos aún')
    ),
    esAdmin() &&
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, 'Registrar'),
        h(
          'div',
          { class: 'acciones' },
          h('button', { class: 'pri', onclick: () => abrirMovimiento('pago') }, 'Pago de cuotas'),
          h('button', { onclick: () => abrirMovimiento('gasto') }, 'Gasto'),
          h('button', { onclick: () => abrirMovimiento('otro_ingreso') }, 'Otro ingreso'),
          h('button', { onclick: () => abrirMovimiento('deuda_adicional') }, 'Deuda adicional'),
          h('button', { onclick: () => abrirMovimiento('saco_ingreso') }, 'Ingreso Saco'),
          h('button', { onclick: () => abrirMovimiento('saco_egreso') }, 'Egreso Saco')
        )
      ),
    h('div', { class: 'panel' }, h('div', { class: 'fila entre' }, h('h2', {}, 'Últimos movimientos'), h('a', { href: '#/movimientos', class: 'small' }, 'Ver todos')), tablaMovimientos(movs.filas)),
  ];
}

// ---------- Miembros ----------
async function formMiembro(m) {
  const cats = await api('GET', '/categorias');
  const nombre = h('input', { required: true, value: m?.nombre || '' });
  const apellido = h('input', { required: true, value: m?.apellido || '' });
  const tel = h('input', { type: 'tel', value: m?.telefono || '' });
  const email = h('input', { type: 'email', value: m?.email || '' });
  const cat = h('select', {}, cats.map((c) => h('option', { value: c.id }, `${c.nombre} (${Number(c.porcentaje.toFixed(2))}%)`)));
  if (m) cat.value = m.categoria_id;
  const notas = h('textarea', {}, m?.notas || '');
  let forzar = false;
  const f = formulario(
    [h('div', { class: 'dos' }, campo('Nombre', nombre), campo('Apellido', apellido)), h('div', { class: 'dos' }, campo('Teléfono', tel), campo('Mail', email)), campo('Categoría', cat), campo('Notas', notas)],
    h('button', { type: 'submit', class: 'pri' }, m ? 'Guardar cambios' : 'Agregar miembro'),
    async () => {
      const datos = { nombre: nombre.value, apellido: apellido.value, telefono: tel.value, email: email.value, categoria_id: cat.value, notas: notas.value, forzar };
      try {
        const r = m ? await api('PUT', `/miembros/${m.id}`, datos) : await api('POST', '/miembros', datos);
        toast(m ? 'Datos guardados' : 'Miembro agregado');
        d.close();
        if (!m) location.hash = `#/miembro/${r.id}`;
        else render();
      } catch (e) {
        if (e.status === 409 && !forzar) {
          forzar = true;
          throw new Error(e.message + '. Si igual querés agregarlo, volvé a tocar el botón.');
        }
        throw e;
      }
    }
  );
  const d = dialogo(m ? 'Editar miembro' : 'Nuevo miembro', f);
  nombre.focus();
}

async function vistaMiembros() {
  const ms = await api('GET', '/miembros');
  const buscar = h('input', { type: 'search', placeholder: 'Buscar por nombre, mail o teléfono…' });
  const filtro = h('select', {}, h('option', { value: 'activo' }, 'Activos'), h('option', { value: 'deuda' }, 'Con deuda'), h('option', { value: 'art201' }, 'Art. 201'), h('option', { value: 'baja' }, 'Bajas'), h('option', { value: 'todos' }, 'Todos'));
  const cuerpo = h('tbody', {});
  const cuenta = h('div', { class: 'small muted', style: 'margin-top:10px' });
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  function pintar() {
    const q = norm(buscar.value.trim());
    const f = filtro.value;
    const lista = ms.filter((m) => {
      if (f === 'activo' && m.estado !== 'activo') return false;
      if (f === 'baja' && m.estado !== 'baja') return false;
      if (f === 'deuda' && !(m.saldo < 0)) return false;
      if (f === 'art201' && !m.art201) return false;
      return !q || norm(`${m.apellido} ${m.nombre} ${m.email} ${m.telefono}`).includes(q);
    });
    cuerpo.replaceChildren(
      ...lista.map((m) =>
        h(
          'tr',
          { class: 'click', onclick: () => (location.hash = `#/miembro/${m.id}`) },
          h('td', {}, h('a', { href: `#/miembro/${m.id}` }, `${m.apellido}, ${m.nombre}`), ' ', m.estado === 'baja' && h('span', { class: 'chip' }, 'Baja'), ' ', m.art201 && h('span', { class: 'chip bad' }, 'Art. 201')),
          h('td', { class: 'sec' }, m.categoria),
          h('td', { class: 'num sec' }, plata(m.cuota)),
          h('td', { class: 'num' }, spanSaldo(m.saldo)),
          h('td', { class: 'num sec' }, m.cuotas_saldo == null ? '—' : m.cuotas_saldo.toFixed(1).replace('.', ','))
        )
      )
    );
    const total = lista.reduce((s, m) => s + m.saldo, 0);
    cuenta.textContent = `${lista.length} miembros · saldo neto ${plata(total)}`;
  }
  buscar.addEventListener('input', pintar);
  filtro.addEventListener('change', pintar);
  pintar();
  return [
    h('div', { class: 'fila entre' }, h('h1', {}, 'Miembros'), esAdmin() && h('button', { class: 'pri', onclick: () => formMiembro() }, 'Nuevo miembro')),
    h(
      'div',
      { class: 'panel' },
      h('div', { class: 'fila' }, h('div', { class: 'grow' }, buscar), h('div', { style: 'flex:0 0 150px' }, filtro)),
      h('div', { class: 'tabla-wrap', style: 'margin-top:10px' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Miembro'), h('th', { class: 'sec' }, 'Categoría'), h('th', { class: 'num sec' }, 'Cuota'), h('th', { class: 'num' }, 'Saldo'), h('th', { class: 'num sec' }, 'En cuotas'))), cuerpo)),
      cuenta
    ),
  ];
}

function numeroWhatsapp(t) {
  let d = String(t || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('549')) return d;
  if (d.startsWith('54')) return '549' + d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  return '549' + d;
}

async function vistaMiembro(id) {
  const { miembro: m, movimientos, aviso } = await api('GET', `/miembros/${id}`);
  const wa = numeroWhatsapp(m.telefono);
  const acciones = [];
  if (esAdmin()) {
    acciones.push(
      h('button', { class: 'pri', onclick: () => abrirMovimiento('pago', m.id) }, 'Registrar pago'),
      h('button', { onclick: () => abrirMovimiento('deuda_adicional', m.id) }, 'Deuda adicional'),
      h('button', { onclick: () => formMiembro(m) }, 'Editar')
    );
  }
  if (wa) acciones.push(h('a', { class: 'btn', target: '_blank', rel: 'noopener', href: `https://wa.me/${wa}?text=${encodeURIComponent(aviso)}` }, 'Avisar por WhatsApp'));
  if (esAdmin() && S.mail && m.email)
    acciones.push(
      h(
        'button',
        {
          onclick: (ev) =>
            intentar(async () => {
              ev.target.disabled = true;
              await api('POST', `/miembros/${m.id}/aviso-mail`, {}).finally(() => (ev.target.disabled = false));
              toast('Mail enviado');
            }),
        },
        'Avisar por mail'
      )
    );

  const otras = esAdmin() && [
    h(
      'button',
      {
        onclick: () =>
          intentar(async () => {
            const nuevo = m.estado === 'activo' ? 'baja' : 'activo';
            if (!confirm(nuevo === 'baja' ? `¿Dar de baja a ${m.nombre} ${m.apellido}? Deja de devengar cuotas; su saldo se conserva.` : `¿Reactivar a ${m.nombre} ${m.apellido}?`)) return;
            await api('POST', `/miembros/${m.id}/estado`, { estado: nuevo });
            render();
          }),
      },
      m.estado === 'activo' ? 'Dar de baja' : 'Reactivar'
    ),
    h('button', { onclick: () => fusionar(m) }, 'Fusionar con otro…'),
    h(
      'button',
      {
        class: 'peligro',
        onclick: () =>
          intentar(async () => {
            if (!confirm(`¿Eliminar definitivamente a ${m.nombre} ${m.apellido}? No se puede deshacer.`)) return;
            await api('DELETE', `/miembros/${m.id}`);
            location.hash = '#/miembros';
          }),
      },
      'Eliminar'
    ),
  ];

  return [
    h('p', { class: 'small' }, h('a', { href: '#/miembros' }, '← Miembros')),
    h(
      'div',
      { class: 'panel' },
      h('div', { class: 'fila entre' }, h('h1', { style: 'margin:0' }, `${m.nombre} ${m.apellido}`), h('div', {}, m.estado === 'baja' && h('span', { class: 'chip' }, 'Baja'), ' ', m.art201 && h('span', { class: 'chip bad' }, 'Art. 201'))),
      h('p', { class: 'muted' }, [m.categoria + ` · cuota ${plata(m.cuota)}`, m.telefono, m.email].filter(Boolean).join(' · ')),
      m.notas && h('p', {}, m.notas),
      h('div', { class: 'tarjetas' }, h('div', { class: 'tarjeta' }, h('div', { class: 'et' }, 'Estado de cuenta'), h('div', { class: 'val' }, spanSaldo(m.saldo)), h('div', { class: 'sub' }, m.saldo < 0 ? 'Deudor' : m.saldo > 0 ? 'A favor' : 'A plomo', m.cuotas_saldo != null && m.saldo < 0 ? ` · ${(-m.cuotas_saldo).toFixed(1).replace('.', ',')} cuotas` : ''))),
      h('div', { class: 'fila' }, acciones)
    ),
    h('div', { class: 'panel' }, h('h2', {}, 'Cuenta corriente'), tablaMovimientos(movimientos, { conMiembro: false })),
    otras && h('div', { class: 'panel' }, h('h2', {}, 'Otras acciones'), h('div', { class: 'fila' }, otras)),
  ];
}

async function fusionar(m) {
  const ms = (await api('GET', '/miembros')).filter((x) => x.id !== m.id);
  const sel = h('select', { required: true }, h('option', { value: '' }, 'Elegí el registro que queda…'), ms.map((x) => h('option', { value: x.id }, `${x.apellido}, ${x.nombre} (${plata(x.saldo)})`)));
  const f = formulario(
    [h('p', {}, `Para cuando una persona quedó cargada dos veces. Todos los movimientos de ${m.nombre} ${m.apellido} pasan al miembro que elijas y este registro se elimina.`), h('div', { class: 'aviso' }, 'Los saldos de ambos se suman. No se puede deshacer.'), campo('Fusionar dentro de', sel)],
    h('button', { type: 'submit', class: 'pri' }, 'Fusionar'),
    async () => {
      await api('POST', `/miembros/${m.id}/fusionar`, { destino_id: Number(sel.value) });
      toast('Registros fusionados');
      d.close();
      location.hash = `#/miembro/${sel.value}`;
    }
  );
  const d = dialogo('Fusionar registros duplicados', f);
}

// ---------- Movimientos ----------
async function vistaMovimientos() {
  const tipo = h('select', {}, h('option', { value: '' }, 'Todos los tipos'), Object.entries(TIPOS).map(([k, t]) => h('option', { value: k }, t.nombre)));
  const ambito = h('select', {}, h('option', { value: '' }, 'Todo'), h('option', { value: 'caja' }, 'Solo caja'), h('option', { value: 'saco' }, 'Solo Saco'));
  const desde = h('input', { type: 'date' });
  const hasta = h('input', { type: 'date' });
  const anulados = h('input', { type: 'checkbox' });
  const zona = h('div', {});
  const exportar = h('a', { class: 'btn', href: '#' }, 'Descargar CSV');
  function consulta() {
    const p = new URLSearchParams();
    if (tipo.value) p.set('tipo', tipo.value);
    if (ambito.value) p.set('ambito', ambito.value);
    if (desde.value) p.set('desde', desde.value);
    if (hasta.value) p.set('hasta', hasta.value);
    if (anulados.checked) p.set('anulados', '1');
    return p;
  }
  async function cargar() {
    const p = consulta();
    exportar.href = '/api/exportar/movimientos.csv?' + p;
    p.set('limite', '300');
    const r = await intentar(() => api('GET', '/movimientos?' + p));
    if (!r) return;
    zona.replaceChildren(tablaMovimientos(r.filas), h('div', { class: 'small muted', style: 'margin-top:10px' }, r.total > r.filas.length ? `Mostrando los ${r.filas.length} más recientes de ${r.total}. Usá los filtros o descargá el CSV.` : `${r.total} movimientos`));
  }
  for (const c of [tipo, ambito, desde, hasta, anulados]) c.addEventListener('change', cargar);
  await cargar();
  return [
    h('div', { class: 'fila entre' }, h('h1', {}, 'Movimientos'), h('div', { class: 'fila' }, exportar, esAdmin() && h('button', { class: 'pri', onclick: () => abrirMovimiento('pago') }, 'Registrar'))),
    h('div', { class: 'panel' }, h('div', { class: 'fila' }, h('div', { class: 'grow' }, campo('Tipo', tipo)), h('div', { class: 'grow' }, campo('Ámbito', ambito)), h('div', { class: 'grow' }, campo('Desde', desde)), h('div', { class: 'grow' }, campo('Hasta', hasta))), h('label', { class: 'check' }, anulados, 'Mostrar anulados'), h('div', { style: 'margin-top:12px' }, zona)),
  ];
}

// ---------- Informe y devengamiento ----------
function periodoAnterior(hoy) {
  let a = Number(hoy.slice(0, 4));
  let m = Number(hoy.slice(5, 7)) - 1;
  if (m === 0) (m = 12), a--;
  return `${a}-${String(m).padStart(2, '0')}`;
}

async function vistaInforme() {
  const per = h('input', { type: 'month', value: periodoAnterior(S.hoy), max: S.hoy.slice(0, 7) });
  const zona = h('div', {});
  const linea = (et, val) => h('tr', {}, h('td', {}, et), h('td', { class: 'num' }, val));
  async function cargar() {
    if (!per.value) return;
    const i = await intentar(() => api('GET', '/informe?periodo=' + per.value));
    if (!i) return;
    zona.replaceChildren(
      h(
        'div',
        { class: 'panel informe' },
        h('h2', {}, `Informe de Tesorería — ${nombrePeriodo(i.periodo)}`),
        h('p', {}, i.logia, i.venerable ? h('span', {}, h('br'), `Al V.·.M.·. ${i.venerable}`) : null),
        h('table', {}, h('tbody', {}, linea('Ingresos del mes', plata(i.ingresos)), linea(`   de los cuales, pagos de cuotas (${i.pagos.n})`, plata(i.pagos.total)), linea('Egresos del mes', plata(i.egresos)), linea('Resultado del mes', spanSaldo(i.resultado)), linea('Caja al cierre', h('strong', {}, plata(i.caja))), linea('Saco de la Viuda al cierre', plata(i.saco)), linea('Deuda total de miembros al cierre', plata(i.deuda)))),
        i.detalle.length ? [h('h3', {}, 'Otros ingresos y egresos'), h('table', {}, h('tbody', {}, i.detalle.map((v) => h('tr', {}, h('td', {}, fecha(v.fecha)), h('td', {}, v.concepto), h('td', { class: 'num' }, spanSaldo(v.efecto_caja))))))] : null,
        h('h3', {}, `Miembros con deuda mayor a ${i.umbral} cuotas`),
        i.deudores.length ? h('table', {}, h('tbody', {}, i.deudores.map((d) => h('tr', {}, h('td', {}, `Q.·.H.·. ${d.nombre}${d.baja ? ' (Dimisión con deuda)' : ''}`), h('td', { class: 'num' }, plata(d.deuda)))))) : h('p', { class: 'muted' }, 'Ninguno.'),
        h('p', { class: 'firma' }, i.tesorero, h('br'), 'Tesorero')
      )
    );
  }
  per.addEventListener('change', cargar);
  await cargar();

  const perDev = h('input', { type: 'month', value: S.hoy.slice(0, 7), max: S.hoy.slice(0, 7) });
  const devengar = () =>
    intentar(async () => {
      if (!perDev.value) return;
      if (!confirm(`¿Devengar la cuota de ${nombrePeriodo(perDev.value)} a todos los miembros activos? Los que ya la tengan devengada se saltean.`)) return;
      const r = await api('POST', '/devengar', { periodo: perDev.value });
      toast(r.devengados ? `${r.devengados} cuotas devengadas por ${plata(r.total)}` : 'No había nada para devengar: ese mes ya estaba devengado');
    });

  return [
    h('h1', { class: 'no-print' }, 'Informe mensual'),
    esAdmin() &&
      h(
        'div',
        { class: 'panel no-print' },
        h('h2', {}, 'Devengar cuotas'),
        h('p', { class: 'small muted' }, S.cfg.devengo_auto === '1' ? `El devengamiento automático está activado: corre el día ${S.cfg.dia_devengo} de cada mes.` : 'El devengamiento automático está desactivado. Podés activarlo en Configuración.'),
        h('div', { class: 'fila' }, h('div', { style: 'flex:0 0 190px' }, perDev), h('button', { onclick: devengar }, 'Devengar cuotas'))
      ),
    h('div', { class: 'panel no-print' }, h('div', { class: 'fila' }, h('div', { style: 'flex:0 0 190px' }, per), h('button', { class: 'pri', onclick: () => window.print() }, 'Imprimir / guardar PDF'))),
    zona,
  ];
}

// ---------- Configuración ----------
async function vistaConfig() {
  const partes = [h('h1', {}, 'Configuración')];
  const c = S.cfg;

  if (esAdmin()) {
    const ctl = {
      nombre_logia: h('input', { value: c.nombre_logia }),
      venerable: h('input', { value: c.venerable }),
      tesorero: h('input', { value: c.tesorero }),
      cuota_base: h('input', { inputmode: 'decimal', value: (Number(c.cuota_base) / 100).toFixed(2).replace('.', ',') }),
      dia_devengo: h('input', { type: 'number', min: 1, max: 28, value: c.dia_devengo }),
      umbral_art201: h('input', { inputmode: 'decimal', value: c.umbral_art201 }),
      umbral_informe: h('input', { inputmode: 'decimal', value: c.umbral_informe }),
      plantilla_aviso: h('textarea', {}, c.plantilla_aviso),
    };
    const auto = h('input', { type: 'checkbox' });
    auto.checked = c.devengo_auto === '1';
    const mailDev = h('input', { type: 'checkbox' });
    mailDev.checked = c.mail_devengo === '1';
    partes.push(
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, 'General'),
        formulario(
          [
            campo('Nombre de la logia', ctl.nombre_logia),
            h('div', { class: 'dos' }, campo('Venerable Maestro', ctl.venerable), campo('Tesorero', ctl.tesorero)),
            h('div', { class: 'dos' }, campo('Valor de la cuota ($)', ctl.cuota_base), campo('Día del mes para devengar (1 a 28)', ctl.dia_devengo)),
            h('div', { class: 'dos' }, campo('Art. 201 a partir de (cuotas adeudadas)', ctl.umbral_art201), campo('Listar en el informe deudas mayores a (cuotas)', ctl.umbral_informe)),
            h('label', { class: 'check', style: 'margin-top:14px' }, auto, 'Devengar las cuotas automáticamente cada mes'),
            h('label', { class: 'check' }, mailDev, `Enviar mail a cada miembro al devengar${S.mail ? '' : ' (requiere configurar SMTP en el servidor)'}`),
            campo('Texto del aviso (WhatsApp y mail)', ctl.plantilla_aviso),
            h('div', { class: 'small muted' }, 'Variables: <nompila> <saldo> <favcon> <tesorero> <logia>'),
          ],
          h('button', { type: 'submit', class: 'pri' }, 'Guardar'),
          async () => {
            const b = { devengo_auto: auto.checked ? '1' : '0', mail_devengo: mailDev.checked ? '1' : '0' };
            for (const [k, el] of Object.entries(ctl)) b[k] = el.value;
            b.umbral_art201 = b.umbral_art201.replace(',', '.');
            b.umbral_informe = b.umbral_informe.replace(',', '.');
            await api('PUT', '/config', b);
            toast('Configuración guardada');
            render();
          }
        )
      )
    );

    // Categorías
    const cats = await api('GET', '/categorias');
    const base = Number(c.cuota_base);
    const editarCat = (cat) => {
      const n = h('input', { required: true, value: cat?.nombre || '' });
      const p = h('input', { required: true, inputmode: 'decimal', value: cat ? String(cat.porcentaje).replace('.', ',') : '' });
      const f = formulario([campo('Nombre', n), campo('Porcentaje de la cuota (%)', p)], h('button', { type: 'submit', class: 'pri' }, 'Guardar'), async () => {
        const b = { nombre: n.value, porcentaje: p.value };
        await (cat ? api('PUT', `/categorias/${cat.id}`, b) : api('POST', '/categorias', b));
        d.close();
        render();
      });
      const d = dialogo(cat ? 'Editar categoría' : 'Nueva categoría', f);
      n.focus();
    };
    partes.push(
      h(
        'div',
        { class: 'panel' },
        h('div', { class: 'fila entre' }, h('h2', {}, 'Categorías de cuota'), h('button', { class: 'chico', onclick: () => editarCat() }, 'Nueva')),
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Categoría'), h('th', { class: 'num' }, '%'), h('th', { class: 'num' }, 'Cuota'), h('th', { class: 'num' }, 'Miembros'), h('th', {}))),
          h(
            'tbody',
            {},
            cats.map((cat) =>
              h(
                'tr',
                {},
                h('td', {}, cat.nombre),
                h('td', { class: 'num' }, Number(cat.porcentaje.toFixed(2)).toLocaleString('es-AR')),
                h('td', { class: 'num' }, plata(Math.round((base / 100) * (cat.porcentaje / 100)) * 100)),
                h('td', { class: 'num' }, cat.miembros),
                h('td', { class: 'num' }, h('button', { class: 'chico', onclick: () => editarCat(cat) }, 'Editar'), ' ', cat.miembros === 0 && h('button', { class: 'chico peligro', onclick: () => intentar(async () => (await api('DELETE', `/categorias/${cat.id}`), render())) }, 'Borrar'))
              )
            )
          )
        )
      )
    );

    // Usuarios
    const us = await api('GET', '/usuarios');
    const nuevoUsuario = () => {
      const n = h('input', { required: true });
      const e = h('input', { type: 'email', required: true });
      const r = h('select', {}, h('option', { value: 'lectura' }, 'Solo lectura'), h('option', { value: 'admin' }, 'Administrador'));
      const p = h('input', { type: 'password', required: true, minlength: 10, autocomplete: 'new-password' });
      const f = formulario([campo('Nombre', n), campo('Mail', e), campo('Permisos', r), campo('Contraseña (mínimo 10 caracteres)', p)], h('button', { type: 'submit', class: 'pri' }, 'Crear usuario'), async () => {
        await api('POST', '/usuarios', { nombre: n.value, email: e.value, rol: r.value, clave: p.value });
        d.close();
        render();
      });
      const d = dialogo('Nuevo usuario', f);
      n.focus();
    };
    partes.push(
      h(
        'div',
        { class: 'panel' },
        h('div', { class: 'fila entre' }, h('h2', {}, 'Usuarios'), h('button', { class: 'chico', onclick: nuevoUsuario }, 'Nuevo')),
        h(
          'table',
          {},
          h(
            'tbody',
            {},
            us.map((u) =>
              h(
                'tr',
                {},
                h('td', {}, u.nombre, h('div', { class: 'small muted' }, u.email)),
                h('td', {}, h('span', { class: 'chip' }, u.rol === 'admin' ? 'Administrador' : 'Solo lectura')),
                h('td', { class: 'num' }, u.id !== S.yo.id && h('button', { class: 'chico peligro', onclick: () => intentar(async () => confirm(`¿Eliminar el usuario ${u.email}?`) && (await api('DELETE', `/usuarios/${u.id}`), render())) }, 'Eliminar'))
              )
            )
          )
        )
      )
    );
  }

  // Contraseña propia
  const actual = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const nueva = h('input', { type: 'password', required: true, minlength: 10, autocomplete: 'new-password' });
  partes.push(
    h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'Mi contraseña'),
      formulario([h('div', { class: 'dos' }, campo('Contraseña actual', actual), campo('Nueva (mínimo 10 caracteres)', nueva))], h('button', { type: 'submit' }, 'Cambiar contraseña'), async () => {
        await api('POST', '/yo/clave', { actual: actual.value, nueva: nueva.value });
        actual.value = nueva.value = '';
        toast('Contraseña cambiada');
      })
    )
  );

  if (esAdmin()) {
    partes.push(
      h('div', { class: 'panel' }, h('h2', {}, 'Respaldo'), h('p', { class: 'small muted' }, 'Descarga una copia completa de la base de datos. Conviene hacerlo una vez por mes y guardarla fuera del servidor.'), h('a', { class: 'btn', href: '/api/respaldo' }, 'Descargar respaldo')),
      panelImportar()
    );
  }
  return partes;
}

function panelImportar() {
  const archivo = h('input', { type: 'file', accept: '.csv,text/csv' });
  const zona = h('div', {});
  archivo.addEventListener('change', async () => {
    zona.replaceChildren();
    const f = archivo.files[0];
    if (!f) return;
    const csv = await f.text();
    const a = await intentar(() => api('POST', '/importar/analizar', { csv }));
    if (!a) return;
    const coincide = a.deuda_planilla === a.deuda_importada;
    zona.replaceChildren(
      h('table', {}, h('tbody', {}, [['Miembros', `${a.miembros} (${a.activos} activos, ${a.bajas} bajas)`], ['Caja', plata(a.caja)], ['Saco de la Viuda', plata(a.saco)], ['Cuota', plata(a.cuota_base)], ['Deuda de miembros', `${plata(a.deuda_importada)} ${coincide ? '(coincide con la planilla)' : `— la planilla dice ${plata(a.deuda_planilla)}`}`]].map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', { class: 'num' }, v))))),
      a.duplicados.length ? h('div', { class: 'aviso' }, 'Posibles duplicados (mismo mail). Se importan los dos; después podés unirlos con "Fusionar":', h('ul', {}, a.duplicados.map((d) => h('li', {}, d)))) : null,
      h(
        'button',
        {
          class: 'pri',
          style: 'margin-top:12px',
          onclick: () =>
            intentar(async () => {
              if (!confirm(`¿Importar ${a.miembros} miembros con sus saldos actuales?`)) return;
              await api('POST', '/importar', { csv });
              toast('Importación completa');
              location.hash = '#/';
            }),
        },
        'Importar'
      )
    );
  });
  return h(
    'div',
    { class: 'panel' },
    h('h2', {}, 'Importar desde la planilla'),
    h('p', { class: 'small muted' }, 'Solo funciona con el sistema vacío. En Google Sheets abrí la hoja "Resumen" → Archivo → Descargar → Valores separados por comas (.csv) y elegí ese archivo acá. Se traen el padrón, las categorías, la cuota y el saldo actual de cada miembro, de la caja y del Saco.'),
    archivo,
    zona
  );
}

iniciar();
