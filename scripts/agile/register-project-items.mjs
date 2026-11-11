const repo = "GorillaDevLab/shopmate-ai";
const owner = "hannnnnnnny";

class RegistrationError extends Error {}

function check(ok, message) {
  if (!ok) throw new RegistrationError(message);
}

function shape(obj, keys) {
  return obj && typeof obj === "object" && !Array.isArray(obj) &&
    Object.keys(obj).sort().join("|") === keys.split(" ").sort().join("|");
}

const nodeId = (v) => typeof v === "string" && /^[A-Za-z0-9_=-]{1,160}$/.test(v);

function validRow(r) {
  return shape(r,"id number nodeId title") && typeof r.id === "string" &&
    /^(P03-0(19|2\d|3[0-6])|P04-0(3[3-9]|4[0-4]))$/.test(r.id) &&
    Number.isSafeInteger(r.number) && r.number > 0 && nodeId(r.nodeId) &&
    typeof r.title === "string" && /^Prerequisite draft: [^\p{Cc}]{1,180}$/u.test(r.title);
}

export function validate(m) {
  check(shape(m,"version repository projectNumber projectId entries") && m.version === 1 &&
    m.repository === repo && m.projectNumber === 1 && nodeId(m.projectId),"manifest identity");
  check(Array.isArray(m.entries) && m.entries.length >= 1 && m.entries.length <= 30 &&
    m.entries.every(validRow),"manifest entries");
  for (const k of ["id","number","nodeId","title"]) {
    check(new Set(m.entries.map((r) => r[k])).size === m.entries.length,"duplicate entry");
  }
  return m;
}
