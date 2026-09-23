import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// El tablero de ventas de gs que sigue un room (gt_room_sales_boards; el porqué, junto a la
// tabla en server/schema.server.ts). La lista de tableros la da gs por HMAC con el workspace
// de ESTE host: un room no puede nombrar el tablero de otro equipo, y gs lo vuelve a validar
// en cada turno.

async function visibleChannel(channelId: number) {
  const me = await sessionUser();
  if (!me) throw new Error("no autenticado");
  const db = await import("../db.server");
  const ch = (await db.listChannels(me.sub, me.isOwner)).find((c) => c.id === channelId);
  if (!ch) throw new Error("room no encontrado");
  return { me, db, ch };
}

type SalesBoard = { id: string; name: string; url: string };

/** Tableros de ventas del workspace, según gs. Vacío si no hay runtime nativo o no tiene Ventas. */
export async function listSalesBoards(): Promise<SalesBoard[]> {
  const { nativeRuntimeBase, partnerHeaders } = await import("./ghosty-runtime.server");
  const { currentNamespace } = await import("./tenant.server");
  const base = await nativeRuntimeBase();
  if (!base) return [];
  const res = await fetch(`${base}/api/v2/partners/boards`, { headers: partnerHeaders("", await currentNamespace()) });
  if (!res.ok) return [];
  const j = (await res.json()) as { boards?: SalesBoard[] };
  return j.boards ?? [];
}

/** El tablero de este room (con su URL fresca si gs contesta). */
export const roomSalesBoardFn = createServerFn({ method: "POST" })
  .validator((d: { channelId: number }) => d)
  .handler(async ({ data }) => {
    const { db } = await visibleChannel(Number(data.channelId));
    return await db.getRoomSalesBoard(Number(data.channelId));
  });

/** Lo que se puede vincular. Se pide al ABRIR el panel. */
export const salesBoardsFn = createServerFn({ method: "GET" }).handler(async () => {
  const me = await sessionUser();
  if (!me) throw new Error("no autenticado");
  return await listSalesBoards().catch(() => []);
});

/** Vincula (o cambia) el tablero del room. Cualquiera que vea el room, como los repos. */
export const setRoomSalesBoardFn = createServerFn({ method: "POST" })
  .validator((d: { channelId: number; boardId: string }) => d)
  .handler(async ({ data }) => {
    const { me, db } = await visibleChannel(Number(data.channelId));
    const board = (await listSalesBoards()).find((b) => b.id === data.boardId);
    if (!board) throw new Error("ese tablero no es de este espacio");
    await db.setRoomSalesBoard(Number(data.channelId), board.id, board.name, me.sub);
    return await db.getRoomSalesBoard(Number(data.channelId));
  });

/** Lo desvincula quien lo vinculó, o el owner del workspace. */
export const clearRoomSalesBoardFn = createServerFn({ method: "POST" })
  .validator((d: { channelId: number }) => d)
  .handler(async ({ data }) => {
    const { me, db } = await visibleChannel(Number(data.channelId));
    const actual = await db.getRoomSalesBoard(Number(data.channelId));
    if (!actual) return null;
    if (!me.isOwner && actual.connectedBy !== me.sub)
      throw new Error("lo vinculó otra persona: que lo quite ella o el dueño del espacio");
    await db.clearRoomSalesBoard(Number(data.channelId));
    return null;
  });
