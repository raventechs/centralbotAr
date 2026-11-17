/* CentralbotAr — envío manual desde la bandeja — v1.0 — 2026-11-17
   Antes (v0.2) el mensaje solo se guardaba en la base y nunca llegaba al cliente. Ahora se envía de verdad por la API de WhatsApp.
   Regla de Meta: texto libre solo dentro de las 24 h desde el último mensaje del cliente; fuera de esa ventana hay que usar una plantilla (campaña). */
const C = require("./_lib/common");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: C.corsHeaders(event), body: "" };
  if (event.httpMethod !== "POST") return C.resp(event, 405, { error: "metodo" });
  C.init();
  let b; try { b = JSON.parse(event.body || "{}"); } catch (e) { return C.resp(event, 400, { error: "json" }); }
  try {
    const u = await C.verificarUsuario(event, b.negocioId);
    if (!u.esAdmin && !["owner", "agente"].includes(u.rol)) return C.resp(event, 403, { error: "sin_permiso" });
    const texto = String(b.texto || "").trim().slice(0, 4000);
    const convId = String(b.convId || "");
    if (!texto || !convId) return C.resp(event, 400, { error: "faltan_datos" });

    const negRef = C.admin.firestore().collection("negocios").doc(u.negocioId);
    const convRef = negRef.collection("conversaciones").doc(convId);
    const cs = await convRef.get();
    if (!cs.exists) return C.resp(event, 404, { error: "conversacion_no_existe" });
    const conv = cs.data();
    if (conv._demo) return C.resp(event, 400, { error: "conversacion_de_practica" });

    const ult = conv.ultimoMensajeCliente && conv.ultimoMensajeCliente.toMillis ? conv.ultimoMensajeCliente.toMillis() : 0;
    if (Date.now() - ult > 24 * 3600 * 1000) return C.resp(event, 409, { error: "ventana_24h" });

    const linea = await C.cargarLinea(u.negocioId, conv.lineaId || null);
    if (!linea) return C.resp(event, 409, { error: "linea_sin_conectar" });
    const tel = C.limpiarTelefono(conv.telefono || convId.split("_").pop());
    const r = await C.enviarTexto(linea.token, linea.phoneNumberId, tel, texto);
    if (!r.ok) return C.resp(event, 502, { error: "meta", detalle: String(r.error || "") });

    const F = C.admin.firestore.FieldValue;
    await convRef.collection("mensajes").add({ texto, autor: "humano", autorUid: u.uid, timestamp: F.serverTimestamp(), ok: true });
    await convRef.set({ ultimoMensaje: texto, ultimoMensajeFecha: F.serverTimestamp(), estado: "atendido", modoManual: true }, { merge: true });   // cuando una persona contesta, el bot se hace a un lado hasta que se lo devuelvan
    return C.resp(event, 200, { ok: true });
  } catch (e) {
    if (e && e.status) return C.resp(event, e.status, { error: e.error });
    console.error("enviarMensaje:", e);
    return C.resp(event, 500, { error: "interno" });
  }
};
