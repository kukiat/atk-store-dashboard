# atk-store-dashboard

A 3D smart-store dashboard that visualises a live retail floor in real time. A
Babylon.js scene renders the store — shoppers walking in through the gates,
browsing shelves, picking and returning items — while a Bun/Elysia API fuses
three live data sources behind it: an external **ATK store API** (the shopper
roster), an external **IoT devices API** (the shelf/gondola layout and stock),
and an **MQTT loadcell feed** (per-pick weight events and device
online/offline heartbeats). Shelf doors, LEDs, stock counts and shopper
gestures all update from real events, not simulation.

The repo is a demo/prototype for the ATK smart-store concept, kept as a single
Bun workspace monorepo.

## What it demonstrates

- **Live 3D store scene** — a full retail floor with animated shoppers, entry/exit
  fare-gates, per-seam shelf locks, procedural pick/return arm gestures, a
  stacked "Floor 2" view and escalators.
- **Real-time data pipeline** — Server-Sent Events push roster changes, shelf
  online-status, stock updates and pick/return gestures from the API straight
  into the scene.
- **MQTT loadcell integration** — the API subscribes to a loadcell broker and
  attributes weight events to the shopper browsing that shelf.
- **Operator backdoor** — a hidden `/backdoor` admin route to drive the users
  API (check-in, verify, checkout, payment, roster refresh) without curl.

## Architecture

```
atk-store-dashboard/            Bun workspace monorepo
├─ apps/
│  ├─ web/     Vite + React + Babylon.js/Three.js  (the 3D dashboard)
│  └─ api/     Bun + Elysia + Drizzle + MQTT        (the data/event backend)
└─ packages/
   └─ shared/  code shared across web + api (API_VERSION, shared types)
```

**Data flow**

```
ATK store API ─┐
IoT devices API ┼─► apps/api (Elysia) ──REST + SSE──► apps/web (Babylon scene)
MQTT loadcell ─┘
```

The API is largely in-memory: the shelf layout and shopper roster are fetched
live from the external services (per request / at boot), MQTT is the runtime
authority for device online-state and stock, and Postgres backs only the
`groups` module. The scene subscribes to the API's SSE streams and mutates the
3D world as events arrive.

### Web routes

The web app exposes several 3D "versions" plus a hidden admin route:

| Route       | What it is                                                  |
| ----------- | ----------------------------------------------------------- |
| `/v5`       | **Smart Shelf Dashboard** (Babylon.js) — the default        |
| `/v1`       | Smart Logistics Network (Three.js)                          |
| `/v2`       | Smart Shelf · Live Aisle (Three.js)                         |
| `/v3`       | Shelf Designer — drag products onto a 3D shelf              |
| `/backdoor` | Hidden operator admin for the users API (not linked anywhere) |

`/` redirects to `/v5`.

### API modules

Elysia plugins under `apps/api/src/modules`, each a REST resource with an SSE
event stream where relevant:

- **users** — shopper roster + status lifecycle (check-in → verify → inside →
  browsing → paying → left), driven by the external ATK store API.
- **shelfs** — shelf/gondola layout and stock, fetched live from the IoT
  devices API; MQTT drives online-status and stock changes.
- **sessions** — ledger that attributes MQTT loadcell events to the shopper
  browsing a given device.
- **crowd** — random background-shopper population target.
- **groups** — the one Postgres-backed resource (via Drizzle).

Interactive API docs (Swagger) are served at `/swagger` when the API is running.

## Prerequisites

- [**Bun**](https://bun.sh) (the runtime, package manager and bundler for the whole repo)
- A **PostgreSQL** database URL — required for the API to boot (the `groups`
  module connects on startup and throws if `DATABASE_URL` is missing)
- Optional, for full functionality: access to the external **ATK store API**,
  **IoT devices API**, and an **MQTT** broker

## Setup

```bash
# from the repo root
bun install
```

Create the two env files from their examples:

```bash
cp apps/api/.env.example apps/api/.env    # fill in DATABASE_URL (required)
cp apps/web/.env.example apps/web/.env    # defaults to http://localhost:3004
```

### API environment (`apps/api/.env`)

| Variable               | Required | Purpose                                                              |
| ---------------------- | -------- | -------------------------------------------------------------------- |
| `DATABASE_URL`         | **Yes**  | Postgres connection string (SSL via `sslmode=require` in the URL)    |
| `PORT`                 | No       | API port (defaults to `3004`)                                        |
| `ATK_STORE_API_URL`    | No\*     | Base URL of the external ATK store API (shopper roster)              |
| `IOT_API_URL`          | No\*     | Base URL of the external IoT devices API (shelf layout is `/devices`) |
| `IOT_API_KEY`          | No\*     | Sent as `x-iot-api-key` on every IoT request                         |
| `MQTT_URL`             | No       | Loadcell broker host/URL — if unset, the loadcell feed is skipped    |
| `MQTT_CONNECT_USE_TLS` | No       | `true` to use `mqtts://` when `MQTT_URL` has no scheme               |
| `MQTT_USERNAME`        | No       | MQTT credentials (optional)                                          |
| `MQTT_PASSWORD`        | No       | MQTT credentials (optional)                                          |

\* Not required to boot, but the shelfs/users features fetch from these on
request — without them those endpoints will fail when called.

### Web environment (`apps/web/.env`)

| Variable       | Default                  | Purpose                       |
| -------------- | ------------------------ | ----------------------------- |
| `VITE_API_URL` | `http://localhost:3004`  | Base URL the web app calls    |

## Running

From the repo root:

```bash
bun run dev        # runs web + api together
bun run dev:web    # web only  → http://localhost:3003
bun run dev:api    # api only  → http://localhost:3004  (Swagger at /swagger)
```

The Babylon scene won't mount until it can load data from the API, so start the
API (or point `VITE_API_URL` at a running one) before expecting the dashboard
to render.

### Build

```bash
bun run build      # build the web app (apps/web/dist)
bun run build:api  # bundle the API   (apps/api/dist)
bun run start:api  # run the bundled API
```

### Database (groups module)

Drizzle is configured for schema introspection against the live database:

```bash
cd apps/api
bun run db:pull    # pull the schema from DATABASE_URL
bun run db:studio  # open Drizzle Studio
```

## Project structure

```
apps/web/src
├─ App.jsx            route table (VERSIONS map + /backdoor)
├─ api.js             central apiFetch (reads VITE_API_URL, unwraps the envelope)
├─ components/        Dashboard, Backdoor, ThreeScene, ShelfDesigner
└─ scenes/            Babylon + Three.js scene factories

apps/api/src
├─ index.ts           Elysia app: mounts module plugins + starts MQTT
├─ envelope.ts        { data, error, success } response envelope
├─ modules/           users · shelfs · sessions · crowd · groups (REST + SSE)
├─ mqtt/              loadcell broker client + event types
├─ models/            external-feed shapes (IoT devices, ATK users)
├─ db/                Drizzle client + schema (Postgres, groups only)
└─ utils/             external fetch helpers (shelfs, users)

packages/shared/src   API_VERSION + shared types
```

## Tech stack

- **Web** — React 18, React Router 7, Vite 5, Babylon.js 7 (primary engine),
  Three.js (legacy scenes), GSAP
- **API** — Bun, Elysia, Drizzle ORM + `postgres`, `mqtt`, Swagger
- **Tooling** — Bun workspaces, TypeScript
