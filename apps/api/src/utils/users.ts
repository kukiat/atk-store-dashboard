import type { ExternalUser, User, UserStatus } from "../models";
import { FEMALE_NAMES, MALE_NAMES } from "../constants";

// external `visit_status` → our UserStatus, or null to drop the row.
// exited → outside; a value already a UserStatus passes through as-is;
// null and every unrecognized value are filtered out of the boot roster.
export function mapVisitStatus(v: string | null): UserStatus | null {
  switch (v) {
    case "inside":
    case "outside":
    case "waiting":
    case "paying":
      return v;
    case "exited":
      return "outside";
    default:
      return null;
  }
}

// The external feed carries no gender, but the 3D sim needs one to pick a body
// model. Best-effort: match the first name token against a small dictionary
// (see ../constants/users); when the name gives no signal, fall back to id
// parity so it's stable per boot.
export function guessGender(name: string, id: number): User["gender"] {
  const first = name.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (FEMALE_NAMES.has(first)) return "female";
  if (MALE_NAMES.has(first)) return "male";
  return id % 2 === 0 ? "female" : "male";
}

// Fetch the crowd from external. At module load a failure here rejects the
// top-level await in users.service, which aborts server startup — external
// must be up. Also called at runtime by refreshRoster (Backdoor's reload
// button), where a failure is caught and turned into a 502 instead of killing
// the process.
export async function fetchBootRoster(): Promise<User[]> {
  const url = `${process.env.ATK_STORE_API_URL}/animation-api/users`;
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(
      `users boot roster fetch failed: ${res.status} ${res.statusText}`,
    );
  const rows = (await res.json()) as ExternalUser[];
  return rows.flatMap((u) => {
    const status = mapVisitStatus(u.visit_status);
    if (status === null) return []; // drop visit_status null / unrecognized
    const user: User = {
      id: u.id,
      name: u.name,
      gender: guessGender(u.name, u.id),
      status,
      shelf_id: null,
      email: u.email,
      avatar_url: u.avatar_url ?? "", // null → "" (UI falls back to initials)
      auth_method: "google", // external only ever shows Google logins
    };
    return [user];
  });
}
