// Wires the app's own parts (src/app.ts) into the MAPLE kit. Usually nothing to change here.
import manifest from "../maple.json" with { type: "json" };
import { createMapleApp, type Manifest } from "./maple/kit.ts";
import { guide, home, routes, schema, tools } from "./app.ts";

const { app } = createMapleApp({ manifest: manifest as Manifest, slug: "app", schema, guide, tools, routes: routes as never, home });

export default app;
