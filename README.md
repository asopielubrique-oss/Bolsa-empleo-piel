# Portal de Empleo · Piel de Ubrique

Portal de empleo sectorial para la industria de la marroquinería de Ubrique, gestionado por [Asopiel](https://asopiel.com).

## Descripción

- **Empresas** (demanda de empleo): se registran, publican ofertas con categoría de oficio y describen las tareas requeridas.
- **Trabajadores** (oferta de empleo): se registran, añaden su historial laboral con certificados de empresa y quedan visibles para empresas del sector.
- **Admin (Asopiel)**: aprueba registros, valida certificados, desbloquea perfiles para cada oferta, supervisa el panel de métricas.

## URL de producción

[portalmarroquineria.asopiel.com](https://portalmarroquineria.asopiel.com)

## Tecnología

- **Cloudflare Worker** (API REST + HTML embebido en un solo archivo)
- **Cloudflare KV** para persistencia de datos
- **Resend** para emails transaccionales desde `oficina@asopiel.com`
- **jsPDF** (cliente) para generación de certificados PDF

## Despliegue

El despliegue es automático vía GitHub Actions al hacer push a `main`.

### Secretos necesarios en el repo

| Secreto | Descripción |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Token de la API de Cloudflare con permisos de Worker edit |

### Bindings de KV en Cloudflare

| Variable | Namespace | ID |
|---|---|---|
| `BOLSA_KV` | `BOLSA_EMPLEO_KV` | `c84822a7c203496cae0874b1b2d8ee10` |

### Secretos del Worker (en Cloudflare dashboard)

| Secreto | Descripción |
|---|---|
| `RESEND_API_KEY` | API key de Resend para emails |

## Inicialización del admin

Tras el primer despliegue, llamar una vez a:

```
POST https://bolsa-empleo-piel.asopielubrique.workers.dev/seed
```

Credenciales iniciales: `admin@asopiel.es` / `asopiel2024`

## Dominio personalizado

CNAME en DNS de asopiel.com:
```
portalmarroquineria  →  bolsa-empleo-piel.asopielubrique.workers.dev
```
