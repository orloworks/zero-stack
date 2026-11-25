// Your feature switches: declare a feature by adding its name to FEATURES. Gate a route with `await requireFeature(c, "name")` (src/access.ts: it replaces
// requireAuth(c) and returns the user); read `await features(c)` in a loader to show or hide UI. An admin sets each feature on, off or kill switch on the Features page.
// This file holds only the list, so an upgrade never conflicts with it. The scaffold ships one example, `example-feature`, and the route routes/api/example-feature.ts
// that gates on it: replace both (change the route to match), or empty the list.
export const FEATURES = ["example-feature"] as const;
