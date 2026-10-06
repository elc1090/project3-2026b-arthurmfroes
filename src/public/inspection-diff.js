export function diffInspectionSnapshots(beforeElements, afterElements) {
  const before = new Map((Array.isArray(beforeElements) ? beforeElements : []).map((element) => [element.id, element]));
  const after = new Map((Array.isArray(afterElements) ? afterElements : []).map((element) => [element.id, element]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, element] of after) {
    if (!before.has(id)) added.push({ id, after: element });
    else if (stable(element) !== stable(before.get(id))) changed.push({ id, before: before.get(id), after: element });
  }
  for (const [id, element] of before) if (!after.has(id)) removed.push({ id, before: element });
  return { added, removed, changed };
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
