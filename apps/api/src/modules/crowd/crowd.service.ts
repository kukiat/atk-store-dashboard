import { Elysia } from "elysia";
import type { CrowdEvent } from "../../models";
import { CROWD_MAX, CROWD_START } from "../../constants";
import { clamp } from "../../utils";

// In-memory ambient-crowd target: how many *random* (non-roster) shoppers the
// 3D store should keep on the floor. A single scalar, NOT a roster — random
// shoppers carry no user record and never appear in /users. Backdoor's +/-
// stepper drives it; the scene reconciles its random population toward the
// target, spawning/despawning through the right-side doors.
class CrowdService {
  private target = CROWD_START; // opening random crowd (independent of the API roster)
  private listeners = new Set<(e: CrowdEvent) => void>();

  // event hub — the SSE route subscribes, mutations broadcast
  subscribe(fn: (e: CrowdEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: CrowdEvent) {
    for (const fn of this.listeners) fn(e);
  }

  get() {
    return { target: this.target, max: CROWD_MAX };
  }

  set(next: number) {
    this.target = clamp(next);
    this.emit({ type: "crowd", target: this.target });
    return { target: this.target, max: CROWD_MAX };
  }
}

export const crowdService = new Elysia({ name: "crowd.service" }).decorate(
  "crowdService",
  new CrowdService(),
);
