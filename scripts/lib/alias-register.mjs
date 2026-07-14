// Registers the alias resolve hook via the supported --import entrypoint (module.register),
// instead of the deprecated --loader flag (DEP0189). Used by `pnpm live:crm`.
import { register } from 'node:module'

register('./alias-loader.mjs', import.meta.url)
