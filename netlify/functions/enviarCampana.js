/* CentralbotAr — envío de campañas con plantillas — v1.0 — 2026-11-17
   Dos pasos, los dos los llama el panel con la sesión del dueño:
   - accion "iniciar": arma la lista de destinatarios (solo contactos con consentimiento, sin baja, con la etiqueta elegida),
     reserva el cupo mensual de envíos (tope por negocio) y deja la campaña en "enviando".
   - accion "lote": envía hasta 12 destinatarios pendientes y devuelve cuántos faltan. El panel lo repite hasta terminar.
   Cada destinatario se "reclama" en una transacción, así que repetir o abrir dos pestañas no duplica envíos. */
const C = require("./_lib/common");
const LOTE = 12;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: C.corsHeaders(event), body: "" };
  if (event.httpMethod !== "POST") return C.resp(event, 405, { error: "metodo" });
  C.init();
  let b; try { b = JSON.parse(event.body || "{}"); } catch (e) { return C.resp(event, 400, { error: "json" }); }
  try {
    const u = await C.verificarUsuario(event, b.negocioId);
    if (!u.esAdmin && u.rol !== "owner") return C.resp(event, 403, { error: "solo_dueño" });
    const db = C.admin.firestore();
    const negRef = db.collection("negocios").doc(u.negocioId);
    const negSnap = await negRef.get();
    if (!negSnap.exists) return C.resp(event, 404, { error: "negocio_no_existe" });
    const neg = negSnap.data();
    if (neg.banned === true) return C.resp(event, 403, { error: "cuenta_bloqueada" });
    // prueba vencida: no se envía (el admin y los clientes con demoHasta = null no tienen vencimiento)
    if (!u.esAdmin && neg.demoHasta && neg.demoHasta.toMillis && neg.demoHasta.toMillis() < Date.now()) return C.resp(event, 402, { error: "prueba_vencida" });

    const cRef = negRef.collection("campanas").doc(String(b.campanaId || "_"));
    const cSnap = await cRef.get();
    if (!cSnap.exists) return C.resp(event, 404, { error: "campana_no_existe" });
    const camp = cSnap.data();
    if (camp._demo) return C.resp(event, 400, { error: "campana_de_practica" });

    if (b.accion === "iniciar") return await iniciar(event, db, negRef, cRef, camp, u);
    if (b.accion === "lote") return await lote(event, db, negRef, cRef, camp);
    return C.resp(event, 400, { error: "accion" });
  } catch (e) {
    if (e && e.status) return C.resp(event, e.status, { error: e.error });
    console.error("enviarCampana:", e);
    return C.resp(event, 500, { error: "interno" });
  }
};

async function iniciar(event, db, negRef, cRef, camp, u) {
  const F = C.admin.firestore.FieldValue;
  if (camp.estado !== "borrador") return C.resp(event, 409, { error: "ya_iniciada" });
  const pSnap = await negRef.collection("plantillas").doc(String(camp.plantillaId || "_")).get();
  if (!pSnap.exists) return C.resp(event, 400, { error: "plantilla_no_existe" });
  if (pSnap.data().estado !== "aprobada") return C.resp(event, 400, { error: "plantilla_no_aprobada" });
  const linea = await C.cargarLinea(u.negocioId, camp.lineaId || null);
  if (!linea) return C.resp(event, 409, { error: "linea_sin_conectar" });

  let q = negRef.collection("contactos");
  const snap = camp.etiqueta ? await q.where("etiquetas", "array-contains", camp.etiqueta).get() : await q.limit(5000).get();
  const elegibles = [];
  snap.docs.forEach(d => {
    const c = d.data();
    if (c._demo || c.baja === true) return;
    if (!c.consentimiento || c.consentimiento.estado !== "si") return;
    const tel = C.limpiarTelefono(c.telefono || d.id);
    if (tel.length < 10) return;
    elegibles.push({ tel, nombre: c.nombre || "" });
  });
  if (!elegibles.length) return C.resp(event, 400, { error: "sin_destinatarios" });

  const cupo = await C.reservarContador(negRef, "enviosEsteMes", elegibles.length, C.LIMITES.limiteEnviosMes);
  if (cupo.reservado < 1) return C.resp(event, 429, { error: "tope_mensual", limite: cupo.limite, usado: cupo.usado });
  const lista = elegibles.slice(0, cupo.reservado);

  for (let i = 0; i < lista.length; i += 400) {
    const batch = db.batch();
    lista.slice(i, i + 400).forEach(d => batch.set(cRef.collection("destinatarios").doc(d.tel), { telefono: d.tel, nombre: d.nombre, estado: "pendiente" }));
    await batch.commit();
  }
  await cRef.update({ estado: "enviando", total: lista.length, enviados: 0, fallidos: 0, entregados: 0, leidos: 0, omitidosPorTope: elegibles.length - lista.length, reservado: lista.length, iniciadaEn: F.serverTimestamp(), iniciadaPor: u.uid });
  return C.resp(event, 200, { ok: true, total: lista.length, omitidosPorTope: elegibles.length - lista.length });
}

async function lote(event, db, negRef, cRef, camp) {
  const F = C.admin.firestore.FieldValue;
  if (camp.estado !== "enviando") return C.resp(event, 409, { error: "no_esta_enviando", estado: camp.estado });
  const pSnap = await negRef.collection("plantillas").doc(String(camp.plantillaId)).get();
  const plant = pSnap.data();
  const linea = await C.cargarLinea(negRef.id, camp.lineaId || null);
  if (!linea) return C.resp(event, 409, { error: "linea_sin_conectar" });

  const pend = await cRef.collection("destinatarios").where("estado", "==", "pendiente").limit(LOTE).get();
  let ok = 0, mal = 0, omitidos = 0, ultimoError = null;
  for (const d of pend.docs) {
    // reclamar el destinatario (nadie más lo envía)
    const reclamado = await db.runTransaction(async tx => {
      const s = await tx.get(d.ref);
      if (!s.exists || s.data().estado !== "pendiente") return false;
      tx.update(d.ref, { estado: "enviando" });
      return true;
    });
    if (!reclamado) continue;
    const dest = d.data();
    // no escribirle a quien se dio de baja mientras tanto
    const ct = await negRef.collection("contactos").doc(dest.telefono).get();
    if (ct.exists && ct.data().baja === true) { await d.ref.update({ estado: "omitido_baja" }); omitidos++; continue; }

    const params = (plant.vars || []).map(v => v.tipo === "nombre" ? (dest.nombre || "").split(" ")[0] || "cliente" : (v.valor || ""));
    const r = await C.enviarPlantilla(linea.token, linea.phoneNumberId, dest.telefono, plant.nombre, plant.idioma, params);
    if (r.ok) {
      ok++;
      await d.ref.update({ estado: "enviado", wamid: r.id, enviadoEn: F.serverTimestamp() });
      await negRef.collection("envios").doc(r.id).set({ campanaId: cRef.id, telefono: dest.telefono, estado: "sent", creadoEn: F.serverTimestamp() });
    } else {
      mal++; ultimoError = String(r.error || "error");
      await d.ref.update({ estado: "fallido", error: ultimoError });
    }
  }
  if (mal + omitidos) await C.devolverContador(negRef, "enviosEsteMes", mal + omitidos);   // lo que no salió no gasta cupo

  const upd = {};
  if (ok) upd.enviados = F.increment(ok);
  if (mal) { upd.fallidos = F.increment(mal); upd.ultimoError = ultimoError; }
  if (omitidos) upd.omitidosPorBaja = F.increment(omitidos);
  const resto = await cRef.collection("destinatarios").where("estado", "==", "pendiente").limit(1).get();
  const faltan = !resto.empty;
  if (!faltan) { upd.estado = "completa"; upd.finalizadaEn = F.serverTimestamp(); }
  if (Object.keys(upd).length) await cRef.update(upd);
  return C.resp(event, 200, { ok: true, enviados: ok, fallidos: mal, omitidos, terminada: !faltan });
}
