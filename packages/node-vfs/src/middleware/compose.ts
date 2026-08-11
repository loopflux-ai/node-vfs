/** Onion middleware composition. `compose([m1,m2,m3])` → m1 outermost. Each MUST call `next()` once. */

import type { ExecutionContext, Op, Result } from '../types.ts'

export type Middleware = (
  ctx: ExecutionContext,
  op: Op,
  next: () => Promise<Result<unknown, unknown>>,
) => Promise<Result<unknown, unknown>>

export function compose(middlewares: readonly Middleware[]): Middleware {
  return (ctx, op, next) => {
    let index = -1
    const dispatch = async (i: number): Promise<Result<unknown, unknown>> => {
      if (i <= index) {
        throw new Error('next() called multiple times in middleware')
      }
      index = i
      if (i === middlewares.length)
        return await next()
      const mw = middlewares[i]!
      return await mw(ctx, op, () => dispatch(i + 1))
    }
    return dispatch(0)
  }
}
