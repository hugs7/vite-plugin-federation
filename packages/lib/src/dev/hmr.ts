/**
 * HMR utilities for dev-mode federation.
 *
 * Contains the @vite/client patching for absolute remote origins.
 */

export const patchViteClientCode = (
  code: string,
  remoteOrigin: string
): string => {
  code = code.replace(
    /const base = "\/"\s*\|\|\s*"\/";/,
    `const base = "${remoteOrigin}/";`
  );
  code = code.replace(
    /const base\$1 = "\/"\s*\|\|\s*"\/";/,
    `const base$1 = "${remoteOrigin}/";`
  );
  return code;
};
