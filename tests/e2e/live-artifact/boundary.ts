/** Reject hostile object graphs before any schema/parser reads a property value. */
export function hasSafeDataShape(value: unknown): boolean {
  return visit(value, new WeakSet<object>());
}

function visit(value: unknown, ancestors: WeakSet<object>): boolean {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (typeof value !== "object") return false;

  const object = value;
  if (ancestors.has(object)) return false;
  const array = Array.isArray(object);
  if (Object.getPrototypeOf(object) !== (array ? Array.prototype : Object.prototype)) return false;
  if (Object.getOwnPropertySymbols(object).length > 0) return false;

  ancestors.add(object);
  for (const key of Object.getOwnPropertyNames(object)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      ancestors.delete(object);
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor === undefined || "get" in descriptor || "set" in descriptor) {
      ancestors.delete(object);
      return false;
    }
    if (!visit(descriptor.value, ancestors)) {
      ancestors.delete(object);
      return false;
    }
  }
  ancestors.delete(object);
  return true;
}
