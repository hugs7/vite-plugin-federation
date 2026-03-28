import type { RemotesConfig } from 'types';

export type Remote = {
  id: string;
  regexp: RegExp;
  config: RemotesConfig;
};
