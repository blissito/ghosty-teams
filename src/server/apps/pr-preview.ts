import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "../chat";
import type { PrPreviewInput } from "./pr-preview.server";

// Botón «Levantar preview» de la tarjeta de un PR sin pedido. Cualquiera que vea el room.
// La lógica (compuertas y llamada a gs) vive en pr-preview.server.ts.

export const prPreviewStatusFn = createServerFn({ method: "POST" })
  .validator((d: PrPreviewInput) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const S = await import("./pr-preview.server");
    return await S.prPreviewStatus(me, data);
  });

export const prPreviewUpFn = createServerFn({ method: "POST" })
  .validator((d: PrPreviewInput) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const S = await import("./pr-preview.server");
    return await S.prPreviewUp(me, data);
  });
