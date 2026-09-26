// Estado de una tarjeta de Ghosty Ads: se lee al pintar y se relee con cada `refresh` del room
// (cada botón, versión o edición publica uno). Compartido por las tres tarjetas.
import { useCallback, useEffect, useState } from "react";
import { useRtSubscribe } from "../../utils/rt-bus";

export function useAdsCard<T>(load: () => Promise<T>, channelId: number) {
  const [st, setSt] = useState<T | null>(null);
  const refresh = useCallback(() => {
    load().then(setSt).catch(() => {});
  }, [load]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useRtSubscribe({
    onEvent: (ev) => {
      if (ev.t === "refresh" && ev.channelId === channelId) refresh();
    },
  });
  return { st, refresh };
}
