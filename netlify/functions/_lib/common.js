/* CentralbotAr — utilidades comunes de las funciones de servidor — v1.0 — 2026-11-17
   (carpeta _lib: no es una función, solo la usan las demás) */
const admin = require("firebase-admin");
const crypto = require("crypto");

const TZ = "America/Argentina/Buenos_Aires";
const ADMIN_EMAIL = "rgaraventa@gmail.com";
const GRAPH = "https://graph.facebook.com/v21.0";

// Límites por defecto (si el negocio no tiene los suyos en features)
const LIMITES = { limiteMensajesMes: 200, limiteEnviosMes: 30 };

function init() {
  if (!admin.apps.length) {
    const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_B64 || "").replace(/\s/g, "");
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(Buffer.from(raw, "base64").toString("utf8"))) });
  }
  return admin;
}

/* ───────── CORS (solo para las funciones que llama el panel) ───────── */
function origenesPermitidos() {
  const extra = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return ["https://centralbotar.raventechsapp.com", "https://magnificent-jalebi-8408d5.netlify.app", "http://localhost:8888"].concat(extra);
}
function corsHeaders(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || "";
  const h = {
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (origenesPermitidos().includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
function resp(event, status, obj) {
  return { statusCode: status, headers: Object.assign({ "Content-Type": "application/json" }, corsHeaders(event)), body: JSON.stringify(obj) };
}

/* ───────── Autenticación del panel ───────── */
// Devuelve { uid, email, esAdmin, negocioId, rol } o lanza { status, error }
async function verificarUsuario(event, negocioIdPedido) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || "";
  const m = auth.match(/^Bearer (.+)$/);
  if (!m) throw { status: 401, error: "sin_sesion" };
  let dec;
  try { dec = await admin.auth().verifyIdToken(m[1]); } catch (e) { throw { status: 401, error: "sesion_invalida" }; }
  const esAdmin = !!(dec.email && dec.email.toLowerCase() === ADMIN_EMAIL && dec.email_verified === true);
  const uSnap = await admin.firestore().collection("usuarios").doc(dec.uid).get();
  const u = uSnap.exists ? uSnap.data() : {};
  const negocioId = u.negocioId || null;
  if (negocioIdPedido && negocioId !== negocioIdPedido && !esAdmin) throw { status: 403, error: "negocio_ajeno" };
  return { uid: dec.uid, email: dec.email || "", esAdmin, negocioId: negocioIdPedido || negocioId, rol: u.rolNegocio || null };
}

/* ───────── Fechas y contadores mensuales ───────── */
function partesAR(fecha) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const o = {};
  f.formatToParts(fecha || new Date(Date.now())).forEach(p => { o[p.type] = p.value; });
  const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { anio: o.year, mes: o.month, dia: o.day, hora: parseInt(o.hour, 10) % 24, min: parseInt(o.minute, 10), diaSemana: dias[o.weekday] };
}
function mesClave(fecha) { const p = partesAR(fecha); return p.anio + "-" + p.mes; }

// ¿Estamos dentro del horario de atención del negocio? (horario = {activo, dias:[0-6], desde:"09:00", hasta:"18:00"})
function enHorario(horario, fecha) {
  if (!horario || !horario.activo) return false;      // sin horario cargado: se considera "fuera de horario" (el bot atiende todo)
  const p = partesAR(fecha);
  if (Array.isArray(horario.dias) && horario.dias.length && !horario.dias.includes(p.diaSemana)) return false;
  const aMin = s => { const m = String(s || "").match(/^(\d{1,2}):(\d{2})$/); return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null; };
  const d = aMin(horario.desde), h = aMin(horario.hasta), ahora = p.hora * 60 + p.min;
  if (d === null || h === null) return false;
  return ahora >= d && ahora < h;
}

// Reserva "cantidad" de un contador mensual (mensajesEsteMes / enviosEsteMes). Reinicia solo al cambiar de mes.
async function reservarContador(negRef, campo, cantidad, limiteDefault) {
  const db = admin.firestore();
  return db.runTransaction(async tx => {
    const s = await tx.get(negRef);
    const n = s.data() || {};
    const mes = mesClave();
    let mensajes = n.mensajesEsteMes || 0, envios = n.enviosEsteMes || 0;
    if (n.mesClave !== mes) { mensajes = 0; envios = 0; }
    const limiteCampo = campo === "mensajesEsteMes" ? "limiteMensajesMes" : "limiteEnviosMes";
    const limite = (n.features && n.features[limiteCampo]) != null ? n.features[limiteCampo] : limiteDefault;
    const actual = campo === "mensajesEsteMes" ? mensajes : envios;
    const disponible = Math.max(0, limite - actual);
    const reservado = Math.min(cantidad, disponible);
    const nuevo = actual + reservado;
    const upd = { mesClave: mes, mensajesEsteMes: mensajes, enviosEsteMes: envios };
    upd[campo] = nuevo;
    tx.update(negRef, upd);
    return { reservado, disponible, limite, usado: nuevo };
  });
}
async function devolverContador(negRef, campo, cantidad) {
  if (!cantidad) return;
  await negRef.update({ [campo]: admin.firestore.FieldValue.increment(-cantidad) });
}

/* ───────── Meta (WhatsApp Cloud API) ───────── */
async function graphPost(token, phoneNumberId, payload) {
  try {
    const r = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(Object.assign({ messaging_product: "whatsapp" }, payload)),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: (j.error && (j.error.message || j.error.code)) || ("http_" + r.status), codigo: j.error && j.error.code };
    return { ok: true, id: j.messages && j.messages[0] && j.messages[0].id };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}
function enviarTexto(token, phoneNumberId, to, texto) {
  return graphPost(token, phoneNumberId, { to, type: "text", text: { body: texto } });
}
function enviarPlantilla(token, phoneNumberId, to, nombre, idioma, parametros) {
  const template = { name: nombre, language: { code: idioma || "es_AR" } };
  if (parametros && parametros.length) template.components = [{ type: "body", parameters: parametros.map(t => ({ type: "text", text: String(t).slice(0, 1000) })) }];
  return graphPost(token, phoneNumberId, { to, type: "template", template });
}
function firmaValida(rawBody, header, secreto) {
  if (!secreto || !header) return false;
  const esperado = "sha256=" + crypto.createHmac("sha256", secreto).update(rawBody).digest("hex");
  const a = Buffer.from(esperado), b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ───────── Líneas (números de WhatsApp) ───────── */
// Busca la línea por phoneNumberId. Primero el índice nuevo; si no está, la conexión vieja (v0.2: negocio.whatsapp).
async function buscarLineaPorPhone(phoneNumberId) {
  const db = admin.firestore();
  const idx = await db.collection("lineasIndex").doc(String(phoneNumberId)).get();
  if (idx.exists) return cargarLinea(idx.data().negocioId, String(phoneNumberId));
  const q = await db.collection("negocios").where("whatsapp.phoneNumberId", "==", String(phoneNumberId)).limit(1).get();
  if (q.empty) return null;
  const d = q.docs[0], n = d.data();
  return { negocioId: d.id, negRef: d.ref, neg: n, lineaId: String(phoneNumberId), phoneNumberId: String(phoneNumberId), token: n.whatsapp.token, verifyToken: n.whatsapp.verifyToken, appSecret: null, legacy: true };
}
async function cargarLinea(negocioId, lineaId) {
  const db = admin.firestore();
  const negRef = db.collection("negocios").doc(negocioId);
  const negSnap = await negRef.get();
  if (!negSnap.exists) return null;
  const neg = negSnap.data();
  if (lineaId) {
    const sec = await negRef.collection("secretos").doc(String(lineaId)).get();
    if (sec.exists) {
      const s = sec.data();
      return { negocioId, negRef, neg, lineaId: String(lineaId), phoneNumberId: String(lineaId), token: s.token, verifyToken: s.verifyToken, appSecret: s.appSecret || null, legacy: false };
    }
  }
  // conexión vieja (v0.2) como respaldo
  if (neg.whatsapp && neg.whatsapp.token && (!lineaId || String(neg.whatsapp.phoneNumberId) === String(lineaId))) {
    return { negocioId, negRef, neg, lineaId: String(neg.whatsapp.phoneNumberId), phoneNumberId: String(neg.whatsapp.phoneNumberId), token: neg.whatsapp.token, verifyToken: neg.whatsapp.verifyToken, appSecret: null, legacy: true };
  }
  return null;
}

function limpiarTelefono(t) { return String(t || "").replace(/\D/g, ""); }

module.exports = {
  admin, init, TZ, ADMIN_EMAIL, LIMITES, corsHeaders, resp, verificarUsuario, partesAR, mesClave, enHorario,
  reservarContador, devolverContador, enviarTexto, enviarPlantilla, graphPost, firmaValida,
  buscarLineaPorPhone, cargarLinea, limpiarTelefono,
};
