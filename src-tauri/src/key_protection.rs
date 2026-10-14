use std::path::Path;
use zeroize::{Zeroize, Zeroizing};

#[cfg(windows)]
fn transform(bytes: &[u8], protect: bool) -> Result<Zeroizing<Vec<u8>>, String> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len().try_into().map_err(|_| "Ogiltig nyckelfil.")?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let result = unsafe {
        if protect {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if result == 0 {
        return Err("The database key couldn't be protected or unlocked with this Windows account. Existing data has not been replaced.".into());
    }
    if output.cbData == 0 || output.pbData.is_null() {
        if !output.pbData.is_null() {
            unsafe {
                LocalFree(output.pbData.cast());
            }
        }
        return Err("Ogiltig skyddad nyckel.".into());
    }
    let value = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let copy = Zeroizing::new(value.to_vec());
    unsafe {
        std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize).zeroize();
        LocalFree(output.pbData.cast());
    }
    Ok(copy)
}

pub fn load_or_create(path: &Path, database_exists: bool) -> Result<Zeroizing<Vec<u8>>, String> {
    #[cfg(windows)]
    {
        if path.exists() {
            let protected = std::fs::read(path).map_err(|_| "Couldn't read the key file.")?;
            if protected.len() > 16_384 {
                return Err("Ogiltig nyckelfil.".into());
            }
            let key = transform(&protected, false)?;
            if key.len() != 32 {
                return Err("Ogiltig databasnyckel.".into());
            }
            return Ok(key);
        }
        if database_exists {
            return Err("The database key file is missing. Your history has not been replaced.".into());
        }
        let mut key = Zeroizing::new(vec![0u8; 32]);
        use windows_sys::Win32::Security::Cryptography::{
            BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        };
        if unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                key.as_mut_ptr(),
                32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        } < 0
        {
            return Err("Couldn't create a secure database key.".into());
        }
        let protected = transform(&key, true)?;
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|_| "Couldn't create the key file.")?;
        file.write_all(&protected)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Couldn't save the key file.")?;
        Ok(key)
    }
    #[cfg(not(windows))]
    {
        let _ = (path, database_exists);
        Err("Key protection is only available on Windows.".into())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn windows_key_survives_restart_and_is_not_replaced_when_missing() {
        let dir = std::env::temp_dir().join(format!("copyloom-key-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("key.dpapi");
        assert!(load_or_create(&path, true).is_err());
        assert!(!path.exists());
        let first = load_or_create(&path, false).unwrap();
        let second = load_or_create(&path, true).unwrap();
        assert_eq!(*first, *second);
        assert_ne!(*first, std::fs::read(&path).unwrap());
        std::fs::write(&path, b"invalid-key").unwrap();
        assert!(load_or_create(&path, true).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"invalid-key");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
