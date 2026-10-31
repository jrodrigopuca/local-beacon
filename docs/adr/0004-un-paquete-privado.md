# ADR-0004: Un solo paquete, sin publicar por ahora

- Estado: aceptada (2026-10-31)
- Drivers: (1) una API pública es una promesa cara de cambiar, y hoy el núcleo no
  tiene ningún cliente que lo importe: `local-sidekicks` está en Python y se
  integra por `OLLAMA_URL`, apuntando al proxy; (2) agregar una exportación más
  adelante es barato, quitarla no.
- Decisión: un único paquete `local-beacon`, marcado `private`, sin exportar el
  núcleo. Los comandos serán `local-beacon` (canónico) y `lbeacon` (atajo). No se
  usa `beacon` porque es demasiado genérico. Las entradas de `bin` se agregan con
  la capa CLI.
- Tradeoff aceptado: otro proyecto en TypeScript no puede importar el núcleo, y
  nadie puede instalarlo desde npm. `local-beacon` estaba libre en npm el
  2026-10-31, pero no está reservado.
- Revisar si: aparece un segundo cliente real en TypeScript que necesite importar
  el núcleo, o se decide distribuir el CLI por npm.
