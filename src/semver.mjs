const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseSemver(value) {
  const match = SEMVER.exec(String(value || ""));
  if (!match) return null;
  return {
    raw: match[0],
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] || "",
  };
}

export function cmpSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return String(left).localeCompare(String(right));
  for (let i = 0; i < 3; i += 1) {
    if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] - b.numbers[i];
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

export function bestVersion(versions) {
  return versions.reduce((best, item) => (!best || cmpSemver(item, best) > 0 ? item : best), null);
}
