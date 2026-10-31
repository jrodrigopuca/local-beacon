# ADR-0002: El proxy observa y no altera

- Estado: aceptada (2026-10-31)
- Drivers: (1) `/api/ps` no cambió ningún campo entre inactivo y generando, así
  que hace falta estar en el camino para ver cada pedido (spike 2026-10-31,
  prueba 4); (2) un proxy mínimo sumó unos 10 ms y devolvió el mismo texto y los
  mismos 17 fragmentos que la conexión directa (prueba 1, una corrida);
  (3) `interaction` y `local-sidekicks` comparan corridas: un intermediario que
  cambie pedidos contamina esas mediciones sin dejar registro.
- Decisión: el proxy reenvía los bytes sin cambios en ambas direcciones y solo
  anota metadatos. Escucha en `127.0.0.1` y no guarda prompts. Corre en la
  máquina cliente, sin instalar nada en la remota. La única intervención es
  cortar un pedido a pedido explícito (`cancel`): cerrar la conexión liberó el
  modelo, con 64 ms de espera frente a 29,9 s sin cancelar (prueba 3).
- Tradeoff aceptado: solo se ve lo que pasa por el proxy, y un pedido sin
  streaming aparece como "esperando" hasta el final. `runner/control.py:295` en
  `local-sidekicks` usa `"stream": False`; verlo en vivo requiere cambiar el
  cliente, no el proxy.
- Revisar si: aparece un requisito que no se pueda cumplir sin modificar pedidos
  en tránsito, o varios clientes que no se puedan apuntar al proxy.
