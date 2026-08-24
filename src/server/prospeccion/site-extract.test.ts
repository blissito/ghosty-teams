/**
 * Los extractores de la pasada al sitio del prospecto.
 *
 * Se prueban sobre HTML con la forma que tiene un sitio de pyme de verdad —enlaces de
 * compartir en el pie, JSON-LD anidado en `@graph`, un `wa.me` con lada de país— porque
 * los falsos positivos de estas funciones son invisibles: una columna con un facebook.com
 * que es el botón de compartir se ve exactamente igual que una con el perfil del negocio,
 * y acaba en un correo dirigido a nadie.
 */
import { describe, it, expect } from "vitest";
import { socialsIn, whatsappIn, jsonLd, phoneIn, hasContactForm } from "./enrich.server";
import { sectorOf, yearsListed } from "./sources/denue";

describe("redes sociales", () => {
  it("saca el perfil del pie de página", () => {
    const html = `<footer>
      <a href="https://www.instagram.com/dental.polanco/">IG</a>
      <a href="https://facebook.com/DentalPolancoMX">FB</a>
      <a href="https://mx.linkedin.com/company/dental-polanco">LI</a>
    </footer>`;
    const s = socialsIn(html);
    // Sin la diagonal final: se guarda hasta el handle, que es lo que identifica al perfil.
    expect(s.instagram).toBe("https://www.instagram.com/dental.polanco");
    expect(s.facebook).toBe("https://facebook.com/DentalPolancoMX");
    expect(s.linkedin).toBe("https://mx.linkedin.com/company/dental-polanco");
  });

  it("IGNORA los botones de compartir, que no son el perfil de nadie", () => {
    const html = `<a href="https://www.facebook.com/sharer/sharer.php?u=https://x.com">Compartir</a>`;
    expect(socialsIn(html).facebook).toBeUndefined();
  });

  it("ignora rutas de la plataforma que no son un negocio", () => {
    expect(socialsIn(`<a href="https://facebook.com/privacy/policy">aviso</a>`).facebook).toBeUndefined();
  });
});

describe("whatsapp", () => {
  it("lo saca de una liga wa.me con lada de país y lo deja a 10 dígitos", () => {
    expect(whatsappIn(`<a href="https://wa.me/5215512345678">Escríbenos</a>`)).toBe("55 1234 5678");
  });
  it("acepta la forma api.whatsapp.com", () => {
    expect(whatsappIn(`<a href="https://api.whatsapp.com/send?phone=525512345678&text=hola">wa</a>`)).toBe("55 1234 5678");
  });
  it("no confunde un id de plugin con un número", () => {
    expect(whatsappIn(`<div class="wa-widget" data-wa="12345">`)).toBeNull();
  });
});

describe("JSON-LD", () => {
  it("recorre @graph anidado, que es como lo emite casi todo generador", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@graph": [{ "@type": "WebSite" }, { "@type": "LocalBusiness", name: "Dental Polanco", telephone: "+52 55 1234 5678", email: "citas@dentalpolanco.mx" }],
    })}</script>`;
    const ld = jsonLd(html);
    expect(ld.email).toBe("citas@dentalpolanco.mx");
    expect(ld.phone).toContain("1234");
  });
  it("un JSON-LD roto no tumba la pasada", () => {
    expect(() => jsonLd(`<script type="application/ld+json">{roto,,}</script>`)).not.toThrow();
  });
});

describe("teléfono", () => {
  it("sólo toma los tel: explícitos", () => {
    expect(phoneIn(`<a href="tel:+525512345678">llámanos</a>`)).toBe("55 1234 5678");
  });
  it("no inventa a partir de un precio", () => {
    expect(phoneIn(`<p>Precio: $1,234,567.89 MXN</p>`)).toBeNull();
  });
});

describe("formulario de contacto", () => {
  it("lo reconoce por sus campos", () => {
    expect(hasContactForm(`<form><input name="nombre"><input type="email"></form>`)).toBe(true);
  });
  it("un buscador no es un formulario de contacto", () => {
    expect(hasContactForm(`<form><input type="search" name="q"></form>`)).toBe(false);
  });
});

describe("sector desde SCIAN", () => {
  it("agrupa consultorios distintos en Salud", () => {
    expect(sectorOf("621211")).toBe("Salud");
    expect(sectorOf("621331")).toBe("Salud");
  });
  it("manufactura cubre 31, 32 y 33", () => {
    expect(sectorOf("311812")).toBe("Manufactura");
    expect(sectorOf("332310")).toBe("Manufactura");
  });
  it("sin código no inventa sector", () => {
    expect(sectorOf(undefined)).toBeNull();
    expect(sectorOf("0")).toBeNull();
  });
});

describe("años en el directorio", () => {
  it("lee el año de una fecha en palabras", () => {
    const esperado = String(new Date().getFullYear() - 2010);
    expect(yearsListed("Julio 2010")).toBe(esperado);
  });
  it("descarta lo imposible en vez de pintar un número absurdo", () => {
    expect(yearsListed("Marzo 1850")).toBeNull();
    expect(yearsListed("")).toBeNull();
  });
});

/**
 * El mapeo de un establecimiento a una fila.
 *
 * ⚠️ Es la prueba que faltaba y la que explica el bug: un campo que no está en el tipo se
 * descarta EN SILENCIO — nada falla, la fila se guarda, y el dato simplemente no existe.
 * Así se perdieron las coordenadas, la antigüedad y el sector desde el primer día.
 */
describe("mapeo del directorio a fila", () => {
  const crudo = {
    Nombre: "Consultorio Dental Polanco",
    Clase_actividad: "Consultorios dentales del sector privado",
    Telefono: "(55) 5512345678",
    Sitio_internet: "dentalpolanco.mx",
    Tipo_vialidad: "CALLE",
    Calle: "Emilio Castelar",
    Num_Exterior: "135",
    Num_Interior: "4",
    Colonia: "Polanco",
    Ubicacion: "Miguel Hidalgo, Ciudad de México",
    CP: "11560",
    Estrato: "6 a 10 personas",
    Codigo_Act: "621211",
    Fecha_Alta: "Julio 2010",
    Latitud: "19.4325",
    Longitud: "-99.1904",
    CLEE: "09016621211000123",
  };

  it("rescata las celdas que antes se tiraban", async () => {
    const { toFound } = await import("./sources/denue");
    const f = toFound(crudo)!;
    expect(f.data?.sector?.v).toBe("Salud");
    expect(f.data?.lat?.v).toBe("19.4325");
    expect(f.data?.lon?.v).toBe("-99.1904");
    expect(f.data?.tamano?.v).toBe("6 a 10 personas");
    expect(f.data?.antiguedad?.v).toBe(String(new Date().getFullYear() - 2010));
  });

  it("la dirección incluye interior y código postal", async () => {
    const { toFound } = await import("./sources/denue");
    expect(toFound(crudo)!.address).toContain("int. 4");
    expect(toFound(crudo)!.address).toContain("11560");
  });

  it("normaliza teléfono y sitio", async () => {
    const { toFound } = await import("./sources/denue");
    const f = toFound(crudo)!;
    expect(f.phone).toBe("55 1234 5678");
    expect(f.website).toBe("https://dentalpolanco.mx");
  });

  it("no crea celdas vacías: sin coordenadas no hay columna que pintar", async () => {
    const { toFound } = await import("./sources/denue");
    const f = toFound({ Nombre: "Tienda", Latitud: "0", Longitud: "" })!;
    expect(f.data?.lat).toBeUndefined();
    expect(f.data?.lon).toBeUndefined();
  });

  it("sin nombre no hay fila", async () => {
    const { toFound } = await import("./sources/denue");
    expect(toFound({ Telefono: "5555555555" })).toBeNull();
  });
});
