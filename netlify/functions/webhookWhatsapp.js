const admin = require("firebase-admin");

if (!admin.apps.length) {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_B64 || "").replace(/\s/g, "");
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(Buffer.from(raw, "base64").toString("utf8"))) });
}
const db = admin.firestore();

exports.handler = async (event) => {
  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters || {};
    const negocioId = params["negocioId"];
    if (!negocioId) return { statusCode: 400, body: "Falta negocioId en la URL" };
    const negSnap = await db.collection("negocios").doc(negocioId).get();
    if (!negSnap.exists) return { statusCode: 404, body: "Negocio no encontrado" };
    if (params["hub.verify_token"] === negSnap.data().whatsapp?.verifyToken) {
      return { statusCode: 200, body: params["hub.challenge"] };
    }
    return { statusCode: 403, body: "Verificación fallida" };
  }

  if (event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");
      const value = body.entry?.[0]?.changes?.[0]?.value;
      const msg = value?.messages?.[0];
      if (!msg) return { statusCode: 200, body: "ok" };

      const phoneNumberId = value.metadata?.phone_number_id;
      const negQuery = await db.collection("negocios").where("whatsapp.phoneNumberId", "==", phoneNumberId).limit(1).get();
      if (negQuery.empty) { console.error("Negocio no encontrado para", phoneNumberId); return { statusCode: 200, body: "ok" }; }
      const negDoc = negQuery.docs[0];
      const negocio = negDoc.data();

      if ((negocio.mensajesEsteMes || 0) >= (negocio.features?.limiteMensajesMes || 200)) {
        console.warn("Negocio", negDoc.id, "alcanzó su límite mensual");
        return { statusCode: 200, body: "ok" };
      }

      const telefono = msg.from;
      const texto = msg.text?.body || "[mensaje no soportado: " + msg.type + "]";
      const convRef = negDoc.ref.collection("conversaciones").doc(telefono);
      const convSnap = await convRef.get();

      await convRef.set({
        nombre: value.contacts?.[0]?.profile?.name || telefono,
        estado: convSnap.exists ? (convSnap.data().estado || "nuevo") : "nuevo",
        modoManual: convSnap.exists ? convSnap.data().modoManual : false,
        ultimoMensaje: texto,
        ultimoMensajeFecha: admin.firestore.FieldValue.serverTimestamp(),
        creadoEn: convSnap.exists ? convSnap.data().creadoEn : admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      await convRef.collection("mensajes").add({ texto, autor: "cliente", timestamp: admin.firestore.FieldValue.serverTimestamp() });
      await negDoc.ref.update({ mensajesEsteMes: admin.firestore.FieldValue.increment(1) });

      if ((await convRef.get()).data().modoManual) return { statusCode: 200, body: "ok" };

      const respuestaIA = await generarRespuesta(negocio, convRef, texto);
      await enviarMensajeWhatsApp(negocio.whatsapp.token, negocio.whatsapp.phoneNumberId, telefono, respuestaIA);
      await convRef.collection("mensajes").add({ texto: respuestaIA, autor: "bot", timestamp: admin.firestore.FieldValue.serverTimestamp() });
      await convRef.set({ ultimoMensaje: respuestaIA, estado: "respondido_auto" }, { merge: true });

      return { statusCode: 200, body: "ok" };
    } catch (e) {
      console.error("Error en webhook:", e);
      return { statusCode: 200, body: "ok" };
    }
  }
  return { statusCode: 405, body: "Método no permitido" };
};

async function generarRespuesta(negocio, convRef, mensajeNuevo) {
  const historialSnap = await convRef.collection("mensajes").orderBy("timestamp", "desc").limit(10).get();
  const historial = historialSnap.docs.reverse().map(d => ({
    role: d.data().autor === "cliente" ? "user" : "assistant", content: d.data().texto,
  }));
  const infoNegocio = `\n\nPRODUCTOS: ${JSON.stringify(negocio.productos || [])}\nFAQS: ${JSON.stringify(negocio.faqs || [])}`;
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6", max_tokens: 400,
      system: (negocio.systemPrompt || "Sos un asistente de atención al cliente.") + infoNegocio,
      messages: [...historial, { role: "user", content: mensajeNuevo }],
    }),
  });
  const data = await resp.json();
  return data.content?.[0]?.text || "Disculpá, no pude procesar tu mensaje. Ya te contactamos.";
}

async function enviarMensajeWhatsApp(token, phoneNumberId, telefono, texto) {
  await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to: telefono, type: "text", text: { body: texto } }),
  });
}

