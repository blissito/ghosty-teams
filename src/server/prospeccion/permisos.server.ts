/**
 * Quién puede hacer las cosas delicadas de Prospección.
 *
 * El modelo, decidido con el usuario: **todos VEN, y las acciones que salen hacia fuera o
 * son irreversibles se dan a dedo.**
 *
 * Es distinto de cómo se resolvieron los asientos —donde se decidió NO bloquear, porque un
 * cliente que invita a uno de más es una conversación comercial— y la diferencia es qué
 * pasa si te equivocas:
 *
 *  · Un asiento de más: se habla y se arregla.
 *  · Un correo a 11 mil prospectos con el mensaje equivocado: no se deshace, y quema el
 *    dominio que costó semanas calentar. Y lo puede hacer alguien que entró ayer.
 *
 * Sólo DOS acciones pasan por aquí, y las dos por la misma razón — no tienen vuelta atrás:
 *
 *  · **mandar** — sale a terceros con tu dominio y tu marca.
 *  · **purgar** — borra de verdad una lista archivada, con el trabajo de enriquecerla.
 *
 * Filtrar, importar, enriquecer, escribir columnas y archivar NO piden permiso: son el
 * trabajo diario, son reversibles, y ponerles puerta sólo estorbaría.
 */
import { getConfig, setConfig } from "../../config.server";
import { dbq, type Row } from "../../dbq.server";

/** Las acciones que se pueden conceder. Lista CERRADA a propósito. */
export type AccionDelicada = "mandar" | "purgar";

const LLAVE = "prospeccion_permisos";

/**
 * Quién puede qué.
 *
 * `mandar`/`purgar` son globales: valen sobre CUALQUIER lista, y sólo las da el dueño del
 * espacio. `porLista` las acota a una: las da también quien creó esa lista, porque el
 * trabajo es suyo y repartirlo no debería tener que pasar por el dueño.
 */
type Concesiones = {
  mandar: string[];
  purgar: string[];
  /** `listId` → acción → subs. Sólo valen para ESA lista. */
  porLista: Record<string, Partial<Record<AccionDelicada, string[]>>>;
};

const VACIO: Concesiones = { mandar: [], purgar: [], porLista: {} };

async function leer(): Promise<Concesiones> {
  const raw = await getConfig(LLAVE);
  if (!raw) return VACIO;
  try {
    const o = JSON.parse(raw) as Partial<Concesiones>;
    return {
      mandar: Array.isArray(o.mandar) ? o.mandar : [],
      purgar: Array.isArray(o.purgar) ? o.purgar : [],
      porLista: o.porLista && typeof o.porLista === "object" ? o.porLista : {},
    };
  } catch {
    return VACIO;
  }
}

/**
 * ¿Puede esta persona?
 *
 * Tres vías, y la del medio es la que hace que esto no estorbe:
 *
 * 1. **El dueño del espacio siempre puede.** No por comodidad: si el permiso dependiera sólo
 *    de una concesión, un workspace recién creado no tendría a nadie que pudiera mandar ni
 *    conceder el permiso, y no habría forma de salir de ahí desde la interfaz.
 * 2. **Quien CREÓ la lista manda sobre ella.** Si alguien entra a Prospección, arma su lista
 *    y la enriquece, ese trabajo es suyo y pedirle permiso al dueño para mandarlo sería
 *    absurdo. El permiso concedido es para tocar listas AJENAS.
 * 3. **A quien se lo concedieron**: el dueño del espacio da el permiso global; el creador
 *    de una lista lo da acotado a ESA lista.
 *
 * ⚠️ Sin `listId` no hay vía 2 — no hay lista de la que ser dueño. Toda llamada que actúe
 * sobre una lista concreta tiene que pasarlo, o le negará el permiso a quien la creó.
 */
export async function puede(
  user: { sub: string; isOwner?: boolean },
  accion: AccionDelicada,
  listId?: number
): Promise<boolean> {
  if (user.isOwner) return true;
  if (listId != null && (await creoLaLista(user.sub, listId))) return true;
  const c = await leer();
  if (c[accion].includes(user.sub)) return true;
  if (listId != null && (c.porLista[String(listId)]?.[accion] ?? []).includes(user.sub)) return true;
  return false;
}

/** ¿Esta persona creó esta lista? */
async function creoLaLista(sub: string, listId: number): Promise<boolean> {
  try {
    const rows = (await dbq(
      `SELECT created_by FROM gt_prosp_lists WHERE id = ? LIMIT 1`,
      [listId]
    )) as Row[];
    const owner = rows[0]?.created_by;
    return !!owner && String(owner) === sub;
  } catch {
    // Un fallo de lectura NO concede: cae a las otras dos vías.
    return false;
  }
}

/** A quién se le concedió cada acción. Para el panel del dueño. */
export async function concesiones(): Promise<Concesiones> {
  return leer();
}

/**
 * Conceder o quitar. Sólo el dueño.
 *
 * Devuelve el estado nuevo para que la pantalla no tenga que volver a preguntarlo — y para
 * que no pueda quedar enseñando algo distinto de lo que se guardó.
 */
export async function conceder(args: {
  actor: { sub: string; isOwner?: boolean };
  sub: string;
  accion: AccionDelicada;
  dar: boolean;
  /** Acota el permiso a una lista. Sin esto es global, y sólo lo da el dueño del espacio. */
  listId?: number;
}): Promise<{ ok: boolean; error?: string; concesiones?: Concesiones }> {
  const global = args.listId == null;

  // ⚠️ El creador de una lista NO puede dar permiso global: eso le abriría las listas de
  // los demás a alguien que él eligió. Sólo reparte lo que es suyo.
  if (global) {
    if (!args.actor.isOwner) {
      return { ok: false, error: "Sólo el dueño del espacio da permiso sobre todas las listas" };
    }
  } else if (!args.actor.isOwner && !(await creoLaLista(args.actor.sub, args.listId!))) {
    return { ok: false, error: "Sólo quien creó esta lista, o el dueño del espacio, reparte permisos sobre ella" };
  }

  const c = await leer();
  let nuevo: Concesiones;
  if (global) {
    const lista = new Set(c[args.accion]);
    if (args.dar) lista.add(args.sub);
    else lista.delete(args.sub);
    nuevo = { ...c, [args.accion]: [...lista] };
  } else {
    const k = String(args.listId);
    const lista = new Set(c.porLista[k]?.[args.accion] ?? []);
    if (args.dar) lista.add(args.sub);
    else lista.delete(args.sub);
    nuevo = { ...c, porLista: { ...c.porLista, [k]: { ...c.porLista[k], [args.accion]: [...lista] } } };
  }
  await setConfig(LLAVE, JSON.stringify(nuevo));
  return { ok: true, concesiones: nuevo };
}

/** ¿Puede esta persona REPARTIR permisos sobre esta lista? */
export async function puedeConceder(
  user: { sub: string; isOwner?: boolean },
  listId?: number
): Promise<boolean> {
  if (user.isOwner) return true;
  return listId != null && (await creoLaLista(user.sub, listId));
}
