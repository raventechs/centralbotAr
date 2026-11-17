/* CentralbotAr — «¿quién soy?» — v1.0 — 2026-11-17
   El panel pregunta acá si la cuenta es la del administrador. Se decide en el servidor con el mail verificado.
   Si lo es, se le pone la marca "admin" a su sesión (las reglas de Firestore la usan, sin depender de que el token traiga el correo). */
const C = require("./_lib/common");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: C.corsHeaders(event), body: "" };
  if (event.httpMethod !== "POST") return C.resp(event, 405, { error: "metodo" });
  C.init();
  try {
    const u = await C.verificarUsuario(event, null);
    let refrescar = false;
    if (u.esAdmin) {
      const rec = await C.admin.auth().getUser(u.uid);
      if (!(rec.customClaims && rec.customClaims.admin === true)) {
        await C.admin.auth().setCustomUserClaims(u.uid, Object.assign({}, rec.customClaims || {}, { admin: true }));
        refrescar = true;
      }
    }
    return C.resp(event, 200, { ok: true, esAdmin: u.esAdmin, rol: u.rol, refrescar });
  } catch (e) {
    if (e && e.status) return C.resp(event, e.status, { error: e.error });
    console.error("quienSoy:", e);
    return C.resp(event, 500, { error: "interno" });
  }
};
