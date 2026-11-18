// Envío de mails opcional. Solo se activa si están definidas las variables SMTP_*.
import nodemailer from 'nodemailer';

let transporte = null;

export function mailConfigurado() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

function obtener() {
  if (!mailConfigurado()) return null;
  if (!transporte) {
    const puerto = Number(process.env.SMTP_PORT || 587);
    transporte = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: puerto,
      secure: puerto === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transporte;
}

/** Envía un mail. Devuelve true si salió, false si no hay SMTP o falló. */
export async function enviar(para, asunto, texto) {
  const t = obtener();
  if (!t || !para) return false;
  try {
    await t.sendMail({ from: process.env.SMTP_FROM, to: para, subject: asunto, text: texto });
    return true;
  } catch (e) {
    console.error(`[mail] No se pudo enviar a ${para}: ${e.message}`);
    return false;
  }
}
