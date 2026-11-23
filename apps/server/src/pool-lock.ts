// Bound temporary uploads and committed attachments to the same disk allowance.
const owners = new Map<string, Promise<void>>();

export async function withOwnerPool<T>(id: string, action: () => Promise<T>): Promise<T> {
  const previous = owners.get(id) ?? Promise.resolve();
  const result = previous.then(action);
  const tail = result.then(
    () => {},
    () => {},
  );
  owners.set(id, tail);
  try {
    return await result;
  } finally {
    if (owners.get(id) === tail) owners.delete(id);
  }
}
