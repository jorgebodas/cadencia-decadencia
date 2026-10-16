// Tiny JSON Schema (2020-12 subset) validator, enough for data/schema/*.json without adding
// dependencies: type (incl. arrays/null), const, enum, required, properties,
// additionalProperties:false, items, minItems/maxItems, minimum/maximum, minLength/maxLength,
// pattern and local $ref.

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const matchesType = (v, t) => t === typeOf(v) || (t === 'number' && typeof v === 'number' && Number.isFinite(v));

export function validate(schema, data) {
  const errors = [];
  const resolve = (ref) => ref.replace(/^#\//, '').split('/').reduce((o, k) => o[k], schema);
  const walk = (s, v, at) => {
    if (s.$ref) return walk(resolve(s.$ref), v, at);
    if (s.type) {
      const types = [].concat(s.type);
      if (!types.some((t) => matchesType(v, t))) return errors.push(`${at}: expected ${types.join('|')}, got ${typeOf(v)}`);
    }
    if ('const' in s && v !== s.const) errors.push(`${at}: must be ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.includes(v)) errors.push(`${at}: must be one of ${s.enum.join(', ')}`);
    if (v === null) return;
    if (typeof v === 'number') {
      if (s.minimum != null && v < s.minimum) errors.push(`${at}: ${v} < minimum ${s.minimum}`);
      if (s.maximum != null && v > s.maximum) errors.push(`${at}: ${v} > maximum ${s.maximum}`);
    }
    if (typeof v === 'string') {
      if (s.minLength != null && v.length < s.minLength) errors.push(`${at}: shorter than ${s.minLength}`);
      if (s.maxLength != null && v.length > s.maxLength) errors.push(`${at}: longer than ${s.maxLength}`);
      if (s.pattern && !new RegExp(s.pattern).test(v)) errors.push(`${at}: "${v}" does not match ${s.pattern}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems != null && v.length < s.minItems) errors.push(`${at}: fewer than ${s.minItems} items`);
      if (s.maxItems != null && v.length > s.maxItems) errors.push(`${at}: more than ${s.maxItems} items`);
      if (s.items) v.forEach((item, i) => walk(s.items, item, `${at}[${i}]`));
    } else if (typeof v === 'object') {
      for (const key of s.required || []) if (!(key in v)) errors.push(`${at}: missing "${key}"`);
      for (const [key, val] of Object.entries(v)) {
        if (s.properties?.[key]) walk(s.properties[key], val, `${at}.${key}`);
        else if (s.additionalProperties === false) errors.push(`${at}: unexpected property "${key}"`);
      }
    }
  };
  walk(schema, data, '$');
  return errors;
}
