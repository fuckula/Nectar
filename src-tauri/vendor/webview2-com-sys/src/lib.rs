#[cfg(not(target_env = "msvc"))]
pub(crate) mod embedded_loader {
    use std::fs;
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;
    use std::sync::OnceLock;
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

    const E_FAIL_HR: i32 = -2147467259i32;

    #[cfg(target_arch = "x86_64")]
    const WEBVIEW2_LOADER_ARCH: &str = "x64";
    #[cfg(target_arch = "x86_64")]
    const WEBVIEW2_LOADER_BYTES: &[u8] = include_bytes!("../x64/WebView2Loader.dll");

    #[cfg(target_arch = "x86")]
    const WEBVIEW2_LOADER_ARCH: &str = "x86";
    #[cfg(target_arch = "x86")]
    const WEBVIEW2_LOADER_BYTES: &[u8] = include_bytes!("../x86/WebView2Loader.dll");

    #[cfg(target_arch = "aarch64")]
    const WEBVIEW2_LOADER_ARCH: &str = "arm64";
    #[cfg(target_arch = "aarch64")]
    const WEBVIEW2_LOADER_BYTES: &[u8] = include_bytes!("../arm64/WebView2Loader.dll");

    const fn fnv1a_64(bytes: &[u8]) -> u64 {
        let mut hash: u64 = 0xcbf29ce484222325;
        let mut i = 0;
        while i < bytes.len() {
            hash ^= bytes[i] as u64;
            hash = hash.wrapping_mul(0x100000001b3);
            i += 1;
        }
        hash
    }

    fn runtime_dir() -> PathBuf {
        std::env::var_os("LOCALAPPDATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("Nectar")
            .join("runtime")
    }

    fn ensure_extracted_dll() -> Result<PathBuf, i32> {
        let dir = runtime_dir();
        fs::create_dir_all(&dir).map_err(|_| E_FAIL_HR)?;

        let hash = fnv1a_64(WEBVIEW2_LOADER_BYTES);
        let file_name = format!(
            "WebView2Loader-{}-{}-{:016x}.dll",
            env!("CARGO_PKG_VERSION"),
            WEBVIEW2_LOADER_ARCH,
            hash
        );
        let dll_path = dir.join(&file_name);

        let already_valid = fs::read(&dll_path)
            .map(|existing| existing == WEBVIEW2_LOADER_BYTES)
            .unwrap_or(false);
        if already_valid {
            return Ok(dll_path);
        }

        let tmp_path = dir.join(format!("{}.{}.tmp", file_name, std::process::id()));
        fs::write(&tmp_path, WEBVIEW2_LOADER_BYTES).map_err(|_| E_FAIL_HR)?;

        if fs::rename(&tmp_path, &dll_path).is_err() {
            let _ = fs::remove_file(&tmp_path);
            let race_valid = fs::read(&dll_path)
                .map(|existing| existing == WEBVIEW2_LOADER_BYTES)
                .unwrap_or(false);
            if !race_valid {
                fs::write(&dll_path, WEBVIEW2_LOADER_BYTES).map_err(|_| E_FAIL_HR)?;
            }
        }

        Ok(dll_path)
    }

    static MODULE_HANDLE: OnceLock<Result<usize, i32>> = OnceLock::new();

    fn load_module() -> Result<usize, windows_core::HRESULT> {
        let res = MODULE_HANDLE.get_or_init(|| {
            let path = ensure_extracted_dll()?;
            let wide: Vec<u16> = path
                .as_os_str()
                .encode_wide()
                .chain(core::iter::once(0))
                .collect();
            let hmod = unsafe { LoadLibraryW(windows_core::PCWSTR(wide.as_ptr())) }
                .map_err(|_| E_FAIL_HR)?;
            if hmod.0.is_null() {
                return Err(E_FAIL_HR);
            }
            Ok(hmod.0 as usize)
        });
        res.map_err(windows_core::HRESULT)
    }

    pub(crate) unsafe fn resolve_symbol(
        name_nul: &str,
    ) -> Result<*const (), windows_core::HRESULT> {
        let addr = load_module()?;
        let hmod = HMODULE(addr as *mut core::ffi::c_void);
        match GetProcAddress(hmod, windows_core::PCSTR(name_nul.as_ptr())) {
            Some(func) => Ok(func as *const ()),
            None => Err(windows_core::HRESULT(E_FAIL_HR)),
        }
    }
}

#[allow(
    non_snake_case,
    non_upper_case_globals,
    non_camel_case_types,
    dead_code,
    clippy::all
)]
pub mod Microsoft {
    pub mod Web {
        pub mod WebView2 {
            pub mod Win32 {
                mod windows_link {
                    #[cfg(target_env = "msvc")]
                    macro_rules! link_webview2 {
                        ($library:literal $abi:literal fn $($function:tt)*) => (
                            #[link(name = "WebView2LoaderStatic", kind = "static")]
                            extern $abi {
                                pub fn $($function)*;
                            }
                        )
                    }

                    #[cfg(not(target_env = "msvc"))]
                    macro_rules! link_webview2 {
                        ($library:literal $abi:literal fn $name:ident($($arg:ident : $ty:ty),* $(,)?) -> $ret:ty) => (
                            #[allow(non_snake_case)]
                            pub unsafe fn $name($($arg: $ty),*) -> $ret {
                                let sym = match $crate::embedded_loader::resolve_symbol(concat!(
                                    stringify!($name),
                                    "\0"
                                )) {
                                    Ok(ptr) => ptr,
                                    Err(hr) => return hr,
                                };
                                let func: unsafe extern $abi fn($($ty),*) -> $ret =
                                    core::mem::transmute(sym);
                                func($($arg),*)
                            }
                        )
                    }

                    pub(crate) use link_webview2 as link;
                }

                include!("bindings.rs");
            }
        }
    }
}

pub mod declared_interfaces;

#[cfg(test)]
mod test {
    use windows_core::w;

    use crate::Microsoft::Web::WebView2::Win32::*;

    #[test]
    fn compare_eq() {
        let mut result = 1;
        unsafe { CompareBrowserVersions(w!("1.0.0"), w!("1.0.0"), &mut result) }.unwrap();
        assert_eq!(0, result);
    }

    #[test]
    fn compare_lt() {
        let mut result = 0;
        unsafe { CompareBrowserVersions(w!("1.0.0"), w!("1.0.1"), &mut result) }.unwrap();
        assert_eq!(-1, result);
    }

    #[test]
    fn compare_gt() {
        let mut result = 0;
        unsafe { CompareBrowserVersions(w!("2.0.0"), w!("1.0.1"), &mut result) }.unwrap();
        assert_eq!(1, result);
    }
}
