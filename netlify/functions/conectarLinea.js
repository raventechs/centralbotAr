/* CentralbotAr — conectar / desconectar un número de WhatsApp (línea) — v1.0 — 2026-11-17
   El token de Meta se guarda en negocios/{id}/secretos/{phoneNumberId}: solo lo lee el servidor (las reglas bloquean todo acceso del panel).
   Antes de guardar, se prueba el token contra Meta; si no sirve, no se guarda nada. */
const C = require("./_lib/common");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: C.corsHeaders(event), body: "" };
  if (event.httpMethod !== "POST") return C.resp(event, 405, { error: "metodo" });
  C.init();
  const db = C.admin.firestore(), F = C.admin.firestore.FieldValue;
  let b; try { b = JSON.parse(event.body || "{}"); } catch (e) { return C.resp(event, 400, { error: "json" }); }
  try {
    const u = await C.verificarUsuario(event, b.negocioId);
    if (!u.esAdmin && u.rol !== "owner") return C.resp(event, 403, { error: "solo_dueño" });
    const negRef = db.collection("negocios").doc(u.negocioId);
    if (!(await negRef.get()).exists) return C.resp(event, 404, { error: "negocio_no_existe" });
    const phoneId = String(b.phoneNumberId || "").replace(/\D/g, "");
    if (!phoneId) return C.resp(event, 400, { error: "falta_phone_number_id" });

    /* ── desconectar ── */
    if (b.accion === "desconectar") {
      await negRef.collection("secretos").doc(phoneId).delete();
      await negRef.collection("lineas").doc(phoneId).delete();
      const idx = await db.collection("lineasIndex").doc(phoneId).get();
      if (idx.exists && idx.data().negocioId === u.negocioId) await idx.ref.delete();
      return C.resp(event, 200, { ok: true });
    }

    /* ── ver los datos del webhook de una línea ya conectada ── */
    if (b.accion === "datos") {
      const sec = await negRef.collection("secretos").doc(phoneId).get();
      if (!sec.exists) return C.resp(event, 404, { error: "linea_no_existe" });
      const base0 = process.env.URL || "https://magnificent-jalebi-8408d5.netlify.app";
      return C.resp(event, 200, { ok: true, webhookUrl: `${base0}/.netlify/functions/webhookWhatsapp?negocioId=${u.negocioId}&linea=${phoneId}`, verifyToken: sec.data().verifyToken });
    }

    /* ── conectar ── */
    const token = String(b.token || "").trim();
    const nombre = String(b.nombre || "").trim().slice(0, 60) || "Mi número";
    if (!token) return C.resp(event, 400, { error: "falta_token" });

    // un mismo número no puede estar en dos negocios
    const idx = await db.collection("lineasIndex").doc(phoneId).get();
    if (idx.exists && idx.data().negocioId !== u.negocioId) return C.resp(event, 409, { error: "numero_en_uso" });

    // probar el token contra Meta
    let display = "", verificado = "";
    try {
      const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}?fields=display_phone_number,verified_name`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return C.resp(event, 400, { error: "token_invalido", detalle: (j.error && j.error.message) || ("http_" + r.status) });
      display = j.display_phone_number || ""; verificado = j.verified_name || "";
    } catch (e) { return C.resp(event, 502, { error: "meta_no_responde" }); }

    // conservar el token de verificación si la línea ya existía (así no hay que tocar Meta de nuevo)
    const secRef = negRef.collection("secretos").doc(phoneId);
    const secSnap = await secRef.get();
    const verifyToken = secSnap.exists && secSnap.data().verifyToken ? secSnap.data().verifyToken : "cba_" + require("crypto").randomBytes(9).toString("hex");
    await secRef.set({ token, verifyToken, actualizado: F.serverTimestamp() }, { merge: true });
    await negRef.collection("lineas").doc(phoneId).set({ nombre, phoneNumberId: phoneId, display, verificado, creadoEn: F.serverTimestamp() }, { merge: true });
    await db.collection("lineasIndex").doc(phoneId).set({ negocioId: u.negocioId });

    // si había una conexión vieja (v0.2) del mismo número, se borra el token que quedaba a la vista en el documento del negocio
    const neg = (await negRef.get()).data() || {};
    if (neg.whatsapp && String(neg.whatsapp.phoneNumberId) === phoneId) await negRef.update({ whatsapp: F.delete() });

    const base = process.env.URL || "https://magnificent-jalebi-8408d5.netlify.app";
    const webhookUrl = `${base}/.netlify/functions/webhookWhatsapp?negocioId=${u.negocioId}&linea=${phoneId}`;
    return C.resp(event, 200, { ok: true, webhookUrl, verifyToken, display, verificado });
  } catch (e) {
    if (e && e.status) return C.resp(event, e.status, { error: e.error });
    console.error("conectarLinea:", e);
    return C.resp(event, 500, { error: "interno" });
  }
};
