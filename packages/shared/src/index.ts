/**
 * Shared code used across the workspace (web + api).
 * Placeholder to prove cross-package linking works.
 */

export const API_VERSION = "0.1.0";

export type HealthStatus = {
  status: "ok";
  version: string;
  timestamp: string;
};
