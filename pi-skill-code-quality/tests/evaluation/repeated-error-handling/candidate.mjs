export async function runOperations(operations, run, release) {
  const results = [];
  for (const operation of operations) {
    try {
      results.push(await run(operation));
    } catch (cause) {
      throw new Error(`operation ${operation} failed`, { cause });
    } finally {
      await release(operation);
    }
  }
  return results;
}
