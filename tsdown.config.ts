import { defineConfig } from 'tsdown'

// 构建分两段：
//   1. lib —— 宿主（Node）半身：ESM 库 + 类型声明，供 cordis.yml 插件行按包名加载。
//   2. client —— 浏览器半身：CJS bundle，产出 dsh client-modules 要求的
//      `__ModuleLoader__.load({ id, factory })` 握手格式。
// 类型检查由 `pnpm typecheck`（tsc --noEmit）负责，tsdown 只转译打包。
// `prepare` 脚本复用本配置：git 安装后 pnpm 会执行它，因此构建必须自包含、
// 不依赖任何 monorepo 上下文。

/** 宿主半边：Node 库，输出 lib/。 */
const lib = {
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  fixedExtension: false,
}

// 浏览器模块表只认识基线 externals（react、react/jsx-runtime、cordis、runtime、
// ui-slots、ui-primitives…）与本包通过 dsh.client.external 请求的 specifier。
// 其余依赖必须内联进 bundle，否则 require 会命中模块表回答不了的 specifier，
// 工厂在浏览器里直接抛错。本插件的客户端只 import react 与平台 seed 词
// ui-primitives（用于与内置卡一致的展开箭头图标）；JSX 自动运行时
// （react/jsx-runtime）也是基线 external，必须一并列出。
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']

/** 浏览器半边：输出 lib/client.js。 */
const client = {
  name: 'dsh-plugin-cost/client',
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  clean: false,
  sourcemap: true,
  external: CLIENT_EXTERNALS,
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    // 固定产物名 lib/client.js，与 package.json exports["./client"] 对应。
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-plugin-cost", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

// 数组形式：先构建 Node 库（clean），再产出 client bundle（clean 关闭，避免互相清掉）。
export default defineConfig([lib, client])
