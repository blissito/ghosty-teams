import { describe, it, expect } from "vitest";
import { humanAgentError } from "./agent-error";

describe("humanAgentError", () => {
  it("traduce los errores vistos en la auditoría", () => {
    expect(humanAgentError(new Error('fleet-stream 404 {"error":"turno no existe"}'))).toBe("el turno se perdió de su lado");
    expect(humanAgentError("persistent session ended mid-turn")).toBe("se cortó la conexión a media respuesta");
    expect(humanAgentError("connect ECONNREFUSED 172.20.0.19:8080")).toBe("su computadora no respondió");
  });
  it("nunca deja IPs, JSON ni URLs", () => {
    const out = humanAgentError("raro en 172.20.0.5 con {\"a\":1} y https://x.y/z");
    expect(out).not.toMatch(/172\.20|\{|https?:/);
  });
});
