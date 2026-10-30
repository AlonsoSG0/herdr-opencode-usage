# Herdr OpenCode usage

Panel flotante angosto con tu consumo de OpenCode Go y tu saldo de Zen, leído directo de las credenciales que ya guardó OpenCode.

![OpenCode usage](preview.png)

## What you see

- Una **ventana flotante** de 232×236 px, no un modal: queda abierta sobre el layout, sin oscurecer nada, y se arrastra desde cualquier punto del panel. Herdr recuerda dónde la soltaste y la reabre ahí; con `keep` vuelve sola en el próximo arranque.
- Arriba, un grip `⠿`, un punto de estado (verde normal, rojo si hay error), el rótulo "OPENCODE", hace cuánto se actualizó, y a la derecha `⌄` para expandir, `↻` y `×`.
- Tres barras de 3px con etiqueta y porcentaje a la derecha: **Go 5h**, **Go week**, **Go month**. Debajo de cada una, cuándo se resetea esa ventana, siempre visible: `resetea en 25m`, `resetea en 2d 21h`.
- El color de cada barra cambia con el consumo: verde por debajo de 60%, amarillo entre 60% y 85%, rojo arriba de 85%.
- Debajo, un separador y dos filas: **Zen balance** y **Spent 30d**, en dólares con dos decimales.
- Al expandir con `⌄` aparece **Projected by month end** con el porcentaje que alcanzarías al cerrar el mes si seguís a este ritmo (rojo si pasa 100%), y el último modelo de Go usado. El gasto de hoy aparece solo cuando la base local lo tiene.
- Todo el texto de la ventana está en inglés.
- Si algo falla, una línea roja de 9.5px con el error puntual.
- La imagen de este README tiene los valores ocultos a propósito: son datos personales.

## How it behaves

- Al abrirse lee `~/.local/share/opencode/opencode.db` (tabla `credential`, filas activas de `opencode-go` y `opencode`). Es el mismo lugar donde `/connect` y `opencode auth login` guardan todo hoy. Si no encuentra nada, cae a `~/.local/share/opencode/auth.json` como respaldo de instalaciones viejas.
- Consulta Go y Zen al abrir, y después cada **5 minutos** mientras la ventana sigue abierta. Cinco minutos alcanzan para vigilar cuotas de 5h, semanales y mensuales sin castigar los endpoints: son 288 lecturas por día, y el mínimo entre lecturas es de 45 segundos para que abrir y refrescar seguido no dupliquen llamadas.
- Cuando cualquiera de las tres ventanas de Go cruza el **85%**, manda un aviso nativo de Herdr con `notify()` una sola vez; no repite hasta que esa ventana baje 10 puntos al resetearse.
- La proyección usa el porcentaje mensual y el día del mes: extrapola el consumo actual a los días que tiene el mes y muestra el porcentaje final. Es una estimación de ritmo constante, no una predicción exacta.
- El último modelo y el gasto de hoy salen de la base local de OpenCode (`session_message` para el modelo, `message` para costo). **Eso cubre solo sesiones de OpenCode**: si trabajás con pi u otro cliente, el modelo que muestra puede no ser el que estás usando en ese momento, y por eso el gasto de hoy se oculta cuando no hay dato en vez de inventar un cero. No se muestra el límite por modelo: cambia con el plan y con el catálogo.
- Al cerrar la ventana el mod deja de existir y no hay ningún timer corriendo: no hay polling en segundo plano.
- Go: `GET https://opencode.ai/inference/go/v1/usage` con `Authorization: Bearer <key>`; si falla, reintenta contra `https://opencode.ai/zen/go/v1/usage`. Lee `usage.rolling`, `.weekly` y `.monthly`, aceptando `percent`, `usagePercent` o el par `usedMicroCents`/`limitMicroCents`.
- Zen: `GET https://opencode.ai/console/api/billing/status` y `GET https://opencode.ai/console/api/usage/summary?range=30d`, con el token de Console como `Bearer` y el `orgID` que viene en la metadata de la credencial como `x-org-id`. Los montos son `balanceMicroCents` y `totalCostMicroCents` divididos por 100.000.000.
- Se abre con `ctrl-alt-u` o desde la command palette eligiendo `mod.open` y escribiendo `herdr-opencode-usage`. Con la ventana enfocada, la misma tecla la cierra; también `Esc` y el botón `×`. Para un botón en el tab bar, ver la receta opcional al final.
- No toca spaces, tabs, terminales ni archivos del usuario. Solo lee credenciales y consulta dos APIs.

## Built from

- Un mod sin `layouts/`, con `main.js`, `mod.json`, `usage.svg` y un snippet `keys.json`.
- `mod.json`: `{"place":"none","title":"OpenCode usage","overlay":{"kind":"window","key":"opencode-usage","keep":true,"width":232,"height":236}}`. No se acopla solo; entra por la tecla o la palette.
- `main.js` extiende `View`: `init` arranca el timer de 5 minutos, `refresh` hace `cx.spawn` con los `fetch`, `render` dibuja con `v_flex`/`h_flex` de `gpui-base` y colores de `theme()`.
- Arrastre: la ventana la mueve Herdr con cualquier press que el mod no detenga; el `↻` frena el press con `cx.stop_propagation()` para que un clic no arrastre.
- Credenciales: `exec("sqlite3", ["-json","-readonly", db, query])` sobre `opencode.db`, con `readTextFile` de respaldo sobre `auth.json`.
- `usage.svg` es un glifo de tres barras, listo para quien quiera sumar un botón en un layout propio.
- No clona ni edita `tabs` ni `main`: los layouts shippeados son read-only y cada mod que los clonara dejaría un layout congelado. Se accede por tecla y por palette. El botón queda como receta opcional más abajo.
- Snippet `keys.json` para el comando:

```json
{
  "global": { "ctrl-alt-u": "mod.open:herdr-opencode-usage" },
  "mod:herdr-opencode-usage": {
    "ctrl-alt-u": "herdr-opencode-usage.close",
    "escape": "herdr-opencode-usage.close"
  }
}
```

- La ventana pide el foco al abrirse. Por eso la sección `mod:herdr-opencode-usage` gana mientras está enfocada y la misma tecla cierra. Si clickeaste afuera, la tecla global la vuelve a traer al frente en vez de cerrarla.
- `nextCommand()` recibe `close` y llama `closeOverlay(props().overlay)`; el botón `×` y `Esc` hacen lo mismo.

## Watch out

- **Sale a la red** en `opencode.ai` y **lee tus credenciales locales** de `opencode.db`. Eso hay que decirlo antes de instalarlo.
- `auth.json` puede estar viejo: desde la migración a la DB, `/connect` escribe en `credential`. Si el panel muestra `sin credencial`, corré `opencode auth login`.
- `balanceMicroCents` es el saldo; no lo confundas con `availableMicroCents`.
- Console responde 401 si el token venció y 400 si falta `x-org-id`. El panel lo muestra como texto rojo, no rompe el layout.
- No crea layouts ni clones de `tabs`: eso quedaría congelado cuando Herdr actualice el layout `main`.
- La preview oculta los números reales: no publiques capturas con tus montos.

### Botón en el tab bar (opcional)

Si querés el panel a un clic en vez de la tecla, armalo en un layout propio:

```sh
herdr-app do mod.clone '{"name":"tabs","as":"my-tabs"}'
herdr-app do layout.clone '{"name":"main","as":"my-layout"}'
```

Después, en `mods/my-tabs/main.js`, agregá un botón junto a Files y Changes:

```js
.child(h_flex().id("usage").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
  .text_size(12).bg(t.chrome).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
  .on_mouse_down("left", stop)
  .on_click(() => run("mod.open", { name: "herdr-opencode-usage" }))
  .child(svg("mods/herdr-opencode-usage/usage.svg").size(14)).child("Usage"))
```

Y en `layouts/my-layout.json`, apuntá el bloque `tabs` a `"my-tabs"`. Nada de esto viaja en este mod.

## Done when

- `herdr-app check mods/herdr-opencode-usage` pasa.
- `herdr-app do mod.open --name herdr-opencode-usage` abre el overlay en menos de un segundo.
- Con credenciales válidas muestra tres porcentajes y dos montos; con la key vencida muestra el error de la API sin romper nada.
- `ctrl-alt-u` abre el overlay desde cualquier layout, y la tecla se puede cambiar en `keys.json`.
- `mod.open` desde la command palette abre el mismo overlay.
- Las barras cambian de verde a amarillo y rojo al cruzar 60% y 85%.
- Cada barra muestra cuándo resetea su ventana sin necesidad de expandir.
- `⌄` expande la proyección en porcentaje y el último modelo; el estado se recuerda entre aperturas.
- Todo el texto de la ventana está en inglés.
- Al pasar 85% en cualquiera de las tres ventanas aparece un aviso de Herdr, una sola vez.
- La ventana se arrastra, se suelta en otro lado y reabre en esa posición; con `keep`, sobrevive un reinicio.
- Cerrarla detiene el refresco: no quedan timers corriendo.
- `ctrl-alt-u` abre con la ventana cerrada y cierra con la ventana enfocada; `×` y `Esc` cierran siempre.
