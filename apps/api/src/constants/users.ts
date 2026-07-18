// Name dictionaries used to best-effort guess a gender for the external boot
// roster (the feed carries no gender). Consumed by guessGender in ../utils/users.
export const FEMALE_NAMES = new Set([
  "mali", "pimchanok", "siriporn", "emma", "olivia",
  "ploy", "fah", "napat", "kanya", "waan",
]);
export const MALE_NAMES = new Set([
  "narin", "tanawat", "buncha", "kukiat", "keemmer",
  "james", "liam", "noah", "somchai", "anan",
]);
