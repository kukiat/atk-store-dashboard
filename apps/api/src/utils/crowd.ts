import { CROWD_MAX } from "../constants";

// clamp a requested crowd target into the valid [0, CROWD_MAX] range, rounded.
export const clamp = (n: number) => Math.max(0, Math.min(CROWD_MAX, Math.round(n)));
