# Tesorería

Sistema web de tesorería y padrón de miembros. Reemplaza la planilla de Google Sheets y el formulario.

- **Un solo contenedor**: Node 24 + Express. La base de datos es un archivo SQLite en `/data`.
- **Sin paso de compilación**: la interfaz es HTML/JS/CSS plano en `public/`.

## Qué hace

| Antes (formulario)                 | Ahora                                                        |
| ---------------------------------- | ------------------------------------------------------------ |
| Ingresar pago de cuotas            | Inicio → Pago de cuotas (muestra saldo, "1 cuota", "Saldar") |
| Ingresar deuda adicional           | Inicio → Deuda adicional                                     |
| Ingresar un gasto / otro ingreso   | Inicio → Gasto / Otro ingreso                                |
| Ingreso / Egreso Saco de la Viuda  | Inicio → Ingreso Saco / Egreso Saco                          |
| Agregar miembro / Baja de miembro  | Miembros → Nuevo miembro / ficha → Dar de baja               |
| Actualizar valor cuota             | Configuración → General                                      |
| Informar nuevo Presidente/Tesorero | Configuración → General                                      |
| Devengar cuotas e Informe Mensual  | Informe (manual) o automático el día configurado             |

Además: anular movimientos, cuenta corriente por miembro, aviso por WhatsApp o mail,
marca de Art. 201, fusión de registros duplicados, usuarios de solo lectura,
exportación a CSV y descarga de respaldo.

## Desplegar en Coolify

1. Subí esta carpeta a un repositorio **privado** de GitHub/GitLab.
2. En Coolify: **New Resource → Application** → elegí el repositorio y la rama.
3. **Build Pack: Dockerfile** (usa el `Dockerfile` de la raíz). Puerto expuesto: `3000`.
4. **Storages → Add → Volume Mount**: destino `/data`. Sin esto, los datos se pierden en cada despliegue.
5. **Environment Variables**:
   - `ADMIN_EMAIL` y `ADMIN_PASSWORD` (mínimo 10 caracteres): crean el primer administrador en el primer arranque.
   - Opcionales para mails: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`.
6. Asigná el dominio (Coolify gestiona HTTPS) y desplegá. El chequeo de salud es `GET /healthz`.
7. Entrá con el administrador y, si querés, cambiá la contraseña en Configuración.
   Después del primer arranque podés borrar `ADMIN_PASSWORD` de las variables.

## Traer los datos de la planilla

1. En Google Sheets abrí la hoja **Resumen** → Archivo → Descargar → **Valores separados por comas (.csv)**.
2. En el sistema: **Configuración → Importar desde la planilla** → elegí el archivo.
3. Revisá la vista previa (caja, deuda y cantidad de miembros deben coincidir con la planilla) y confirmá.

Se importan el padrón, las categorías, el valor de la cuota y el **saldo actual** de cada miembro,
de la caja y del Saco como "saldo inicial". El historial de movimientos anterior no se importa:
queda en la planilla original como archivo.

No subas el CSV al repositorio (el `.gitignore` ya excluye `*.csv`).

## Llevar los datos de una instalación a otra

Para pasar los datos de la copia local al servidor (o al revés):

1. En la instalación de origen: Configuración → **Descargar respaldo** (baja un archivo `.db`).
2. En la instalación de destino, recién desplegada y vacía: Configuración → **Restaurar desde un respaldo** → elegí ese archivo.

Se copian el padrón, las categorías, los movimientos y la configuración. Los usuarios no se copian.

## Reglas de negocio

- **Cambio de cuota:** al cambiar el valor de la cuota, la deuda pendiente de cada miembro se actualiza
  en la misma proporción (quien debía 3 cuotas sigue debiendo 3 cuotas). Los saldos a favor quedan en pesos.
- **Categorías reducidas:** su cuota se redondea siempre a $100.
- **Devengamiento:** no se duplica para un mismo mes, y no vuelve a cargar la cuota a quien se le anuló
  a mano (por ejemplo, porque el mes lo cubría la iniciación).
- **Aranceles** (iniciación, aumento de salario, exaltación): se cargan como "Otro ingreso" con el nombre
  del miembro en el concepto; no pasan por su cuenta de cuotas.

## Desarrollo local

```bash
npm install
ADMIN_EMAIL=yo@ejemplo.com ADMIN_PASSWORD=una-clave-larga npm run dev
```

Abre en http://localhost:3000. Los datos quedan en `./data/tesoreria.db`.

## Respaldo

Configuración → **Descargar respaldo** baja una copia del archivo SQLite.
Para restaurar: detené la aplicación, reemplazá `/data/tesoreria.db` por el respaldo
(borrando `tesoreria.db-wal` y `tesoreria.db-shm` si existen) y volvé a iniciarla.

## Cómo se guardan los números

Cada movimiento tiene tres efectos, en centavos: sobre la caja, sobre el Saco de la Viuda
y sobre la cuenta del miembro. Los saldos son siempre la suma de los movimientos no anulados;
no hay totales guardados que puedan desincronizarse.
