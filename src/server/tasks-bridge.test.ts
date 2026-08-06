// La puerta contra el BUCLE. `api.agent.tools.ts` de Tasks reenvía a los conectores de Teams
// cualquier nombre que no reconozca; si este puente hiciera lo mismo con lo desconocido, dos
// servidores se pasarían la pelota hasta el timeout, con una petición HTTP por rebote.
//
// Por eso lo que se prueba primero no es que funcione, sino que un nombre desconocido muera
// AQUÍ — sin un solo fetch.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);
process.env.GHOSTY_PARTNER_SECRET = "secreto-de-prueba";

const { callTasks, toBoardAction, isBoardAction, isWorkspaceAction, teamsToolNames } = await import(
  "./tasks-bridge.server"
);

beforeEach(() => fetchSpy.mockReset());

describe("la puerta del bucle", () => {
  it("un nombre inventado NO sale de Teams", async () => {
    const r = await callTasks("acme", "ana", 1, "task_zzz", {});
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("no permitida");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // El caso que crea el bucle de verdad: un nombre de conector de Teams. Tasks lo reenviaría
  // de vuelta a Teams, y Teams —si no fuera por esto— otra vez a Tasks.
  it("un nombre de conector de Teams tampoco sale", async () => {
    for (const n of ["github_list_repos", "sentry_list_issues", "form_create"]) {
      const r = await callTasks("acme", "ana", 1, n, {});
      expect(r.ok).toBe(false);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("el nombre INTERNO de Tasks tampoco: sólo se acepta el prefijado", async () => {
    const r = await callTasks("acme", "ana", 1, "create_task", {});
    expect(r.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("mapeo de nombres", () => {
  it("cada tool de Teams apunta a una acción real de tablero", () => {
    const names = teamsToolNames();
    // 12 de tablero + las 2 de espacio (list_boards / create_board).
    expect(names.length).toBe(14);
    for (const n of names) {
      const inner = toBoardAction(n);
      expect(inner, n).not.toBeNull();
      expect(isBoardAction(inner!), inner!).toBe(true);
    }
  });

  it("todas llevan el prefijo, o colisionarían con otras tools del turno", () => {
    for (const n of teamsToolNames()) expect(n.startsWith("task_")).toBe(true);
  });
});

describe("la llamada", () => {
  const ok = (result: unknown) =>
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, result }) });

  it("va al Tasks del workspace y lleva el origen como header", async () => {
    ok({ id: 7 });
    await callTasks("acme", "ana", 3, "task_create", { title: "x" });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://acme.tasks.ghosty.studio/api/agent/tools");
    expect(init.headers["x-ghosty-origin"]).toBe("https://acme.tasks.ghosty.studio");
    // Traduce al nombre interno: Tasks no conoce `task_create`.
    expect(JSON.parse(init.body)).toEqual({ action: "run", name: "create_task", args: { title: "x" } });
  });

  it("el token lleva el sub y el TABLERO, que es lo que acota la sesión", async () => {
    ok({});
    await callTasks("acme", "ana", 42, "task_board_read", {});
    const auth = fetchSpy.mock.calls[0][1].headers.authorization as string;
    const payload = JSON.parse(
      Buffer.from(auth.replace("Bearer ", "").split(".")[0], "base64url").toString()
    );
    expect(payload.sub).toBe("ana");
    expect(payload.projectId).toBe(42);
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  // Tasks contesta 200 con {ok:false} en errores de validación a propósito, para que el
  // modelo lea el motivo y reintente. Convertirlo en excepción le quitaría esa información.
  it("propaga el motivo de un error de validación", async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: false, error: "falta title" }) });
    const r = await callTasks("acme", "ana", 1, "task_create", {});
    expect(r).toEqual({ ok: false, error: "falta title" });
  });

  it("una caja dormida que no responde da un error legible, no un throw", async () => {
    // ⚠️ `mockImplementationOnce` y lanzando SÍNCRONO, las dos cosas a propósito. Con un
    // rechazo asíncrono —`mockRejectedValue` o un mock `async` que lanza— vitest lo reporta
    // ADEMÁS como error no manejado y pinta la prueba en rojo aunque el valor devuelto sea
    // el correcto: se ve como un fallo de `callTasks` y no lo es. El `try` cubre las dos
    // formas igual.
    fetchSpy.mockImplementationOnce(() => {
      throw new Error("timeout");
    });
    const r = await callTasks("acme", "ana", 1, "task_board_read", {});
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("Tasks");
  });
});

describe("alcance de espacio", () => {
  // Existen porque el token lleva el tablero DENTRO: "créame un tablero" no puede traer uno.
  it("sólo crear y listar tableros son de espacio", () => {
    expect(isWorkspaceAction("task_boards")).toBe(true);
    expect(isWorkspaceAction("task_board_create")).toBe(true);
    for (const n of ["task_create", "task_move", "task_board_read", "task_delete"])
      expect(isWorkspaceAction(n), n).toBe(false);
  });

  it("van con projectId 0, que es lo que Tasks acepta para ellas", async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, result: {} }) });
    await callTasks("acme", "ana", 0, "task_board_create", { name: "Marketing" });
    const auth = fetchSpy.mock.calls[0][1].headers.authorization as string;
    const payload = JSON.parse(
      Buffer.from(auth.replace("Bearer ", "").split(".")[0], "base64url").toString()
    );
    expect(payload.projectId).toBe(0);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).name).toBe("create_board");
  });
});
