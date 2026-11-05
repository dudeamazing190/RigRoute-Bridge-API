# RigRoute Bridge Data API

A Node.js REST API that normalizes public USDOT/BTS National Bridge Inventory (NBI) records.

## Important safety limitation
This is an informational inventory lookup, **not an RV-safe routing service**. FHWA explicitly warns that NBI data should not be used for route-clearance purposes because records may not be current: https://www.fhwa.dot.gov/bridge/nbi/nbi_data.cfm

The API preserves two different source attributes separately:
- `MIN_VERT_CLR_010`: inventory-route minimum vertical-clearance attribute.
- `VERT_CLR_UND_054B`: minimum vertical underclearance attribute, with its reference-feature code.

Raw values are returned without guessing units or whether they apply to the exact travel lane, direction, or opening. A point near a route does not prove a bridge crosses it. Missing records never mean safe passage.

## Run locally
Requires Node.js 20+.
1. Extract this ZIP and open the folder in VS Code.
2. Open a terminal in the folder.
3. Run `npm install`
4. Run `npm start`
5. Open http://localhost:3000/docs

No upstream API key is required. The service has a basic 60-requests-per-minute per-IP limit.

## Endpoints
- `GET /health`
- `GET /v1/bridges?bbox=west,south,east,north`
- `POST /v1/bridges/near-route`

Example route request:
```json
{
  "bufferMeters": 500,
  "route": {
    "type": "LineString",
    "coordinates": [[-112.074, 33.448], [-111.95, 33.50]]
  }
}
```
GeoJSON coordinate order is longitude, latitude. Requests are bounded; long routes must be split into sections. `exceededTransferLimit` warns when the upstream service reports a record cap.

## Deploy
The included Dockerfile supports a Node/Docker hosting provider. Set the start command to `npm start`, expose the host-provided port, and set `CORS_ORIGIN` to approved origins for production. After deployment, verify `/health` and `/docs`, then use the HTTPS base URL in RigRoute.

## Before commercial/safety-related use
Add state DOT and local authority feeds; PostGIS route/bridge intersection logic; field units and version-specific metadata; data freshness monitoring; API keys, customer quotas and billing; tests, monitoring, backups, and uptime commitments. This initial version does not store user route data and is not a certified clearance database.
