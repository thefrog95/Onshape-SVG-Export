# Onshape SVG Export

An Onshape extension that exports **planar faces as true-scale SVG files**,
for laser cutting, plotting, vinyl cutting or documentation.

Open the **SVG Export** panel in a Part Studio, select one or more planar
faces, then click **Export SVG**. You get a preview, a **Download** button and a
**Copy SVG** button for each file.

- Units are millimetres (`width="…mm"`) with a matching `viewBox`, so the file
  imports at 1:1 scale.
- Every boundary of the face is exported, outer outline and holes alike, with
  each loop as one closed path.
- Lines stay lines and circles/arcs become true SVG arcs. Splines and
  ellipses become fine polylines.
- The view is from outside the part, looking at the face. Use **Mirror** to
  cut from the back side.
- Selected faces that lie in the same plane can go into one combined file.
  Faces in different planes are exported separately.
- You can also set a margin and a stroke width.

## How it works

FeatureScript custom features can't write files, so the export runs as an
Onshape *extension app*:

```
Onshape Part Studio ──(SELECTION message)──▶ panel (public/)
                                              │ POST /api/faces
                                              ▼
                                         server.js ──OAuth──▶ Onshape REST API
                                              │   "Evaluate FeatureScript" on the face ids
                                              ▼
                     face plane + edges projected to 2D (mm) ──▶ public/svg.js ──▶ SVG
```

- `lib/featurescript.js` builds the FeatureScript that reads each face's plane
  and bounding edges. It also decodes Onshape's typed JSON result.
- `public/svg.js` joins the edges into closed loops and writes the SVG paths
  and arcs. It has no dependencies and is shared by the browser and the tests.
- `server.js` is a dependency-free Node server. It handles OAuth sign-in,
  keeps tokens in memory and proxies the API call. The browser never sees
  your client secret or the access tokens.

## Setup

### 1. Host the server

The server needs a public **HTTPS** URL. Any Node 20+ host works (Render,
Fly.io, Railway, a VPS, …), or use the included `Dockerfile`. For local
testing, run it behind a tunnel such as `cloudflared tunnel --url http://localhost:3000`.

Set these environment variables (see `.env.example`):

| Variable | Value |
| --- | --- |
| `APP_URL` | Your public HTTPS URL, e.g. `https://svg-export.example.com` |
| `ONSHAPE_CLIENT_ID` | From step 2 |
| `ONSHAPE_CLIENT_SECRET` | From step 2 |
| `PORT` | Port to listen on (default `3000`) |

```sh
npm start
```

### 2. Register the app in the Onshape Developer Portal

At <https://dev-portal.onshape.com>:

1. **OAuth applications → Create new OAuth application**
   - **Redirect URLs:** `APP_URL/oauth/callback`
   - **Permissions:** *Application can read your documents*
   - Copy the client ID and secret into the server's environment.
2. Open the app's **Extensions** tab → **Add extension**
   - **Location:** Element right panel
   - **Context:** Part Studio
   - **Action URL:**
     ```
     APP_URL/?documentId={$documentId}&workspaceOrVersion={$workspaceOrVersion}&workspaceOrVersionId={$workspaceOrVersionId}&elementId={$elementId}&server={$server}
     ```
   - Optionally add an icon.
3. Install the app for your account: create a private store entry and
   subscribe to it. The developer portal walks you through this.

### 3. Use it

Open a Part Studio and click the **SVG Export** icon in the right panel.
Sign in once (a pop-up opens). Select planar faces, then click **Export SVG**.

> Select the faces *after* the panel is open. Onshape only sends selection
> changes to the panel, not what was selected before it opened.

## Development

```sh
npm test      # unit tests (node:test, no dependencies)
npm start     # http://localhost:3000
```

Sessions live in memory, so restarting the server means signing in again.
For several server instances, move `sessions` in `server.js` into a shared
store.
