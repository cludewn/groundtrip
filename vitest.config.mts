import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

// アプリ本体（tsconfigのpaths）と同じ `@/` を使えるようにし、TSXを自動JSX変換でテストする。
// DOMが必要なテストは、ファイル先頭に `// @vitest-environment jsdom` を書いて切り替える。
export default defineConfig({
  // tsconfigは`jsx: preserve`（Next.jsが変換する）のため、テストでは別に変換方式を指定する。
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
})
