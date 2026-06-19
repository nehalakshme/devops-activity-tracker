# DevOps Work Tracker

A multi-user dashboard for tracking a DevOps engineer's work — home overview,
daily checklist, tasks (with due dates, assignment & dependencies), per-environment
pipeline checklists, maintenance, POCs, a unified daily timeline, a dependency
graph, recurring rules, tags, and an audit trail — all backed by **Elasticsearch**
with full-text search.

## Stack

- **Backend:** Node.js + Express (ES modules)
- **Storage/search:** Elasticsearch 8.x via `@elastic/elasticsearch`
- **Auth:** JWT (`jsonwebtoken`) + bcrypt (`bcryptjs`); accounts stored in ES
- **Recurrence:** `cron-parser` for custom cron schedules
- **Frontend:** plain HTML / CSS / JS (no framework), dark theme, Inter font,
  [Lucide](https://lucide.dev) icons (installed via npm, served locally)
- **Config:** `dotenv`

## Prerequisites

- Node.js 18+
- A running Elasticsearch 8.x (default `http://127.0.0.1:9200`)

### Quick Elasticsearch via Docker

```bash
docker run -d --name es-devtracker -p 9200:9200 \
  -e "discovery.type=single-node" \
  -e "xpack.security.enabled=false" \
  -e "ES_JAVA_OPTS=-Xms512m -Xmx512m" \
  docker.elastic.co/elasticsearch/elasticsearch:8.14.0
```

> **Windows note:** if `localhost:9200` times out but `127.0.0.1:9200` works, it's
> the IPv6 (`::1`) + Docker port-forward quirk. The bundled `.env` uses
> `http://127.0.0.1:9200` to avoid it.

> **Data persistence:** this container has **no volume mounted**, so data survives
> `stop`/`start` and reboots but is lost if the container is removed. For durable
> storage add `-v esdata:/usr/share/elasticsearch/data`.

## Setup

```bash
npm install
# ensure .env exists (a working one is bundled; .env.example is provided)
npm start
```

Open **http://127.0.0.1:3000**, click **Register** to create an account, and log in.
On startup the server auto-creates all indices with their mappings (and additively
syncs new fields onto existing ones), retrying the ES connection every 10s if ES
isn't up yet (the UI still serves meanwhile).

## Configuration (`.env`)

| Var | Default | Notes |
|-----|---------|-------|
| `ES_NODE` | `http://127.0.0.1:9200` | Elasticsearch endpoint |
| `ES_USERNAME` / `ES_PASSWORD` | _(blank)_ | only if ES security is enabled |
| `ES_TLS_REJECT_UNAUTHORIZED` | `false` | set for self-signed HTTPS clusters |
| `PORT` | `3000` | HTTP server port |
| `JWT_SECRET` | `dev-change-me…` | **change to a long random string**; signs login tokens |
| `JWT_EXPIRES_IN` | `7d` | token lifetime |

## Authentication & ownership

- **Register / login** at the login screen. Accounts are stored in the `users`
  index with **bcrypt-hashed** passwords ([src/routes/auth.js](src/routes/auth.js)).
  Login issues a **JWT**, kept in `localStorage` and sent as `Authorization: Bearer`
  on every call. All `/api/*` routes except `/api/auth/*` and `/api/health` require
  a valid token. *(This is local JWT auth, not third-party OAuth.)*
- **Ownership model (all entities):** anyone signed in can **view everything**, but
  you can **edit/delete** an item only if you **created** it, are **assigned** to it,
  or it's marked **`common`** — otherwise the API returns `403`.
- **Tasks** are assignable: pick an assignee (any user) or **`common`** on the create
  form / Edit dialog; reassignment is audited.
- Daily Checklist and Pipeline checklists are created as `common` (collaborative);
  other entities default to creator-owned.

## Pages

- **🏠 Home** — greeting + your overdue / due-today / this-week / today's tasks.
- **✅ Checklist** — date-scoped categories (Pre-Requisites / API-Services / UI-Services) with add-able sub-items.
- **📋 Tasks** — create with priority, due date (optional), tags, assignee, prerequisite; sorted high→low priority; overdue/SLA flags + a global overdue badge; inline status dropdown + note; Edit dialog; 📜 history drawer.
- **🔧 Pipelines** — per-environment checklists: **dev / test / qa / production** sub-tabs, each with API-Services / UI-Services checkable items.
- **🛠️ Maintenance** — release log (environment, release version, notes, date — no future dates).
- **🧪 POCs** — Concept→Started→In-Progress→Completed→Documented cards; advance + "spawn task".
- **🕒 Timeline** — auto-logged daily activity, summary stats, HTML/TXT export, filter chips, date picker.
- **🔗 Graph** — dependency graph: left-to-right flow, click a node to focus its sub-graph, **drag node→node to link (parent→child)**, click an arrow to delete it.
- **↻ Recurring** — recurring task/maintenance rules (daily/weekly/monthly/cron), pause/resume/delete; a background job generates due instances every 5 min.
- **🏷️ Tags / 📊 Tag Overview** — tag library (create/recolor/delete) + open/closed counts per tag.
- **📜 Audit Log** — full activity trail (tab hidden by default; per-item history drawers stay active).

## Indices

`users`, `checklist_items`, `daily_tasks`, `pipelines`, `pipeline_checks`,
`maintenance`, `pocs`, `timeline_events`, `activity_log`, `relationships`,
`recurrence_rules`, `tags` — full mappings in [src/indices.js](src/indices.js).
Every document uses the ES auto-generated `_id`.

## API

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/auth/register`, `/api/auth/login` | create account / log in (returns JWT) |
| GET | `/api/auth/me` | current user from token |
| GET | `/api/users` | registered users (assignment dropdown) |
| GET / POST | `/api/checklist` · PATCH/DELETE `/:id` | daily checklist items |
| GET / POST | `/api/daily-tasks` · PATCH `/:id` | tasks + status/edits |
| GET | `/api/daily-tasks/due` | open tasks with a due date (Home/SLA views) |
| GET / POST | `/api/pipeline-checks` · PATCH/DELETE `/:id` | per-env pipeline checklist |
| GET / POST | `/api/pipelines` · PATCH `/:id` | legacy pipeline runs (not used by UI) |
| GET / POST | `/api/maintenance` | maintenance log |
| GET / POST | `/api/pocs` · PATCH `/:id` | POCs + status advancement |
| GET | `/api/timeline` · `/summary` · `/export` | daily feed / stats / report |
| GET | `/api/activity-log` · `/entity/:type/:id` | audit trail |
| POST / DELETE | `/api/relationships` · `/:id` | create / delete links |
| GET | `/api/relationships/graph` · `/children/:type/:id` | graph data / children |
| GET / POST / PATCH / DELETE | `/api/recurrence-rules` (+ `POST /run-now`) | recurring rules |
| GET / POST / PATCH / DELETE | `/api/tags` · `/overview` · `/:name/items` | tags |
| GET | `/api/search?q=&type=&from=&to=&environment=&status=` | global ES search (supports `tag:name`) |
| GET | `/api/health` | ES connectivity check |

PATCH endpoints use the ES `update` API; list endpoints use `search` with filters,
and enforce the ownership rules (creator / assignee / `common`).

## How timeline events work

Timeline events are **never created by hand** — the backend indexes a
`timeline_events` document on completion-style actions: a checklist/pipeline item
checked, a task marked `done`, a pipeline `pass`/`fail`, maintenance logged, a POC
created/advanced, a recurrence instance generated. Events are dated by the source
item's own date.

## Search

`/api/search` runs a `multi_match` (`fuzziness: AUTO`) across tasks, pipelines,
maintenance, POCs, timeline, audit log and tags; supports `tag:<name>` syntax (an ES
`terms` filter), optional date/environment/status filters, groups results by index,
and bolds matches via the ES `highlight` API. No `LIKE`-style filtering in code.

## Project layout

```
server.js                 Express app, auth gate, static + /vendor/lucide, ES bootstrap
src/
  auth.js                 JWT sign/verify, authRequired, canEdit/ownership
  esClient.js             configured ES client
  indices.js              index mappings + auto-create / additive sync
  activity.js             audit-log helper
  timeline.js             timeline auto-logging helper
  links.js                relationship side-effects + open-children check
  recurrence.js           schedule math + 5-min generator
  util.js                 date / hit-mapping / terminal-status helpers
  routes/*.js             one router per feature (auth, users, checklist, dailyTasks,
                          pipelines, pipelineChecks, maintenance, pocs, timeline,
                          search, activityLog, relationships, recurrenceRules, tags)
public/
  index.html              SPA shell (login screen + tabbed dashboard)
  styles.css              dark theme / design system
  app.js                  all frontend logic
node_modules/lucide/      icon library, served at /vendor/lucide
```
