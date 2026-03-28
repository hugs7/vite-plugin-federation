export const uniqueArr = <T>(arr: T[]): T[] => {
  return Array.from(new Set(arr));
};
