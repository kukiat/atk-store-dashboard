// Central barrel for the API's domain types. Each module's service/plugin
// imports its shapes from here (or from the per-module file) instead of
// re-declaring them alongside the business logic.
export * from "./users";
export * from "./shelfs";
export * from "./crowd";
