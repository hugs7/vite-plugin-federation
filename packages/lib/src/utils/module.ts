export const getModuleMarker = (value: string, type?: string): string => {
  return type ? `__rf_${type}__${value}` : `__rf_placeholder__${value}`;
};
