export const PREPROCESS_SEGMENT_CONCURRENCY = 5;

export async function mapWithConcurrencyLimit(items, concurrency, mapper) {
  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  };

  await Promise.all(Array.from({ length: safeConcurrency }, () => worker()));
  return results;
}
