
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();

// Render supplies PORT automatically.
// Use 10000 as a fallback for local testing.
const PORT = Number.parseInt(process.env.PORT, 10) || 10000;

const LAYER =
  "https://services.arcgis.com/xOi1kZaI0eWDREZv/ArcGIS/rest/services/NTAD_National_Bridge_Inventory/FeatureServer/0";

const QUERY = LAYER + "/query";

const WARNING =
  "Informational inventory only. FHWA says NBI data should not be used for route-clearance purposes because records may not be current. Verify with the responsible road authority and posted signs. Missing data does not mean safe passage.";

app.disable("x-powered-by");

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST", "OPTIONS"],
  })
);

app.use(express.json({ limit: "2mb" }));

app.use(
  rateLimit({
    windowMs: 60000,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  })
);

const n = (v) =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v))
    ? null
    : Number(v);

function normalize(f) {
  const a = f.attributes || {};
  const g = f.geometry || {};

  return {
    id: a.STRUCTURE_NUMBER_008 || String(a.OBJECTID || ""),
    location: {
      latitude: n(a.LATDD) ?? n(g.y),
      longitude: n(a.LONGDD) ?? n(g.x),
    },
    stateCode: a.STATE_CODE_001 ?? null,
    countyCode: a.COUNTY_CODE_003 ?? null,
    roadCarried: a.FACILITY_CARRIED_007 ?? null,
    featuresIntersected: a.FEATURES_DESC_006A ?? null,
    locationDescription: a.LOCATION_009 ?? null,
    inspectionDate: a.DATE_OF_INSPECT_090 ?? null,
    clearance: {
      inventoryRouteMinimumVerticalClearanceRaw: n(a.MIN_VERT_CLR_010),
      minimumVerticalUnderclearanceRaw: n(a.VERT_CLR_UND_054B),
      underclearanceReferenceFeature: a.VERT_CLR_UND_REF_054A ?? null,
      units: "Raw source values; consult the applicable FHWA data dictionary.",
      interpretation:
        "These inventory attributes are not a verified current clearance for a particular vehicle lane or travel direction.",
    },
    source: {
      name: "USDOT/BTS National Transportation Atlas Database - National Bridge Inventory",
      snapshotDate: "2025-06-20",
      layerUrl: LAYER,
    },
  };
}

function parseBbox(raw) {
  const v = String(raw || "").split(",").map(Number);

  if (v.length !== 4 || !v.every(Number.isFinite)) return null;

  const [west, south, east, north] = v;

  if (
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    west >= east ||
    south >= north ||
    east - west > 5 ||
    north - south > 5
  ) {
    return null;
  }

  return { west, south, east, north };
}

async function queryNbi(bbox, limit = 1000) {
  const p = new URLSearchParams({
    f: "json",
    where: "1=1",
    geometry: JSON.stringify({
      xmin: bbox.west,
      ymin: bbox.south,
      xmax: bbox.east,
      ymax: bbox.north,
      spatialReference: { wkid: 4326 },
    }),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields:
      "OBJECTID,STATE_CODE_001,COUNTY_CODE_003,STRUCTURE_NUMBER_008,FACILITY_CARRIED_007,FEATURES_DESC_006A,LOCATION_009,MIN_VERT_CLR_010,VERT_CLR_UND_REF_054A,VERT_CLR_UND_054B,DATE_OF_INSPECT_090,LATDD,LONGDD",
    returnGeometry: "true",
    outSR: "4326",
    resultRecordCount: String(
      Math.min(Math.max(limit, 1), 1000)
    ),
    orderByFields: "OBJECTID ASC",
  });

  const r = await fetch(QUERY + "?" + p.toString(), {
    signal: AbortSignal.timeout(25000),
  });

  if (!r.ok) {
    throw new Error("Upstream service HTTP " + r.status);
  }

  const data = await r.json();

  if (data.error) {
    throw new Error(data.error.message || "Upstream query failed");
  }

  return {
    data: (data.features || []).map(normalize),
    exceededTransferLimit: Boolean(data.exceededTransferLimit),
  };
}

function haversine(a, b) {
  const rad = (x) => (x * Math.PI) / 180;

  const p1 = rad(a[1]);
  const p2 = rad(b[1]);
  const dp = rad(b[1] - a[1]);
  const dl = rad(b[0] - a[0]);

  const h =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;

  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function validLine(line) {
  if (
    !line ||
    line.type !== "LineString" ||
    !Array.isArray(line.coordinates) ||
    line.coordinates.length < 2 ||
    line.coordinates.length > 10000
  ) {
    return null;
  }

  if (
    !line.coordinates.every(
      (p) =>
        Array.isArray(p) &&
        p.length >= 2 &&
        Number.isFinite(+p[0]) &&
        Number.isFinite(+p[1]) &&
        Math.abs(+p[0]) <= 180 &&
        Math.abs(+p[1]) <= 90
    )
  ) {
    return null;
  }

  return line.coordinates.map((p) => [+p[0], +p[1]]);
}

function nearestVertex(point, coords) {
  let d = Infinity;

  for (const c of coords) {
    d = Math.min(d, haversine(point, c));
  }

  return d;
}

// Home
app.get("/", (_req, res) =>
  res.json({
    name: "RigRoute Bridge Data API",
    version: "1.0.0",
    docs: "/docs",
    health: "/health",
    endpoints: [
      "GET /v1/bridges?bbox=west,south,east,north",
      "POST /v1/bridges/near-route",
    ],
  })
);

// Health check
app.get("/health", (_req, res) =>
  res.json({ status: "ok" })
);

// Bridge search
app.get("/v1/bridges", async (req, res) => {
  const bbox = parseBbox(req.query.bbox);

  if (!bbox) {
    return res.status(400).json({
      error:
        "Provide bbox=west,south,east,north. Each dimension is limited to 5 degrees.",
    });
  }

  try {
    const result = await queryNbi(
      bbox,
      Number(req.query.limit || 1000)
    );

    res.json({
      count: result.data.length,
      exceededTransferLimit: result.exceededTransferLimit,
      bbox,
      warning: WARNING,
      data: result.data,
    });
  } catch (e) {
    console.error("Bridge query failed:", e.message);

    res.status(502).json({
      error: "Bridge data provider unavailable",
      detail: e.message,
    });
  }
});

// Find bridges near a route
app.post("/v1/bridges/near-route", async (req, res) => {
  const coords = validLine(req.body?.route);

  if (!coords) {
    return res.status(400).json({
      error:
        "Send a GeoJSON LineString in route with [longitude,latitude] coordinates.",
    });
  }

  const buffer = Math.min(
    Math.max(Number(req.body.bufferMeters || 500), 50),
    5000
  );

  const lons = coords.map((p) => p[0]);
  const lats = coords.map((p) => p[1]);

  const mid = (Math.min(...lats) + Math.max(...lats)) / 2;

  const latPad = buffer / 111320;
  const lonPad =
    buffer / (111320 * Math.max(Math.cos((mid * Math.PI) / 180), 0.1));

  const bbox = {
    west: Math.max(-180, Math.min(...lons) - lonPad),
    south: Math.max(-90, Math.min(...lats) - latPad),
    east: Math.min(180, Math.max(...lons) + lonPad),
    north: Math.min(90, Math.max(...lats) + latPad),
  };

  if (bbox.east - bbox.west > 5 || bbox.north - bbox.south > 5) {
    return res.status(413).json({
      error: "Route is too large for one query. Split it into shorter sections.",
    });
  }

  try {
    const result = await queryNbi(bbox, 1000);

    const nearby = result.data
      .map((b) => {
        const lat = b.location.latitude;
        const lon = b.location.longitude;

        if (lat === null || lon === null) return null;

        return {
          ...b,
          distanceFromRouteMeters: Math.round(
            nearestVertex([lon, lat], coords)
          ),
        };
      })
      .filter(Boolean)
      .filter((b) => b.distanceFromRouteMeters <= buffer)
      .sort(
        (a, b) =>
          a.distanceFromRouteMeters - b.distanceFromRouteMeters
      );

    res.json({
      count: nearby.length,
      bufferMeters: buffer,
      exceededTransferLimit: result.exceededTransferLimit,
      warning: WARNING,
      note:
        "Nearby points are not proof that a bridge crosses the route. This is not a route-safety determination.",
      data: nearby,
    });
  } catch (e) {
    console.error("Near-route query failed:", e.message);

    res.status(502).json({
      error: "Bridge data provider unavailable",
      detail: e.message,
    });
  }
});

// API documentation
app.get("/docs", (_req, res) =>
  res.type("html").send(`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RigRoute Bridge API</title>
<style>
body{font:16px system-ui;max-width:850px;margin:40px auto;padding:0 18px;line-height:1.6;color:#172536}
code,pre{background:#f1f4f8;padding:5px;border-radius:5px}
pre{padding:14px;overflow:auto}
h1,h2{color:#174a7e}
.warn{background:#fff1d6;padding:14px;border-radius:8px}
</style>
</head>
<body>
<h1>RigRoute Bridge Data API</h1>
<p>REST access to public USDOT/BTS National Bridge Inventory records.</p>
<h2>Health</h2>
<pre>GET /health</pre>
<h2>Bounding box</h2>
<pre>GET /v1/bridges?bbox=-112.3,33.2,-111.8,33.7</pre>
<h2>Near a route</h2>
<pre>POST /v1/bridges/near-route
Content-Type: application/json

{"bufferMeters":500,"route":{"type":"LineString","coordinates":[[-112.074,33.448],[-111.95,33.50]]}}</pre>
<div class="warn">
<b>Safety:</b> FHWA says NBI data should not be used for route-clearance purposes because it may not be current. These records are informational only. Verify restrictions with the responsible authority and posted signs.
</div>
<p>Source: <a href="${LAYER}">${LAYER}</a>, June 20, 2025 snapshot.</p>
</body>
</html>`)
);

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log("RigRoute Bridge Data API listening on port " + PORT);
});
