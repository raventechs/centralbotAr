import re, sys, json, pathlib
from playwright.sync_api import sync_playwright
root = pathlib.Path(__file__).resolve().parent.parent
fake = (root/'tests/fakeFirebaseBrowser.js').read_text()
html = (root/'centralbotar.html').read_text()
errs=[]; ok=0; mal=0
def check(c,m):
    global ok,mal
    if c: ok+=1
    else: mal+=1; print('  ✗ FALLA:',m)
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width':390,'height':800})
    pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type=='error' and 'Failed to load resource' not in m.text else None)
    def route(r):
        u=r.request.url
        if 'gstatic.com/firebasejs' in u: r.fulfill(body='', content_type='application/javascript')
        elif u.startswith('http://t.test/'): r.fulfill(body=html, content_type='text/html')
        else: r.fulfill(status=204, body='')
    pg.route('**/*', route)
    pg.add_init_script(fake)
    pg.goto('http://t.test/centralbotar.html'); pg.wait_for_timeout(1500)
    check(pg.is_visible('#app') or pg.is_visible('#nav'), 'entra a la app y muestra el menú')
    st = pg.evaluate("Object.keys(window.__store)")
    check('usuarios/owner1' in st and 'negocios/owner1' in st, 'alta nueva crea usuario y negocio')
    check(pg.evaluate("window.__store['negocios/owner1'].demoHasta.toMillis() > Date.now()+13*864e5"), 'demo de 14 días asignada')
    check(pg.is_visible('#demo-banner'), 'cartel de prueba visible')
    # práctica
    pg.evaluate("showPage('config')"); pg.click('[data-act=pr-cargar]'); pg.wait_for_timeout(600)
    check(len([k for k in pg.evaluate("Object.keys(window.__store)") if k.startswith('negocios/owner1/contactos/')])==6, 'práctica carga 6 contactos _demo')
    pg.evaluate("showPage('bandeja')"); pg.wait_for_timeout(300)
    check(pg.locator('.conv-row').count()==3, 'bandeja muestra 3 chats de práctica')
    pg.click('.conv-row >> nth=0'); pg.wait_for_timeout(400)
    check(pg.locator('.bubble').count()>=2, 'chat abre con mensajes')
    pg.fill('#chat-input-text','Ya vamos para allá'); pg.click('#btn-chat-enviar'); pg.wait_for_timeout(400)
    check(pg.evaluate("window.__fnCalls.filter(c=>c[0]=='enviarMensaje').length")==0, 'en práctica no llama al servidor para enviar')
    # contactos: importar
    pg.evaluate("showPage('contactos')"); pg.click('[data-act=ct-importar]')
    pg.fill('#im-texto','Nombre\tTeléfono\tEtiquetas\nAna Pérez\t11 5555-1234\tcámaras\nLuis\t+54 9 11 4444-5678\talarmas\nMal\t123\t')
    pg.click('[data-act=im-revisar]'); pg.wait_for_timeout(200)
    check('2' in pg.inner_text('#im-prev').split('teléfonos')[0], 'revisa: 2 válidos')
    pg.check('#im-ok'); pg.click('#im-go'); pg.wait_for_timeout(500)
    ks=[k for k in pg.evaluate("Object.keys(window.__store)") if k.endswith('5491155551234') or k.endswith('5491144445678')]
    check(len(ks)==2, 'importa con normalización 549 + área + número')
    check(pg.evaluate("Object.values(window.__store).some(d=>d.telefono=='5491155551234'&&d.consentimiento&&d.consentimiento.estado=='si')"), 'consentimiento declarado guardado')
    # plantilla
    pg.evaluate("showPage('plantillas')"); pg.click('[data-act=pl-nueva]')
    pg.fill('#mp-titulo','Oferta real'); pg.fill('#mp-texto','Hola {{1}}! Tenés {{2}} esta semana.'); pg.wait_for_timeout(200)
    pg.select_option('#mp-estado','aprobada'); pg.fill('#mp-vars input[data-var="1"]','10% off'); pg.click('[data-act=pl-guardar]'); pg.wait_for_timeout(400)
    check(pg.evaluate("Object.values(window.__store).some(d=>d.nombre=='oferta_real'&&d.vars&&d.vars.length==2)"), 'plantilla guardada con 2 variables')
    # campaña práctica simulada
    pg.evaluate("showPage('campanas')"); pg.click('[data-act=cp-nueva]'); pg.fill('#mk-nombre','Prueba')
    pg.select_option('#mk-pl', label='🎓 Oferta de práctica'); pg.click('[data-act=cp-crear]'); pg.wait_for_timeout(400)
    check(pg.locator('#cp-lista .card').count()==1, 'campaña borrador creada')
    # sin línea, campaña real no se crea
    pg.evaluate("showPage('lineas')"); check(pg.is_visible('#ln-nombre'), 'pantalla de líneas')
    pg.evaluate("showPage('equipo')"); pg.wait_for_timeout(200); pg.click('[data-act=eq-invitar]'); pg.wait_for_timeout(500)
    check(pg.locator('#eq-invs .list-item').count()==1, 'invitación creada')
    # backup
    pg.evaluate("showPage('config')")
    with pg.expect_download() as d: pg.click('[data-act=bk-ahora]')
    j=json.loads(pathlib.Path(d.value.path()).read_text())
    check(j['app']=='CentralbotAr' and not any(c.get('_demo') for c in j['contactos']) and len(j['contactos'])==2, 'backup excluye práctica y trae contactos reales')
    check('token' not in json.dumps(j), 'backup sin tokens')
    # quitar práctica
    pg.on('dialog', lambda d: d.accept()); pg.click('[data-act=pr-quitar]'); pg.wait_for_timeout(800)
    check(not any(d.get('_demo') for d in pg.evaluate("Object.values(window.__store)")), 'quitar práctica borra solo lo _demo')
    check(pg.evaluate("Object.keys(window.__store).filter(k=>k.includes('/contactos/')).length")==2, 'contactos reales intactos')
    # prueba vencida bloquea
    pg.evaluate("window.__store['negocios/owner1'].demoHasta = firebase.firestore.Timestamp.fromMillis(Date.now()-1000)"); pg.evaluate("db.collection('negocios').doc('owner1').update({nombreNegocio:'x'})"); pg.wait_for_timeout(500)
    check(pg.is_visible('#screen-bloqueo'), 'prueba vencida muestra pantalla de bloqueo')
    pg.evaluate("window.__store['negocios/owner1'].demoHasta = null"); pg.evaluate("db.collection('negocios').doc('owner1').update({nombreNegocio:'y'})"); pg.wait_for_timeout(500)
    check(not pg.is_visible('#screen-bloqueo'), 'pasar a cliente desbloquea')
    pg.screenshot(path='/tmp/panel.png')
    b.close()
real=[e for e in errs if 'sw.js' not in e and 'serviceWorker' not in e.lower()]
check(not real, 'sin errores de JS en consola: '+str(real[:3]))
print(f'\n{ok} verificaciones OK, {mal} fallas'); sys.exit(1 if mal else 0)
