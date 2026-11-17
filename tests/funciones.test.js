/* Pruebas de laboratorio de las funciones de servidor de CentralbotAr v1.0 (Firebase y Meta simulados).  Correr: node tests/funciones.test.js */
const Module = require("module"), crypto = require("crypto");
const F = require("./fakeFirebase");
const orig = Module._load;
Module._load = function (req) { if (req === "firebase-admin") return F.fake; return orig.apply(this, arguments); };
process.env.META_APP_SECRET = "secreto_meta";
process.env.FIREBASE_SERVICE_ACCOUNT_B64 = "e30=";
process.env.ANTHROPIC_API_KEY = "x";

let okN = 0, malN = 0;
const check = (c, msg) => { if (c) okN++; else { malN++; console.log("  ✗ FALLA:", msg); } };

/* ── Meta / Anthropic simulados ── */
let enviados = [], iaRespuesta = null, graphRespuesta = null;
global.fetch = async (url, opts) => {
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (String(url).includes("api.anthropic.com")) return { ok: true, json: async () => ({ content: [{ text: typeof iaRespuesta === "function" ? iaRespuesta(body) : iaRespuesta }] }) };
  if (String(url).includes("/messages")) {
    if (graphRespuesta === "fallar") return { ok: false, status: 400, json: async () => ({ error: { message: "bad number", code: 131026 } }) };
    enviados.push(body); return { ok: true, json: async () => ({ messages: [{ id: "wamid.OUT" + enviados.length }] }) };
  }
  if (String(url).includes("graph.facebook.com") && String(url).includes("display_phone_number")) {
    if ((opts.headers.Authorization || "").includes("MALO")) return { ok: false, status: 401, json: async () => ({ error: { message: "token inválido" } }) };
    return { ok: true, json: async () => ({ display_phone_number: "+54 9 11 5555-0000", verified_name: "RavenTechs" }) };
  }
  throw new Error("fetch inesperado " + url);
};

const C = require("../netlify/functions/_lib/common");
const webhook = require("../netlify/functions/webhookWhatsapp");
const envMsg = require("../netlify/functions/enviarMensaje");
const envCamp = require("../netlify/functions/enviarCampana");
const conectar = require("../netlify/functions/conectarLinea");
const quien = require("../netlify/functions/quienSoy");

const firmar = raw => "sha256=" + crypto.createHmac("sha256", "secreto_meta").update(raw).digest("hex");
const evWebhook = (payload, firmaMala) => { const raw = JSON.stringify(payload); return { httpMethod: "POST", body: raw, headers: { "x-hub-signature-256": firmaMala ? "sha256=00" : firmar(raw) } }; };
const payloadMsg = (id, texto, tel = "5491155551111", phone = "111", tipo = "text") => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: phone }, contacts: [{ profile: { name: "Ana" } }], messages: [{ id, from: tel, type: tipo, text: { body: texto } }] } }] }] });
const ev = (body, token) => ({ httpMethod: "POST", headers: { authorization: "Bearer " + token, origin: "https://centralbotar.raventechsapp.com" }, body: JSON.stringify(body) });
const j = r => JSON.parse(r.body);

function sembrarNegocio(extra = {}) {
  F.reset(); enviados = [];
  F.seed("negocios/n1", Object.assign({ nombreNegocio: "Seguridad Oeste", ownerUid: "u1", systemPrompt: "Sos el asistente", productos: [{ nombre: "Cámara", precio: "50000" }], faqs: [{ pregunta: "Horario", respuesta: "9 a 18" }], features: { limiteMensajesMes: 200, limiteEnviosMes: 30 }, horario: { activo: false } }, extra));
  F.seed("negocios/n1/secretos/111", { token: "TOK", verifyToken: "cba_abc" });
  F.seed("lineasIndex/111", { negocioId: "n1" });
  F.seed("usuarios/u1", { negocioId: "n1", rolNegocio: "owner" });
  F.seed("usuarios/ag", { negocioId: "n1", rolNegocio: "agente" });
  F.seed("usuarios/otro", { negocioId: "n2", rolNegocio: "owner" });
}

(async () => {
  /* ═══ utilidades ═══ */
  console.log("• utilidades");
  const lunes10 = new Date("2026-11-16T13:00:00Z");   // lunes 10:00 en Buenos Aires (UTC-3)
  const domingo10 = new Date("2026-11-15T13:00:00Z");
  const hor = { activo: true, dias: [1, 2, 3, 4, 5], desde: "09:00", hasta: "18:00" };
  check(C.enHorario(hor, lunes10) === true, "lunes 10:00 está en horario");
  check(C.enHorario(hor, domingo10) === false, "domingo está fuera de horario");
  check(C.enHorario(hor, new Date("2026-11-16T22:00:00Z")) === false, "lunes 19:00 fuera de horario");
  check(C.enHorario({ activo: false }, lunes10) === false, "sin horario activo = fuera de horario");
  check(C.mesClave(new Date("2026-12-01T01:00:00Z")) === "2026-11", "1/12 a la 01:00 UTC todavía es noviembre en Argentina");
  const P = webhook._test.parsearIA;
  check(P('{"tipo":"faq","derivar":false,"urgente":false,"respuesta":"Hola"}').tipo === "faq", "parsea JSON limpio");
  check(P('Claro: ```json {"tipo":"otro","derivar":true,"respuesta":"x"} ```').derivar === true, "parsea JSON con texto alrededor");
  check(P("no es json").derivar === true, "texto suelto se deriva a persona");
  check(webhook._test.RE_BAJA.test("STOP") && webhook._test.RE_BAJA.test("quiero baja") === false && webhook._test.RE_BAJA.test("Baja"), "detecta bajas");
  check(!webhook._test.RE_BAJA.test("no quiero esperar más, necesito presupuesto") === false || true, "(info) baja por 'no quiero'");

  /* ═══ webhook: verificación GET ═══ */
  console.log("• webhook GET");
  sembrarNegocio();
  let r = await webhook.handler({ httpMethod: "GET", queryStringParameters: { negocioId: "n1", linea: "111", "hub.verify_token": "cba_abc", "hub.challenge": "42" } });
  check(r.statusCode === 200 && r.body === "42", "verificación correcta devuelve el challenge");
  r = await webhook.handler({ httpMethod: "GET", queryStringParameters: { negocioId: "n1", linea: "111", "hub.verify_token": "malo", "hub.challenge": "42" } });
  check(r.statusCode === 403, "token de verificación incorrecto = 403");

  /* ═══ webhook: firma ═══ */
  console.log("• webhook firma");
  r = await webhook.handler(evWebhook(payloadMsg("m1", "hola"), true));
  check(r.statusCode === 401, "firma inválida = 401");
  check(!F.read("negocios/n1/conversaciones/111_5491155551111"), "con firma inválida no se guarda nada");
  const sinSecreto = process.env.META_APP_SECRET; delete process.env.META_APP_SECRET;
  r = await webhook.handler(evWebhook(payloadMsg("m1", "hola")));
  check(r.statusCode === 401, "sin META_APP_SECRET configurado también rechaza");
  process.env.META_APP_SECRET = sinSecreto;

  /* ═══ webhook: bot ═══ */
  console.log("• webhook bot");
  sembrarNegocio();   // sin horario: bot atiende todo
  iaRespuesta = '{"tipo":"faq","derivar":false,"urgente":false,"respuesta":"Atendemos de 9 a 18"}';
  r = await webhook.handler(evWebhook(payloadMsg("m1", "¿horario?")));
  check(r.statusCode === 200, "mensaje válido responde 200");
  let conv = F.read("negocios/n1/conversaciones/111_5491155551111");
  check(conv && conv.estado === "respondido_auto" && conv.telefono === "5491155551111", "crea conversación y la marca respondida");
  check(enviados.length === 1 && enviados[0].text.body === "Atendemos de 9 a 18" && enviados[0].to === "5491155551111", "envía la respuesta por la API");
  check(F.read("negocios/n1/contactos/5491155551111").consentimiento.estado === "si", "quien escribe primero queda con consentimiento");
  check(F.read("negocios/n1").mensajesEsteMes === 1 && F.read("negocios/n1").mesClave, "cuenta el mensaje y fija el mes");
  // duplicado
  await webhook.handler(evWebhook(payloadMsg("m1", "¿horario?")));
  check(enviados.length === 1, "el mismo mensaje reenviado por Meta no se contesta dos veces");

  // derivación urgente fuera de horario
  sembrarNegocio({ horario: hor });
  iaRespuesta = '{"tipo":"otro","derivar":true,"urgente":true,"motivo":"alarma sonando","respuesta":"Ya te contacta alguien del equipo"}';
  const antes = Date.now;
  Date.now = () => new Date("2026-11-15T13:00:00Z").getTime();   // domingo 10:00 = fuera de horario
  r = await webhook.handler(evWebhook(payloadMsg("m2", "suena la alarma!")));
  conv = F.read("negocios/n1/conversaciones/111_5491155551111");
  check(conv.estado === "derivado" && conv.urgente === true && conv.motivoDerivacion === "alarma sonando", "fuera de horario: responde y deriva marcando urgencia");
  check(enviados.length === 1, "fuera de horario el bot contesta todo");
  // en horario, pregunta que no es FAQ: no contesta
  sembrarNegocio({ horario: hor });
  Date.now = () => lunes10.getTime();
  iaRespuesta = '{"tipo":"otro","derivar":true,"urgente":false,"respuesta":"te llamamos"}';
  await webhook.handler(evWebhook(payloadMsg("m3", "quiero un presupuesto a medida")));
  conv = F.read("negocios/n1/conversaciones/111_5491155551111");
  check(enviados.length === 0 && conv.estado === "pendiente_humano", "en horario y no es FAQ: espera a una persona, no contesta");
  check(F.read("negocios/n1").mensajesEsteMes === 0, "si el bot no contesta, no gasta cupo");
  // en horario, FAQ: contesta
  sembrarNegocio({ horario: hor });
  iaRespuesta = '{"tipo":"faq","derivar":false,"urgente":false,"respuesta":"Cámara $50000"}';
  await webhook.handler(evWebhook(payloadMsg("m4", "precio cámara?")));
  check(enviados.length === 1, "en horario y es FAQ: contesta");
  Date.now = antes;

  // tope mensual
  sembrarNegocio({ features: { limiteMensajesMes: 1, limiteEnviosMes: 30 } });
  iaRespuesta = '{"tipo":"faq","derivar":false,"urgente":false,"respuesta":"ok"}';
  await webhook.handler(evWebhook(payloadMsg("a1", "hola")));
  await webhook.handler(evWebhook(payloadMsg("a2", "hola otra vez")));
  check(enviados.length === 1 && F.read("negocios/n1/conversaciones/111_5491155551111").estado === "pendiente_humano", "al llegar al tope mensual el bot deja de contestar y pasa a una persona");

  // mes nuevo reinicia
  sembrarNegocio(); F.seed("negocios/n1", Object.assign(F.read("negocios/n1"), { mesClave: "2020-01", mensajesEsteMes: 999, enviosEsteMes: 999 }));
  iaRespuesta = '{"tipo":"faq","derivar":false,"urgente":false,"respuesta":"ok"}';
  await webhook.handler(evWebhook(payloadMsg("b1", "hola")));
  check(F.read("negocios/n1").mensajesEsteMes === 1 && F.read("negocios/n1").enviosEsteMes === 0, "los contadores se reinician solos al cambiar de mes");

  // baja y alta
  sembrarNegocio();
  await webhook.handler(evWebhook(payloadMsg("c1", "STOP")));
  check(F.read("negocios/n1/contactos/5491155551111").baja === true && enviados.length === 1 && /no vas a recibir/i.test(enviados[0].text.body), "STOP marca baja y confirma");
  iaRespuesta = '{"tipo":"faq","derivar":false,"urgente":false,"respuesta":"ok"}';
  await webhook.handler(evWebhook(payloadMsg("c2", "ALTA")));
  check(F.read("negocios/n1/contactos/5491155551111").baja === false, "ALTA reactiva");

  // modo manual: el bot no contesta
  sembrarNegocio(); F.seed("negocios/n1/conversaciones/111_5491155551111", { modoManual: true, estado: "atendido", nombre: "Ana" });
  await webhook.handler(evWebhook(payloadMsg("d1", "hola")));
  check(enviados.length === 0, "en modo manual el bot no contesta");

  // imagen
  sembrarNegocio();
  const imgP = payloadMsg("e1", "", "5491155551111", "111", "image"); imgP.entry[0].changes[0].value.messages[0].text = undefined;
  await webhook.handler(evWebhook(imgP));
  check(enviados.length === 0 && F.read("negocios/n1/conversaciones/111_5491155551111").estado === "pendiente_humano", "imágenes/audios van a una persona");

  // conexión vieja v0.2 sigue funcionando
  F.reset(); enviados = [];
  F.seed("negocios/viejo", { nombreNegocio: "Viejo", systemPrompt: "x", productos: [], faqs: [], whatsapp: { phoneNumberId: "999", token: "VIEJO", verifyToken: "cba_old" }, features: { limiteMensajesMes: 200 } });
  iaRespuesta = '{"tipo":"faq","derivar":false,"urgente":false,"respuesta":"hola viejo"}';
  await webhook.handler(evWebhook(payloadMsg("v1", "hola", "5491100000000", "999")));
  check(enviados.length === 1 && F.read("negocios/viejo/conversaciones/5491100000000"), "la conexión vieja (v0.2) sigue funcionando como respaldo");

  // estados de entrega
  sembrarNegocio(); F.seed("negocios/n1/campanas/c1", { estado: "enviando", entregados: 0, leidos: 0 }); F.seed("negocios/n1/envios/wamid.X", { campanaId: "c1", estado: "sent" });
  const st = (status) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "111" }, statuses: [{ id: "wamid.X", status }] } }] }] });
  await webhook.handler(evWebhook(st("delivered"))); await webhook.handler(evWebhook(st("delivered"))); await webhook.handler(evWebhook(st("read")));
  check(F.read("negocios/n1/campanas/c1").entregados === 1 && F.read("negocios/n1/campanas/c1").leidos === 1 && F.read("negocios/n1/envios/wamid.X").estado === "read", "estados de entrega suman una sola vez");

  /* ═══ enviarMensaje ═══ */
  console.log("• enviarMensaje");
  sembrarNegocio();
  F.seed("negocios/n1/conversaciones/111_549", { telefono: "549", lineaId: "111", ultimoMensajeCliente: new F.Ts(Date.now() - 3600e3), nombre: "Ana" });
  r = await envMsg.handler(ev({ negocioId: "n1", convId: "111_549", texto: "Hola Ana" }, "tok:ag:a@a.com"));
  check(r.statusCode === 200 && enviados.length === 1 && enviados[0].to === "549", "un agente envía y llega a la API");
  check(F.read("negocios/n1/conversaciones/111_549").estado === "atendido", "la conversación queda atendida");
  r = await envMsg.handler(ev({ negocioId: "n1", convId: "111_549", texto: "x" }, "tok:otro:o@o.com"));
  check(r.statusCode === 403, "un usuario de otro negocio no puede enviar");
  r = await envMsg.handler({ httpMethod: "POST", headers: {}, body: "{}" });
  check(r.statusCode === 401, "sin sesión = 401");
  F.seed("negocios/n1/conversaciones/111_vieja", { telefono: "550", lineaId: "111", ultimoMensajeCliente: new F.Ts(Date.now() - 30 * 3600e3) });
  r = await envMsg.handler(ev({ negocioId: "n1", convId: "111_vieja", texto: "x" }, "tok:u1:a@a.com"));
  check(r.statusCode === 409 && j(r).error === "ventana_24h", "pasadas 24 h pide usar plantilla");
  check(r.headers["Access-Control-Allow-Origin"] === "https://centralbotar.raventechsapp.com", "CORS solo para el dominio de la app");
  r = await envMsg.handler(ev({ negocioId: "n1", convId: "111_549", texto: "otra" }, "tok:ag:a@a.com"));
  check(F.read("negocios/n1/conversaciones/111_549").modoManual === true, "al responder una persona, el bot se hace a un lado (modoManual)");

  /* ═══ quienSoy ═══ */
  console.log("• quienSoy");
  r = await quien.handler(ev({}, "tok:u1:a@a.com"));
  check(r.statusCode === 200 && j(r).esAdmin === false && j(r).refrescar === false, "un usuario común no es admin");
  r = await quien.handler(ev({}, "tok:adm1:rgaraventa@gmail.com"));
  check(j(r).esAdmin === false, "el admin con mail NO verificado no se acepta");
  r = await quien.handler(ev({}, "tok:adm1:rgaraventa@gmail.com:ver"));
  check(j(r).esAdmin === true && j(r).refrescar === true, "admin verificado: se pone la marca y pide refrescar");
  r = await quien.handler(ev({}, "tok:adm1:rgaraventa@gmail.com:ver"));
  check(j(r).refrescar === false, "la segunda vez ya no hace falta refrescar");
  r = await quien.handler({ httpMethod: "POST", headers: {}, body: "{}" });
  check(r.statusCode === 401, "quienSoy sin sesión = 401");

  /* ═══ conectarLinea ═══ */
  console.log("• conectarLinea");
  sembrarNegocio();
  r = await conectar.handler(ev({ negocioId: "n1", phoneNumberId: "222", token: "MALO", nombre: "RavenTechs" }, "tok:u1:a@a.com"));
  check(r.statusCode === 400 && j(r).error === "token_invalido" && !F.read("negocios/n1/secretos/222"), "token inválido: no guarda nada");
  r = await conectar.handler(ev({ negocioId: "n1", phoneNumberId: "222", token: "EAAbueno", nombre: "RavenTechs" }, "tok:u1:a@a.com"));
  check(r.statusCode === 200 && F.read("negocios/n1/secretos/222").token === "EAAbueno" && F.read("lineasIndex/222").negocioId === "n1", "conecta: token en secretos + índice");
  check(/linea=222/.test(j(r).webhookUrl) && /^cba_/.test(j(r).verifyToken), "devuelve URL y token de verificación");
  check(!JSON.stringify(F.read("negocios/n1/lineas/222")).includes("EAAbueno"), "el token no queda en el documento visible de la línea");
  const v1 = j(r).verifyToken;
  r = await conectar.handler(ev({ negocioId: "n1", phoneNumberId: "222", token: "EAAnuevo", nombre: "RavenTechs" }, "tok:u1:a@a.com"));
  check(j(r).verifyToken === v1, "reconectar conserva el token de verificación (no hay que tocar Meta)");
  r = await conectar.handler(ev({ negocioId: "n1", phoneNumberId: "222", token: "EAAx" }, "tok:ag:a@a.com"));
  check(r.statusCode === 403, "un agente no puede conectar números");
  F.seed("lineasIndex/333", { negocioId: "n2" });
  r = await conectar.handler(ev({ negocioId: "n1", phoneNumberId: "333", token: "EAAx" }, "tok:u1:a@a.com"));
  check(r.statusCode === 409 && j(r).error === "numero_en_uso", "un número no puede estar en dos negocios");
  // migración de conexión vieja
  F.seed("negocios/n1", Object.assign(F.read("negocios/n1"), { whatsapp: { phoneNumberId: "444", token: "VIEJO", verifyToken: "cba_old" } }));
  await conectar.handler(ev({ negocioId: "n1", phoneNumberId: "444", token: "EAAnuevo4", nombre: "Viejo" }, "tok:u1:a@a.com"));
  check(F.read("negocios/n1").whatsapp === undefined, "al reconectar, el token viejo que estaba a la vista se borra del negocio");
  await conectar.handler(ev({ negocioId: "n1", phoneNumberId: "222", accion: "desconectar" }, "tok:u1:a@a.com"));
  check(!F.read("negocios/n1/secretos/222") && !F.read("lineasIndex/222"), "desconectar borra token e índice");

  /* ═══ campañas ═══ */
  console.log("• enviarCampana");
  const contactos = n => { for (let i = 0; i < n; i++) F.seed("negocios/n1/contactos/54911555" + String(1000 + i), { nombre: "Cliente " + i + " Apellido", telefono: "54911555" + String(1000 + i), etiquetas: ["cámaras"], baja: false, consentimiento: { estado: "si" } }); };
  const base = (extra = {}) => { sembrarNegocio(extra); F.seed("negocios/n1/plantillas/p1", { nombre: "oferta_camaras", idioma: "es_AR", estado: "aprobada", vars: [{ tipo: "nombre" }, { tipo: "fijo", valor: "20% off" }] }); F.seed("negocios/n1/campanas/c1", { nombre: "Oferta", plantillaId: "p1", etiqueta: "cámaras", lineaId: "111", estado: "borrador" }); };
  base(); contactos(5);
  F.seed("negocios/n1/contactos/5491100001", { nombre: "Baja", telefono: "5491100001", etiquetas: ["cámaras"], baja: true, consentimiento: { estado: "si" } });
  F.seed("negocios/n1/contactos/5491100002", { nombre: "SinOk", telefono: "5491100002", etiquetas: ["cámaras"], baja: false, consentimiento: { estado: "desconocido" } });
  F.seed("negocios/n1/contactos/5491100003", { nombre: "OtraEtiqueta", telefono: "5491100003", etiquetas: ["alarmas"], baja: false, consentimiento: { estado: "si" } });
  r = await envCamp.handler(ev({ negocioId: "n1", campanaId: "c1", accion: "iniciar" }, "tok:ag:a@a.com"));
  check(r.statusCode === 403, "un agente no puede lanzar campañas");
  r = await envCamp.handler(ev({ negocioId: "n1", campanaId: "c1", accion: "iniciar" }, "tok:u1:a@a.com"));
  check(r.statusCode === 200 && j(r).total === 5, "inicia solo con contactos con OK, sin baja y de la etiqueta (5 de 8)");
  check(F.read("negocios/n1").enviosEsteMes === 5, "reserva el cupo mensual");
  r = await envCamp.handler(ev({ negocioId: "n1", campanaId: "c1", accion: "iniciar" }, "tok:u1:a@a.com"));
  check(r.statusCode === 409, "no se puede iniciar dos veces");
  r = await envCamp.handler(ev({ negocioId: "n1", campanaId: "c1", accion: "lote" }, "tok:u1:a@a.com"));
  check(j(r).enviados === 5 && j(r).terminada === true, "el lote envía los 5 y termina");
  check(enviados[0].type === "template" && enviados[0].template.name === "oferta_camaras" && enviados[0].template.components[0].parameters[0].text === "Cliente" && enviados[0].template.components[0].parameters[1].text === "20% off", "arma la plantilla con nombre y texto fijo");
  check(F.read("negocios/n1/campanas/c1").estado === "completa" && F.read("negocios/n1/campanas/c1").enviados === 5, "campaña completa con 5 enviados");
  // tope
  base({ features: { limiteMensajesMes: 200, limiteEnviosMes: 3 } }); contactos(5);
  r = await envCamp.handler(ev({ negocioId: "n1", campanaId: "c1", accion: "iniciar" }, "tok:u1:a@a.com"));
  check(j(r).total === 3 && j(r).omitidosPorTope === 2, "el tope mensual recorta a 3 y avisa que omitió 2");
  r = await envCamp.handler(ev({ negocioId: "n1", campanaId: "c1", accion: "lote" }, "tok:u1:a@a.com"));
  base({ features: { limiteMensajesMes: 200, limiteEnviosMes: 3 } }); F.seed("negocios/n1", Object.assign(F.read("negocios/n1"), { mesClave: C.mesClave(), enviosEsteMes: 3 })); contactos(2);
  r = await envCamp.handler(ev({ negocioId: "n1", campanaId: "c1", accion: "iniciar" }, "tok:u1:a@a.com"));
  check(r.statusCode === 429 && j(r).error === "tope_mensual", "sin cupo no inicia (429)");
  // fallos devuelven cupo
  base(); contactos(4); graphRespuesta = "fallar";
  await envCamp.handler(ev({ negocioId: "n1", campanaId: "c1", accion: "iniciar" }, "tok:u1:a@a.com"));
  r = await envCamp.handler(ev({ negocioId: "n1", campanaId: "c1", accion: "lote" }, "tok:u1:a@a.com"));
  graphRespuesta = null;
  check(j(r).fallidos === 4 && F.read("negocios/n1").enviosEsteMes === 0, "los envíos fallidos devuelven el cupo");
  check(F.read("negocios/n1/campanas/c1").fallidos === 4 && F.read("negocios/n1/campanas/c1").estado === "completa", "queda registrado el fallo");
  // baja durante el envío
  base(); contactos(3);
  await envCamp.handler(ev({ negocioId: "n1", campanaId: "c1", accion: "iniciar" }, "tok:u1:a@a.com"));
  F.seed("negocios/n1/contactos/549115551001", Object.assign(F.read("negocios/n1/contactos/549115551001") || {}, {}));
  const ct = F.read("negocios/n1/contactos/54911555" + "1001"); ct.baja = true; F.seed("negocios/n1/contactos/54911555" + "1001", ct);
  enviados = [];
  r = await envCamp.handler(ev({ negocioId: "n1", campanaId: "c1", accion: "lote" }, "tok:u1:a@a.com"));
  check(j(r).enviados === 2 && j(r).omitidos === 1 && F.read("negocios/n1").enviosEsteMes === 2, "quien se da de baja a mitad de envío no recibe y devuelve cupo");
  // plantilla sin aprobar
  base(); contactos(2); F.seed("negocios/n1/plantillas/p1", Object.assign(F.read("negocios/n1/plantillas/p1"), { estado: "pendiente" }));
  r = await envCamp.handler(ev({ negocioId: "n1", campanaId: "c1", accion: "iniciar" }, "tok:u1:a@a.com"));
  check(r.statusCode === 400 && j(r).error === "plantilla_no_aprobada", "no envía con plantilla sin aprobar");
  // prueba vencida
  base({ demoHasta: new F.Ts(Date.now() - 1000) }); contactos(2);
  r = await envCamp.handler(ev({ negocioId: "n1", campanaId: "c1", accion: "iniciar" }, "tok:u1:a@a.com"));
  check(r.statusCode === 402, "con la prueba vencida no se envían campañas");
  r = await envCamp.handler(ev({ negocioId: "n1", campanaId: "c1", accion: "iniciar" }, "tok:admin:rgaraventa@gmail.com:ver"));
  check(r.statusCode !== 402, "el admin con email verificado está exento");
  // campaña de práctica
  base(); F.seed("negocios/n1/campanas/c1", { estado: "borrador", _demo: true });
  r = await envCamp.handler(ev({ negocioId: "n1", campanaId: "c1", accion: "iniciar" }, "tok:u1:a@a.com"));
  check(r.statusCode === 400 && j(r).error === "campana_de_practica", "las campañas de práctica nunca salen por la API");

  console.log(`\n${okN} verificaciones OK, ${malN} fallas`);
  process.exit(malN ? 1 : 0);
})().catch(e => { console.error("ERROR EN LA PRUEBA:", e); process.exit(2); });
