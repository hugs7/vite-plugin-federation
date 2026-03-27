/**
 * Shared AST rewriter for remote module imports.
 *
 * Walks an AST and rewrites import/export declarations that reference
 * federated remote modules into __federation_method_getRemote() calls.
 */

import type MagicString from 'magic-string';
import { walk } from 'estree-walker';
import type { Node, Program } from 'estree';
import { VIRTUAL_FEDERATION } from '../public';

interface RemoteInfo {
  id: string;
  regexp: RegExp;
  config: { from?: string };
}

interface RewriteResult {
  requiresRuntime: boolean;
  manualRequired: any | null;
}

export const rewriteRemoteImports = (
  ast: Program,
  magicString: MagicString,
  remotes: RemoteInfo[]
): RewriteResult => {
  const hasStaticImported = new Map<string, string>();
  let requiresRuntime = false;
  let manualRequired: any = null;

  walk(ast as Node, {
    enter(node: any) {
      // Detect manual virtual:__federation__ import
      if (
        node.type === 'ImportDeclaration' &&
        node.source?.value === VIRTUAL_FEDERATION
      ) {
        manualRequired = node;
      }

      if (
        (node.type === 'ImportExpression' ||
          node.type === 'ImportDeclaration' ||
          node.type === 'ExportNamedDeclaration') &&
        node.source?.value?.indexOf('/') > -1
      ) {
        const moduleId = node.source.value;
        const remote = remotes.find((r) => r.regexp.test(moduleId));
        const needWrap = remote?.config.from === 'vite';
        if (remote) {
          requiresRuntime = true;
          const modName = `.${moduleId.slice(remote.id.length)}`;
          switch (node.type) {
            case 'ImportExpression': {
              magicString.overwrite(
                node.start,
                node.end,
                `__federation_method_getRemote(${JSON.stringify(
                  remote.id
                )} , ${JSON.stringify(
                  modName
                )}).then(module=>__federation_method_wrapDefault(module, ${needWrap}))`
              );
              break;
            }
            case 'ImportDeclaration': {
              if (node.specifiers?.length) {
                const afterImportName = `__federation_var_${moduleId.replace(
                  /[@/\\.-]/g,
                  ''
                )}`;
                if (!hasStaticImported.has(moduleId)) {
                  magicString.overwrite(
                    node.start,
                    node.end,
                    `const ${afterImportName} = await __federation_method_getRemote(${JSON.stringify(
                      remote.id
                    )} , ${JSON.stringify(modName)});`
                  );
                  hasStaticImported.set(moduleId, afterImportName);
                }
                let deconstructStr = '';
                node.specifiers.forEach((spec) => {
                  if (spec.type === 'ImportDefaultSpecifier') {
                    magicString.appendRight(
                      node.end,
                      `\n let ${spec.local.name} = __federation_method_unwrapDefault(${afterImportName}) `
                    );
                  } else if (spec.type === 'ImportSpecifier') {
                    const importedName = spec.imported.name;
                    const localName = spec.local.name;
                    deconstructStr += `${
                      importedName === localName
                        ? localName
                        : `${importedName} : ${localName}`
                    },`;
                  } else if (spec.type === 'ImportNamespaceSpecifier') {
                    magicString.appendRight(
                      node.end,
                      `let {${spec.local.name}} = ${afterImportName}`
                    );
                  }
                });
                if (deconstructStr.length > 0) {
                  magicString.appendRight(
                    node.end,
                    `\n let {${deconstructStr.slice(
                      0,
                      -1
                    )}} = ${afterImportName}`
                  );
                }
              }
              break;
            }
            case 'ExportNamedDeclaration': {
              const afterImportName = `__federation_var_${moduleId.replace(
                /[@/\\.-]/g,
                ''
              )}`;
              if (!hasStaticImported.has(moduleId)) {
                hasStaticImported.set(moduleId, afterImportName);
                magicString.overwrite(
                  node.start,
                  node.end,
                  `const ${afterImportName} = await __federation_method_getRemote(${JSON.stringify(
                    remote.id
                  )} , ${JSON.stringify(modName)});`
                );
              }
              if (node.specifiers.length > 0) {
                const specifiers = node.specifiers;
                let exportContent = '';
                let deconstructContent = '';
                specifiers.forEach((spec) => {
                  const localName = spec.local.name;
                  const exportName = spec.exported.name;
                  const variableName = `${afterImportName}_${localName}`;
                  deconstructContent = deconstructContent.concat(
                    `${localName}:${variableName},`
                  );
                  exportContent = exportContent.concat(
                    `${variableName} as ${exportName},`
                  );
                });
                magicString.append(
                  `\n const {${deconstructContent.slice(
                    0,
                    deconstructContent.length - 1
                  )}} = ${afterImportName}; \n`
                );
                magicString.append(
                  `\n export {${exportContent.slice(
                    0,
                    exportContent.length - 1
                  )}}; `
                );
              }
              break;
            }
          }
        }
      }
    }
  });

  return { requiresRuntime, manualRequired };
};

/** Build the federation runtime import preamble for transformed files. */
const buildFederationImportPreamble = (manualRequired: any | null): string => {
  if (manualRequired) {
    return `import {__federation_method_setRemote, __federation_method_ensure, __federation_method_getRemote , __federation_method_wrapDefault , __federation_method_unwrapDefault} from '__federation__';\n\n`;
  }
  return `import {__federation_method_ensure, __federation_method_getRemote , __federation_method_wrapDefault , __federation_method_unwrapDefault} from '__federation__';\n\n`;
};

/** Apply the federation runtime import preamble to a MagicString if rewriting occurred. */
export const applyFederationImportPreamble = (
  magicString: MagicString,
  result: RewriteResult
): void => {
  if (!result.requiresRuntime) return;
  const preamble = buildFederationImportPreamble(result.manualRequired);
  if (result.manualRequired) {
    magicString.overwrite(
      result.manualRequired.start,
      result.manualRequired.end,
      ''
    );
  }
  magicString.prepend(preamble);
};
