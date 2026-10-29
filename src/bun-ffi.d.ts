declare module "bun:ffi" {
  export const FFIType: {
    readonly u32: number
    readonly u64: number
    readonly i32: number
    readonly ptr: number
  }
  export function ptr(value: ArrayBufferView): number
  export function dlopen(
    path: string,
    symbols: Record<string, { args: number[]; returns: number }>,
  ): { symbols: Record<string, (...args: unknown[]) => number> }
}
