/**
 * Returns unique values in an array via set method.
 *
 * @param arr - Array to find unique values for.
 * @returns Unique values of array.
 */
export const uniqueArr = <T>(arr: T[]): T[] => {
  return Array.from(new Set(arr));
};
