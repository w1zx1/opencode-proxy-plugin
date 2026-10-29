import type { WindowsInternetSettings } from "./detect.ts"

export type WindowsSettingsReader = () => WindowsInternetSettings

const SUBKEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"
const HKEY_CURRENT_USER = 0x80000001
const RRF_RT_REG_SZ = 0x00000002
const RRF_RT_REG_DWORD = 0x00000010
const ERROR_SUCCESS = 0

/**
 * Read the WinINET proxy values straight from advapi32.dll.
 *
 * The `reg query` fallback spawns a process (~10-30ms); this takes a few
 * microseconds, which makes it cheap enough to run before every request.
 */
export async function loadWindowsSettingsReader(): Promise<WindowsSettingsReader | undefined> {
  if (process.platform !== "win32") return undefined

  try {
    const ffi = await import("bun:ffi")
    const library = ffi.dlopen("advapi32.dll", {
      RegGetValueW: {
        args: [ffi.FFIType.u64, ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.u32, ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr],
        returns: ffi.FFIType.i32,
      },
    })
    const regGetValue = library.symbols.RegGetValueW as (
      hkey: number,
      subKey: number,
      value: number,
      flags: number,
      type: null,
      data: number,
      size: number,
    ) => number

    // Allocate the arguments for each call and take their pointers right
    // before invoking the function. Caching `ptr()` results is unsafe: the
    // backing store of a Buffer can be relocated, and a stale pointer makes
    // every read fail after the first one.
    const readString = (name: string): string | undefined => {
      const subKey = Buffer.from(`${SUBKEY}\0`, "utf16le")
      const value = Buffer.from(`${name}\0`, "utf16le")
      const data = Buffer.alloc(8192)
      const size = Buffer.alloc(4)
      size.writeUInt32LE(data.length, 0)

      const status = regGetValue(
        HKEY_CURRENT_USER,
        ffi.ptr(subKey),
        ffi.ptr(value),
        RRF_RT_REG_SZ,
        null,
        ffi.ptr(data),
        ffi.ptr(size),
      )
      if (status !== ERROR_SUCCESS) return undefined

      const used = size.readUInt32LE(0)
      const end = used >= 2 ? used - 2 : 0
      return data.subarray(0, end).toString("utf16le").replace(/\0+$/, "")
    }

    const readDword = (name: string): number | undefined => {
      const subKey = Buffer.from(`${SUBKEY}\0`, "utf16le")
      const value = Buffer.from(`${name}\0`, "utf16le")
      const data = Buffer.alloc(4)
      const size = Buffer.alloc(4)
      size.writeUInt32LE(data.length, 0)

      const status = regGetValue(
        HKEY_CURRENT_USER,
        ffi.ptr(subKey),
        ffi.ptr(value),
        RRF_RT_REG_DWORD,
        null,
        ffi.ptr(data),
        ffi.ptr(size),
      )
      return status === ERROR_SUCCESS ? data.readUInt32LE(0) : undefined
    }

    return () => ({
      ProxyEnable: readDword("ProxyEnable"),
      ProxyServer: readString("ProxyServer"),
      ProxyOverride: readString("ProxyOverride"),
      AutoConfigURL: readString("AutoConfigURL"),
    })
  } catch (error) {
    console.error("[system-proxy] system proxy detection unavailable:", error)
    return undefined
  }
}
