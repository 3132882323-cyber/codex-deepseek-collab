# Vendored Undici Agent

`undici-agent.cjs` is a bundled copy of the Agent entry point from
[Undici](https://github.com/nodejs/undici), version **7.30.1**, licensed under
MIT. The bundled dependency graph includes the embedded llhttp WebAssembly
parser and parts of Undici's `lib/web/fetch` implementation. Their MIT license
notices, alongside the Undici package license, are preserved in
`undici.LICENSE`.

- npm tarball: [undici-7.30.1.tgz](https://registry.npmjs.org/undici/-/undici-7.30.1.tgz)
- Registry `dist.integrity` (SHA-512): `sha512-03KrMbjIFDWQR5RNPrSw3bd1r12JpyFQl9/yxjUbJtqkjmllqC5lFjZh6ujeuJCKr8EOQvRW872Oy/az+nLYxg==`
- Entry file: `module.exports = { Agent: require('./source-undici/package/lib/dispatcher/agent') };`
- Build command: `esbuild entry.cjs --bundle --platform=node --target=node22 --format=cjs --minify --legal-comments=none --outfile=undici-agent.cjs`
- Output SHA-256: `7968dac61bf2919a56114cc5a471fdf1c236af9e8a68e12d8cecaaf0056a8c2e`
- llhttp license: [nodejs/llhttp LICENSE](https://github.com/nodejs/llhttp/blob/main/LICENSE) (Copyright © 2018 Fedor Indutny)
- `lib/web/fetch` license: [Undici v7.30.1 source](https://github.com/nodejs/undici/blob/v7.30.1/lib/web/fetch/LICENSE) (Copyright (c) 2020 Ethan Arrowood)
- Build tool only: [`@esbuild/win32-x64` 0.25.12](https://www.npmjs.com/package/@esbuild/win32-x64), MIT licensed. Its registry `dist.integrity` (SHA-512) is `sha512-alJC0uCZpTFrSL0CCDjcgleBXPnCrEAhTBILpeAp7M/OFgoqtAetfBzX0xM00MUsVVPpVjlPuMbREqnZCXaTnA==`.

The package tarballs were checked against those integrity values before safe
extraction in an isolated build directory. The esbuild executable and source
tree are build-time inputs only; the repository includes this single portable
CommonJS bundle and the Undici license.
