// *****************************************************************************
// Copyright (C) 2022 Origin.js and others.
//
// This program and the accompanying materials are licensed under Mulan PSL v2.
// You can use this software according to the terms and conditions of the Mulan PSL v2.
// You may obtain a copy of Mulan PSL v2 at:
//          http://license.coscl.org.cn/MulanPSL2
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
// EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
// MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
// See the Mulan PSL v2 for more details.
//
// SPDX-License-Identifier: MulanPSL-2.0
// *****************************************************************************

import type { ConfigTypeSet, RemotesConfig } from 'types'
import type { ResolvedConfig } from 'vite'
import { Remote } from './utils'
export const EXPOSES_MAP = new Map()
export const EXPOSES_KEY_MAP = new Map()
export const PLUGIN_PREFIX = 'hugs7'
export const SHARED = 'shared'
export const DYNAMIC_LOADING_CSS = 'dynamicLoadingCss'
export const DYNAMIC_LOADING_CSS_PREFIX = '__v__css__'
export const DEFAULT_ENTRY_FILENAME = 'remoteEntry.js'
export const EXTERNALS: string[] = []
export const ROLLUP = 'rollup'
export const VITE = 'vite'

// Virtual module identifiers
export const VIRTUAL_FEDERATION = 'virtual:__federation__'
export const VIRTUAL_FEDERATION_RESOLVED = `\0${VIRTUAL_FEDERATION}`
export const VIRTUAL_FN_IMPORT = '__federation_fn_import'
export const VIRTUAL_FN_IMPORT_RESOLVED = `\0virtual:${VIRTUAL_FN_IMPORT}`
export const VIRTUAL_FN_SATISFY = '__federation_fn_satisfy'
export const REMOTE_ENTRY_HELPER_PREFIX = '__remoteEntryHelper__'

// Build-time placeholders replaced in generateBundle
export const VITE_BASE_PLACEHOLDER = '__VITE_BASE_PLACEHOLDER__'
export const VITE_ASSETS_DIR_PLACEHOLDER = '__VITE_ASSETS_DIR_PLACEHOLDER__'

// Runtime identifiers used in generated code
export const FEDERATION_EXPOSE_PREFIX = '__federation_expose_'
export const FEDERATION_SHARED_PREFIX = '__federation_shared_'

// Regex for matching CJS `exports.XXX = ...` patterns
export const CJS_EXPORTS_RE = /exports\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g

/** Serialize an array of strings into a JS array literal (e.g. `['a','b']`). */
export const toJsArrayLiteral = (items: string[]): string =>
  `[${items.map((s) => JSON.stringify(s)).join(',')}]`

export const builderInfo = {
  builder: 'rollup',
  version: '',
  assetsDir: '',
  isHost: false,
  isRemote: false,
  isShared: false
}
export const parsedOptions = {
  prodExpose: [] as (string | ConfigTypeSet)[],
  prodRemote: [] as (string | ConfigTypeSet)[],
  prodShared: [] as (string | ConfigTypeSet)[],
  devShared: [] as (string | ConfigTypeSet)[],
  devExpose: [] as (string | ConfigTypeSet)[],
  devRemote: [] as (string | ConfigTypeSet)[]
}
export const devRemotes: {
  id: string
  regexp: RegExp
  config: RemotesConfig
}[] = []
export const prodRemotes: Remote[] = []
export const viteConfigResolved: { config: ResolvedConfig | undefined } = {
  config: undefined
}
