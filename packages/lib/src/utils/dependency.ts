import type { Rolldown } from 'vite';

export const findDependencies = (
  ctx: Rolldown.PluginContext,
  id: string,
  sets: Set<string>,
  sharedModuleIds: Map<string, string>,
  usedSharedModuleIds: Set<string>
): void => {
  if (!sets.has(id)) {
    sets.add(id);
    const moduleInfo = ctx.getModuleInfo(id);
    if (moduleInfo?.importedIds) {
      moduleInfo.importedIds.forEach((id) => {
        findDependencies(ctx, id, sets, sharedModuleIds, usedSharedModuleIds);
      });
    }
    if (sharedModuleIds.has(id)) {
      usedSharedModuleIds.add(sharedModuleIds.get(id) as string);
    }
  }
};
